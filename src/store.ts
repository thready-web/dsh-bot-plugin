import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { ensureDir, sha256, writeAtomic } from './fs-safe.ts'

/**
 * Rows coming back from SQL strings. The statements are written as text, so the
 * column types live in the SQL, not in a generated row type.
 */
export interface SqlStatement {
  all(...params: any[]): any[]
  get(...params: any[]): any
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  columns(): Array<{ name: string }>
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

export const SCHEMA_VERSION = 5

const MIGRATION = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_versions (
  id            INTEGER PRIMARY KEY,
  content_hash  TEXT NOT NULL UNIQUE,
  byte_length   INTEGER NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL CHECK (created_by IN ('user','import')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_bindings (
  session_id              TEXT PRIMARY KEY,
  kind                    TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session','bot')),
  status                  TEXT NOT NULL CHECK (status IN
                          ('initializing','active','paused','archived','error')),
  schema_version          INTEGER NOT NULL,
  persona_version_id      INTEGER REFERENCES persona_versions(id),
  fork_parent_session_id  TEXT,
  fork_seeded             INTEGER NOT NULL DEFAULT 0 CHECK (fork_seeded IN (0,1)),
  last_view_revision      INTEGER NOT NULL DEFAULT 0,
  last_event_watermark    TEXT,
  compaction_epoch        INTEGER NOT NULL DEFAULT 0,
  error_code              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES session_bindings(session_id),
  kind             TEXT NOT NULL DEFAULT 'user_fact',
  content          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('candidate','active','superseded','forgotten')),
  source_event_id  TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN
                   ('explicit_tool','user_confirm','candidate_extract')),
  supersedes       INTEGER REFERENCES facts(id),
  revision         INTEGER NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 100,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_session_status ON facts(session_id, status);

CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES session_bindings(session_id),
  title            TEXT,
  content          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('candidate','active','superseded','forgotten')),
  source_event_id  TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN
                   ('explicit_tool','user_confirm','candidate_extract')),
  supersedes       INTEGER REFERENCES memories(id),
  revision         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_session_status ON memories(session_id, status);

CREATE TABLE IF NOT EXISTS working_state (
  session_id     TEXT PRIMARY KEY REFERENCES session_bindings(session_id),
  revision       INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_bindings (
  session_id     TEXT NOT NULL REFERENCES session_bindings(session_id),
  skill_id       TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('private','public')),
  version        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revoked        INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  bound_at       TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_id)
);

CREATE TABLE IF NOT EXISTS mutations (
  id               INTEGER PRIMARY KEY,
  scope            TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  request_json     TEXT NOT NULL,
  result_json      TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN
                   ('applied','replayed','rejected')),
  created_at       TEXT NOT NULL,
  UNIQUE (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS view_revisions (
  session_id          TEXT NOT NULL REFERENCES session_bindings(session_id),
  revision            INTEGER NOT NULL,
  frozen_at           TEXT NOT NULL,
  event_watermark     TEXT,
  persona_version_id  INTEGER,
  working_state_rev   INTEGER,
  snapshot_hash       TEXT NOT NULL,
  compaction_epoch    INTEGER NOT NULL,
  presence            TEXT NOT NULL CHECK (presence IN
                      ('present','unknown','needs_reinject')),
  selected_json       TEXT NOT NULL,
  PRIMARY KEY (session_id, revision)
);

CREATE TABLE IF NOT EXISTS export_outbox (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  mutation_id   INTEGER REFERENCES mutations(id),
  status        TEXT NOT NULL CHECK (status IN
                ('pending','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  updated_at    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  content='facts',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content,
  content='memories',
  content_rowid='id',
  tokenize='unicode61'
);
`

const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS delivery_acl (
  target_session_id  TEXT NOT NULL,
  sender_session_id  TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, sender_session_id)
);

CREATE TABLE IF NOT EXISTS delivery_block (
  target_session_id  TEXT NOT NULL,
  sender_session_id  TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, sender_session_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('message','timer','webhook')),
  idempotency_key     TEXT NOT NULL,
  sender_session_id   TEXT NOT NULL DEFAULT '',
  target_session_id   TEXT NOT NULL,
  correlation_id      TEXT NOT NULL,
  causation_id        TEXT,
  hop                 INTEGER NOT NULL,
  body                TEXT NOT NULL,
  body_hash           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'intent','flushing','accepted','claimed','started','completed',
                        'interrupted','failed','ambiguous','dead','rejected','skipped'
                      )),
  splice_seq          INTEGER,
  turn_number         INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  flush_pid           INTEGER,
  last_error          TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (kind, sender_session_id, target_session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS deliveries_target_status ON deliveries(target_session_id, status);
CREATE INDEX IF NOT EXISTS deliveries_correlation ON deliveries(correlation_id);

CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('one-shot','cron')),
  cron_expr    TEXT,
  timezone     TEXT NOT NULL,
  run_at       TEXT,
  next_due     TEXT,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0,1)),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_fires (
  occurrence_id  TEXT PRIMARY KEY,
  schedule_id    TEXT NOT NULL,
  delivery_id    TEXT,
  slot_at        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('armed','enqueued','coalesced','skipped','failed')),
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_hooks (
  id                 TEXT PRIMARY KEY,
  target_session_id  TEXT NOT NULL,
  secret             TEXT NOT NULL,
  enabled            INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at         TEXT NOT NULL,
  revoked_at         TEXT
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  hook_id      TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  delivery_id  TEXT,
  received_at  TEXT NOT NULL,
  PRIMARY KEY (hook_id, event_id)
);
`

const MIGRATION_V4 = `
CREATE TABLE IF NOT EXISTS work_tickets (
  id                         TEXT PRIMARY KEY,
  owner_session_id           TEXT NOT NULL,
  child_session_id           TEXT,
  revision                   INTEGER NOT NULL,
  briefing_revision          INTEGER NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN (
                               'accepted','enqueued','started','needs_user','ready',
                               'delivered','cancelled','failed'
                             )),
  review_status              TEXT NOT NULL CHECK (review_status IN ('none','candidate','rejected')),
  active_attempt_id          TEXT,
  briefing_hash              TEXT NOT NULL,
  correlation_id             TEXT NOT NULL DEFAULT '',
  idempotency_key            TEXT,
  parent_ticket_id           TEXT,
  budget_json                TEXT NOT NULL,
  cancel_requested_revision  INTEGER,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  UNIQUE (owner_session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS work_tickets_owner_status ON work_tickets(owner_session_id, status);

CREATE TABLE IF NOT EXISTS work_attempts (
  id                   TEXT PRIMARY KEY,
  ticket_id            TEXT NOT NULL,
  child_session_id     TEXT,
  fencing_token        INTEGER NOT NULL,
  briefing_revision    INTEGER NOT NULL,
  current_input_id     TEXT,
  status               TEXT NOT NULL CHECK (status IN (
                         'starting','enqueued','started','succeeded','failed','superseded','cancelled'
                       )),
  lease_until          TEXT,
  lease_observed_seq   INTEGER,
  started_at           TEXT,
  ended_at             TEXT
);
CREATE INDEX IF NOT EXISTS work_attempts_ticket ON work_attempts(ticket_id);
CREATE INDEX IF NOT EXISTS work_attempts_child ON work_attempts(child_session_id);

CREATE TABLE IF NOT EXISTS work_inputs (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL,
  attempt_id         TEXT NOT NULL,
  briefing_revision  INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('briefing','supply','redirect','steer','cancel_note')),
  native_message_id  TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  flush_status       TEXT NOT NULL CHECK (flush_status IN ('intent','flushing','accepted','ambiguous','dead')),
  flush_pid          INTEGER,
  flush_attempts     INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT NOT NULL DEFAULT '',
  log_seq            INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_inputs_attempt ON work_inputs(attempt_id, briefing_revision);

CREATE TABLE IF NOT EXISTS work_notices (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  owner_session_id   TEXT NOT NULL,
  native_message_id  TEXT NOT NULL,
  flush_status       TEXT NOT NULL CHECK (flush_status IN ('intent','flushing','accepted','ambiguous','dead')),
  flush_pid          INTEGER,
  flush_attempts     INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT NOT NULL DEFAULT '',
  log_seq            INTEGER,
  observe_status     TEXT NOT NULL CHECK (observe_status IN ('none','claimed','started','completed')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (ticket_id, event_id)
);
CREATE INDEX IF NOT EXISTS work_notices_owner ON work_notices(owner_session_id, flush_status);

CREATE TABLE IF NOT EXISTS work_events (
  event_id            TEXT PRIMARY KEY,
  ticket_id           TEXT NOT NULL,
  attempt_id          TEXT NOT NULL,
  fencing_token       INTEGER NOT NULL,
  briefing_revision   INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('progress','question','artifact','result','failure')),
  apply_status        TEXT NOT NULL CHECK (apply_status IN ('pending_completion','applied','stale')),
  turn_end_reason     TEXT,
  payload_hash        TEXT NOT NULL,
  notice_id           TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_events_ticket ON work_events(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS user_deliveries (
  publish_id          TEXT PRIMARY KEY,
  ticket_id           TEXT NOT NULL,
  result_event_id     TEXT NOT NULL,
  owner_session_id    TEXT NOT NULL,
  attempt_id          TEXT NOT NULL,
  fencing_token       INTEGER NOT NULL,
  briefing_revision   INTEGER NOT NULL,
  text_hash           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('intent','log_bound','abandoned')),
  assistant_seq       INTEGER,
  turn_native_id      TEXT,
  client_ack_at       TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (ticket_id, result_event_id)
);
`

/**
 * @param {string} dataDir
 */
export function openStore(dataDir: string) {
  const root = ensureDir(dataDir)
  for (const dir of [
    'blobs/persona',
    'blobs/skills',
    'src/soul',
    'src/skills/public',
    'src/skills/private',
    'export',
    'backups',
    'secrets/webhooks',
  ]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(join(root, 'persona.sqlite')) as unknown as SqlDatabase
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return new Store(db, root)
}

/**
 * SQLite cannot alter a CHECK. Databases created before steer rebuild the table.
 * @param {DatabaseSync} db
 */
function allowSteerInput(db: SqlDatabase) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_inputs'`).get() as
    | { sql?: string }
    | undefined
  const sql = row?.sql ?? ''
  if (sql === '' || sql.includes("'steer'")) return
  db.exec(`
    CREATE TABLE work_inputs_v5 (
      id                 TEXT PRIMARY KEY,
      ticket_id          TEXT NOT NULL,
      attempt_id         TEXT NOT NULL,
      briefing_revision  INTEGER NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('briefing','supply','redirect','steer','cancel_note')),
      native_message_id  TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      flush_status       TEXT NOT NULL CHECK (flush_status IN ('intent','flushing','accepted','ambiguous','dead')),
      flush_pid          INTEGER,
      flush_attempts     INTEGER NOT NULL DEFAULT 0,
      last_error         TEXT NOT NULL DEFAULT '',
      log_seq            INTEGER,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    INSERT INTO work_inputs_v5 SELECT * FROM work_inputs;
    DROP TABLE work_inputs;
    ALTER TABLE work_inputs_v5 RENAME TO work_inputs;
    CREATE INDEX IF NOT EXISTS work_inputs_attempt ON work_inputs(attempt_id, briefing_revision);
  `)
}

/**
 * @param {DatabaseSync} db
 */
function migrate(db: SqlDatabase) {
  db.exec(MIGRATION)
  db.exec(MIGRATION_V2)
  db.exec(MIGRATION_V4)
  allowSteerInput(db)
  const columns = db.prepare('PRAGMA table_info(session_bindings)').all()
  if (!columns.some(column => column.name === 'kind')) {
    db.exec(
      `ALTER TABLE session_bindings ADD COLUMN kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session','bot'))`,
    )
  }
  for (let version = 1; version <= SCHEMA_VERSION; version++) {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)
    if (!row) db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, now())
  }
}

function now() {
  return new Date().toISOString()
}

class KeyedLock {
  tails: Map<string, Promise<void>>

  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map()
  }

  /**
   * @param {string} key
   * @param {() => unknown} fn
   * @param {number} timeoutMs
   */
  async run(key: string, fn: () => unknown, timeoutMs: number) {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>(resolve => {
      release = () => resolve()
    })
    this.tails.set(key, current)
    let timer
    const acquired = await Promise.race([
      prev.then(() => 'ok'),
      new Promise(resolve => {
        timer = setTimeout(() => resolve('busy'), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (acquired !== 'ok') {
      prev.then(() => release())
      const error = Object.assign(new Error('BUSY'), { code: 'BUSY' })
      throw error
    }
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === current) this.tails.delete(key)
    }
  }
}

export class Store {
  db: SqlDatabase
  root: string
  lock: any
  busyTimeoutMs: any

  /**
   * @param {SqlDatabase} db
   * @param {string} root
   */
  constructor(db: SqlDatabase, root: string) {
    this.db = db
    this.root = root
    this.lock = new KeyedLock()
    this.busyTimeoutMs = 5000
  }

  close() {
    this.db.close()
  }

  /**
   * @param {string} scope
   * @param {() => unknown} fn
   */
  async write(scope: string, fn: () => unknown) {
    return this.lock.run(
      scope,
      () => {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const value = fn()
          this.db.exec('COMMIT')
          return value
        } catch (error) {
          try {
            this.db.exec('ROLLBACK')
          } catch {
            /* already closed */
          }
          throw error
        }
      },
      this.busyTimeoutMs,
    )
  }

  /**
   * @param {() => unknown} fn
   */
  read(fn: () => unknown) {
    this.db.exec('BEGIN')
    try {
      return fn()
    } finally {
      this.db.exec('ROLLBACK')
    }
  }

  /**
   * @param {string} kind
   * @param {string} hash
   * @param {Buffer | string} bytes
   */
  writeBlob(kind: string, hash: string, bytes: Buffer | string) {
    const dir = join(this.root, 'blobs', kind === 'persona' ? 'persona' : join('skills', hash))
    if (kind === 'persona') {
      const file = join(this.root, 'blobs', 'persona', `${hash}.md`)
      if (!existsSync(file)) writeAtomic(file, bytes)
      return file
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) writeAtomic(file, bytes)
    return file
  }

  /**
   * @param {'persona' | 'skill'} kind
   * @param {string} hash
   */
  readBlob(kind: 'persona' | 'skill', hash: string) {
    const file =
      kind === 'persona'
        ? join(this.root, 'blobs', 'persona', `${hash}.md`)
        : join(this.root, 'blobs', 'skills', hash, 'SKILL.md')
    if (!existsSync(file)) return null
    return readFileSync(file)
  }

  /**
   * Consistent snapshot. Callers must not copy persona.sqlite* while this
   * connection is open and pretend that copy is consistent.
   * @param {string} destDir
   */
  async backupTo(destDir: string) {
    mkdirSync(destDir, { recursive: true, mode: 0o700 })
    const dbFile = join(destDir, 'persona.sqlite')
    await backup(this.db as unknown as DatabaseSync, dbFile, { rate: 1 })
    const copied = []
    const personas = this.db.prepare('SELECT content_hash FROM persona_versions').all()
    for (const row of personas) {
      const bytes = this.readBlob('persona', row.content_hash)
      if (!bytes) continue
      const target = join(destDir, 'blobs', 'persona', `${row.content_hash}.md`)
      mkdirSync(join(destDir, 'blobs', 'persona'), { recursive: true, mode: 0o700 })
      writeAtomic(target, bytes)
      copied.push({ kind: 'persona', hash: row.content_hash, sha256: sha256(bytes) })
    }
    const skills = this.db.prepare('SELECT DISTINCT content_hash FROM skill_bindings').all()
    for (const row of skills) {
      const bytes = this.readBlob('skill', row.content_hash)
      if (!bytes) continue
      const target = join(destDir, 'blobs', 'skills', row.content_hash, 'SKILL.md')
      mkdirSync(join(destDir, 'blobs', 'skills', row.content_hash), { recursive: true, mode: 0o700 })
      writeAtomic(target, bytes)
      copied.push({ kind: 'skill', hash: row.content_hash, sha256: sha256(bytes) })
    }
    const manifest = {
      createdAt: now(),
      schemaVersion: SCHEMA_VERSION,
      method: 'node:sqlite backup()',
      files: copied,
    }
    writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    return manifest
  }
}

export { now }

/**
 * Replace a stopped store directory from a backup produced by backupTo.
 * Refuses when ownerPid is still running. Does not copy sqlite WAL files.
 * @param {string} dataDir
 * @param {string} backupDir
 * @param {number | null} ownerPid
 */
export async function restoreBackup(dataDir: string, backupDir: string, ownerPid: number | null) {
  if (ownerPid != null && pidAlive(ownerPid)) {
    throw Object.assign(new Error('profile store is open; stop dsh before restore'), { code: 'BUSY' })
  }
  const snapshot = join(backupDir, 'persona.sqlite')
  if (!existsSync(snapshot)) throw new Error('backup has no persona.sqlite')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const source = new DatabaseSync(snapshot, { readOnly: true })
  const staging = join(dataDir, `persona.restore-${Date.now()}.sqlite`)
  try {
    await backup(source, staging)
  } finally {
    source.close()
  }
  const next = join(dataDir, 'persona.sqlite.next')
  writeAtomic(next, readFileSync(staging))
  rmSync(staging, { force: true })
  for (const suffix of ['-wal', '-shm']) rmSync(join(dataDir, `persona.sqlite${suffix}`), { force: true })
  renameSync(next, join(dataDir, 'persona.sqlite'))
  const blobRoot = join(backupDir, 'blobs')
  if (existsSync(blobRoot)) copyTree(blobRoot, join(dataDir, 'blobs'))
}

/**
 * @param {number} pid
 */
export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function copyTree(from: string, to: string) {
  mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, name.name)
    const dest = join(to, name.name)
    if (name.isDirectory()) copyTree(src, dest)
    else writeAtomic(dest, readFileSync(src))
  }
}
