import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { asStoreFailure, toolError, type ToolPayload } from './errors.ts'
import { sha256 } from './fs-safe.ts'
import type { SqlDatabase } from './store.ts'

/** Hard caps from the canvas plan. Adjusting them still has to keep a ceiling. */
export const CANVAS_MAX_FILE_BYTES = Math.floor(1.5 * 1024 * 1024)
export const CANVAS_MAX_PACKAGE_BYTES = 8 * 1024 * 1024
export const CANVAS_MAX_FILES = 64
export const CANVAS_KEEP_REVISIONS = 20
export const CANVAS_TOKEN_TTL_MS = 15 * 60 * 1000
export const CANVAS_MAX_JSON_BYTES = 12 * 1024 * 1024

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const CANVAS_ID = /^cnv_[A-Za-z0-9_-]{16}$/

const TYPES = new Map<string, string[]>([
  ['text/html', ['.html', '.htm']],
  ['text/css', ['.css']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['font/woff', ['.woff']],
  ['font/woff2', ['.woff2']],
  ['font/ttf', ['.ttf']],
  ['font/otf', ['.otf']],
])

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS canvases (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  ticket_id         TEXT,
  title             TEXT NOT NULL DEFAULT '',
  stable_revision   INTEGER,
  preview_revision  INTEGER,
  fence_generation  INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canvases_session ON canvases(session_id, created_at);

CREATE TABLE IF NOT EXISTS canvas_revisions (
  canvas_id   TEXT NOT NULL REFERENCES canvases(id),
  revision    INTEGER NOT NULL,
  parent      INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('snapshot','delta','failed')),
  entry       TEXT,
  status      TEXT NOT NULL CHECK (status IN ('preview','stable','failed')),
  hash        TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (canvas_id, revision)
);

CREATE TABLE IF NOT EXISTS canvas_blobs (
  hash   TEXT PRIMARY KEY,
  bytes  BLOB NOT NULL,
  size   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_files (
  canvas_id   TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, revision, path),
  FOREIGN KEY (canvas_id, revision) REFERENCES canvas_revisions(canvas_id, revision)
);

CREATE TABLE IF NOT EXISTS canvas_tokens (
  id            TEXT PRIMARY KEY,
  canvas_id     TEXT NOT NULL REFERENCES canvases(id),
  token_hash    TEXT NOT NULL UNIQUE,
  min_revision  INTEGER NOT NULL,
  max_revision  INTEGER NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE TABLE IF NOT EXISTS canvas_drafts (
  canvas_id   TEXT NOT NULL,
  path        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (canvas_id, path)
);

CREATE TABLE IF NOT EXISTS canvas_ticket_publishes (
  ticket_id  TEXT PRIMARY KEY,
  canvas_id  TEXT NOT NULL,
  revision   INTEGER NOT NULL
);
`

export interface CanvasFileInput {
  path: string
  type: string
  bytes: Buffer
}

export interface CanvasManifestItem {
  path: string
  hash: string
  bytes: number
  type: string
}

interface PreviewRead {
  path: string
  type: string
  bytes: number
  text?: string
}

interface CanvasNotice {
  sessionId: string
  wire: {
    type: 'canvas.revision'
    canvasId: string
    revision: number
    baseRevision: number | null
    kind: 'snapshot' | 'delta'
    stamp: string
  }
}

/**
 * Relative canvas path. Rejects traversal, absolute paths, encoding, and dotfiles.
 * The media route checks the raw URL before this runs.
 */
export function normalizeCanvasPath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return null
  if (input.includes('\0') || input.includes('\\') || input.includes('%') || input.includes('..')) return null
  if (input.startsWith('/')) return null
  const parts = input.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.startsWith('.') || part.length > 120))
    return null
  return parts.join('/')
}

function nowIso() {
  return new Date().toISOString()
}

function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function rasterOk(type: string, bytes: Buffer) {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/png')
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (type === 'image/gif') return bytes.length >= 6 && /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
  if (type === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  return true
}

/** Auxiliary check. The sandbox and CSP stay in force even if this misses something. */
function activeContent(type: string, bytes: Buffer): string | null {
  if (type.startsWith('font/')) {
    const head = bytes.subarray(0, 64).toString('utf8').trimStart()
    if (head.startsWith('<')) return 'Font files cannot be markup.'
    return null
  }
  if (type !== 'text/html' && type !== 'text/css') return null
  const text = bytes.toString('utf8')
  const lower = text.toLowerCase()
  if (
    lower.includes('<script') ||
    lower.includes('javascript:') ||
    lower.includes('data:') ||
    lower.includes('<svg') ||
    lower.includes('<base') ||
    lower.includes('<iframe') ||
    lower.includes('<object') ||
    lower.includes('<embed') ||
    lower.includes('<meta')
  )
    return 'Canvas documents cannot include scripts, SVG, or document controls.'
  if (/https?:\/\//i.test(text) || text.includes('//') || /url\(\s*['"]?\s*(?:[a-z]+:|\/\/)/i.test(text))
    return 'Canvas documents cannot reference external URLs.'
  if (type === 'text/css' && /@import/i.test(text)) return 'Canvas stylesheets cannot use @import.'
  return null
}

function shorterThanCurrent(file: { path: string; type: string; bytes: Buffer }, previous: number | null) {
  if (file.type.toLowerCase() !== 'text/html') return null
  if (previous == null || previous < 1) return null
  if (file.bytes.length * 2 >= previous) return null
  return `${file.path} is much shorter than the current revision (${file.bytes.length} bytes vs ${previous}).`
}

function stageProblem(file: CanvasFileInput): string | null {
  const path = normalizeCanvasPath(file?.path)
  if (!path) return 'A canvas path is not allowed.'
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : ''
  const extensions = TYPES.get(type)
  if (!extensions || !extensions.includes(extensionOf(path))) return `File type is not allowed for ${path}.`
  if (!Buffer.isBuffer(file.bytes)) return `Missing bytes for ${path}.`
  if (file.bytes.length > CANVAS_MAX_FILE_BYTES) return `${path} exceeds the 1.5 MiB file cap.`
  if (!rasterOk(type, file.bytes)) return `${path} does not match its image type.`
  const active = activeContent(type, file.bytes)
  if (active) return active
  if (type === 'text/html' && !/<\/html\s*>/i.test(file.bytes.toString('utf8')))
    return `${path} is incomplete HTML. It needs a closing </html> tag.`
  return null
}

function checkFiles(entry: string, files: CanvasFileInput[]): ToolPayload | CanvasManifestItem[] {
  const entryPath = normalizeCanvasPath(entry)
  if (!entryPath) return toolError('VALIDATION', 'entry path is not allowed.')
  if (!Array.isArray(files) || files.length === 0 || files.length > CANVAS_MAX_FILES)
    return toolError('VALIDATION', 'A canvas revision needs between 1 and 64 files.')
  const seen = new Set<string>()
  const manifest: CanvasManifestItem[] = []
  let total = 0
  for (const file of files) {
    const problem = stageProblem(file)
    if (problem) return toolError('VALIDATION', problem)
    const path = normalizeCanvasPath(file.path)
    if (!path || seen.has(path)) return toolError('VALIDATION', `Duplicate canvas path ${path ?? ''}.`)
    seen.add(path)
    const type = file.type.toLowerCase()
    total += file.bytes.length
    if (total > CANVAS_MAX_PACKAGE_BYTES) return toolError('VALIDATION', 'The canvas package exceeds 8 MiB.')
    manifest.push({ path, hash: `sha256:${sha256(file.bytes)}`, bytes: file.bytes.length, type })
  }
  if (!manifest.some(item => item.path === entryPath && item.type === 'text/html'))
    return toolError('VALIDATION', 'entry must be an HTML file in this revision.')
  if ((files.find(file => normalizeCanvasPath(file.path) === entryPath)?.bytes.length ?? 0) === 0)
    return toolError('VALIDATION', 'entry HTML is empty.')
  return manifest
}

function manifestHash(items: CanvasManifestItem[]) {
  const ordered = [...items].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256(JSON.stringify(ordered))
}

function migrateCanvas(db: SqlDatabase) {
  const columns = db.prepare('PRAGMA table_info(canvases)').all()
  if (!columns.some(column => column.name === 'idempotency_key')) {
    db.exec('ALTER TABLE canvases ADD COLUMN idempotency_key TEXT')
  }
  if (!columns.some(column => column.name === 'writer_ticket_id')) {
    db.exec('ALTER TABLE canvases ADD COLUMN writer_ticket_id TEXT')
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS canvas_idempotency ON canvases(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
  )
}

/**
 * Canvas metadata, staged drafts, and deduplicated blobs.
 * Manual HTTP publish and the canvas worker both write here.
 * @param {string} file
 */
export function openCanvasStore(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file) as unknown as SqlDatabase
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  migrateCanvas(db)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* the directory mode still limits it */
  }
  const store = new CanvasStore(db)
  store.seed()
  return store
}

export class CanvasStore {
  db: SqlDatabase
  tails: Map<string, Promise<unknown>>
  notices: Map<string, CanvasNotice>

  constructor(db: SqlDatabase) {
    this.db = db
    this.tails = new Map()
    this.notices = new Map()
  }

  close() {
    this.db.close()
  }

  /** Latest renderable revision per canvas, so a restarted process can still notify. */
  seed() {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, preview_revision, fence_generation
         FROM canvases WHERE preview_revision IS NOT NULL`,
      )
      .all()
    for (const row of rows) {
      const revision = this.db
        .prepare(`SELECT revision, parent, kind, status FROM canvas_revisions WHERE canvas_id = ? AND revision = ?`)
        .get(row.id, row.preview_revision)
      if (!revision || revision.status === 'failed' || revision.kind === 'failed') continue
      this.remember(row.session_id, row.id, revision, row.fence_generation)
    }
  }

  /** Compact notices for one session. Bodies stay on the media route. */
  live(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) return { ok: true as const, events: [] }
    const rows = this.db
      .prepare(
        `SELECT c.id AS canvas_id, c.fence_generation, r.revision, r.parent, r.kind
         FROM canvases c
         JOIN canvas_revisions r ON r.canvas_id = c.id AND r.revision = c.preview_revision
         WHERE c.session_id = ? AND r.kind IN ('snapshot', 'delta') AND r.status != 'failed'
         ORDER BY c.id ASC`,
      )
      .all(sessionId)
    return {
      ok: true as const,
      events: rows.map(row => ({
        type: 'canvas.revision' as const,
        canvasId: String(row.canvas_id),
        revision: Number(row.revision),
        baseRevision: row.parent == null ? null : Number(row.parent),
        kind: row.kind as 'snapshot' | 'delta',
        stamp: `${row.canvas_id}:${row.revision}:${row.fence_generation}`,
      })),
    }
  }

  create(input: {
    sessionId?: unknown
    title?: unknown
    ticketId?: unknown
    createdBy?: string
    idempotencyKey?: string | null
  }) {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId))
      return toolError('VALIDATION', 'sessionId is not allowed.')
    if (input.title != null && typeof input.title !== 'string') return toolError('VALIDATION', 'title is not allowed.')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title.length > 120) return toolError('VALIDATION', 'title is too long.')
    const ticketId = input.ticketId ?? null
    if (ticketId != null && (typeof ticketId !== 'string' || ticketId.length > 80))
      return toolError('VALIDATION', 'ticketId is not allowed.')
    const idempotencyKey = input.idempotencyKey ?? null
    if (idempotencyKey != null && (idempotencyKey.length < 8 || idempotencyKey.length > 128))
      return toolError('VALIDATION', 'idempotencyKey is not allowed.')
    if (idempotencyKey) {
      const existing = this.findIdempotent(input.sessionId, idempotencyKey)
      if (existing) return { ok: true as const, canvas: this.canvasRow(existing) }
    }
    const id = `cnv_${randomBytes(12).toString('base64url')}`
    const createdAt = nowIso()
    try {
      this.db
        .prepare(
          `INSERT INTO canvases (
             id, session_id, ticket_id, title, stable_revision, preview_revision, fence_generation, created_by, created_at, idempotency_key
           ) VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
        )
        .run(id, input.sessionId, ticketId, title, input.createdBy ?? 'user', createdAt, idempotencyKey)
    } catch (error) {
      if (idempotencyKey) {
        const existing = this.findIdempotent(input.sessionId, idempotencyKey)
        if (existing) return { ok: true as const, canvas: this.canvasRow(existing) }
      }
      return asStoreFailure(error)
    }
    return { ok: true as const, canvas: this.canvasRow(id) }
  }

  findIdempotent(sessionId: string, key: string) {
    const row = this.db
      .prepare('SELECT id FROM canvases WHERE session_id = ? AND idempotency_key = ?')
      .get(sessionId, key)
    return typeof row?.id === 'string' ? row.id : null
  }

  attachTicket(canvasId: string, ticketId: string) {
    if (!CANVAS_ID.test(canvasId) || ticketId.length < 1 || ticketId.length > 80) return
    this.db
      .prepare('UPDATE canvases SET ticket_id = ? WHERE id = ? AND (ticket_id IS NULL OR ticket_id = ?)')
      .run(ticketId, canvasId, ticketId)
  }

  canvasIdForTicket(ticketId: string | null) {
    if (!ticketId || ticketId.length > 80) return null
    const row = this.db
      .prepare('SELECT id FROM canvases WHERE ticket_id = ? OR writer_ticket_id = ?')
      .get(ticketId, ticketId)
    return typeof row?.id === 'string' ? row.id : null
  }

  /** The session that opened this preview. A follow-up ticket does not move the card. */
  ownedBy(sessionId: string, canvasId: string) {
    if (!CANVAS_ID.test(canvasId)) return false
    const row = this.db.prepare('SELECT session_id FROM canvases WHERE id = ?').get(canvasId)
    return row?.session_id === sessionId
  }

  attachWriter(canvasId: string, ticketId: string) {
    if (!CANVAS_ID.test(canvasId) || ticketId.length < 1 || ticketId.length > 80) return
    this.db.prepare('UPDATE canvases SET writer_ticket_id = ? WHERE id = ?').run(ticketId, canvasId)
  }

  writeDraft(canvasId: string, files: CanvasFileInput[], remove: string[] = []) {
    if (!CANVAS_ID.test(canvasId)) return Promise.resolve(toolError('NOT_FOUND', 'No such canvas.'))
    return this.locked(canvasId, () => {
      const canvas = this.rawCanvas(canvasId)
      if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
      const staged: { path: string; type: string; bytes: Buffer }[] = []
      const seen = new Set<string>()
      for (const file of files) {
        const problem = stageProblem(file)
        if (problem) return toolError('VALIDATION', problem)
        const path = normalizeCanvasPath(file.path)
        if (!path || seen.has(path)) return toolError('VALIDATION', `Duplicate canvas path ${path ?? ''}.`)
        seen.add(path)
        const previous = this.fileSizeAt(
          canvasId,
          canvas.preview_revision == null ? null : Number(canvas.preview_revision),
          path,
        )
        const short = shorterThanCurrent({ path, type: file.type, bytes: file.bytes }, previous)
        if (short) return toolError('VALIDATION', short)
        staged.push({ path, type: file.type.toLowerCase(), bytes: file.bytes })
      }
      const dropping: string[] = []
      for (const item of remove) {
        const path = normalizeCanvasPath(item)
        if (!path) return toolError('VALIDATION', 'A canvas path is not allowed.')
        dropping.push(path)
      }
      const existing = this.db
        .prepare('SELECT path, length(bytes) AS size FROM canvas_drafts WHERE canvas_id = ?')
        .all(canvasId)
      const next = new Map(existing.map(row => [String(row.path), Number(row.size)]))
      for (const path of dropping) next.delete(path)
      for (const file of staged) next.set(file.path, file.bytes.length)
      if (next.size > CANVAS_MAX_FILES)
        return toolError('VALIDATION', 'A canvas revision needs between 1 and 64 files.')
      let total = 0
      for (const size of next.values()) total += size
      if (total > CANVAS_MAX_PACKAGE_BYTES) return toolError('VALIDATION', 'The canvas package exceeds 8 MiB.')
      const updatedAt = nowIso()
      this.transaction(() => {
        const del = this.db.prepare('DELETE FROM canvas_drafts WHERE canvas_id = ? AND path = ?')
        for (const path of dropping) del.run(canvasId, path)
        const upsert = this.db.prepare(
          `INSERT INTO canvas_drafts (canvas_id, path, media_type, bytes, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(canvas_id, path) DO UPDATE SET
             media_type = excluded.media_type,
             bytes = excluded.bytes,
             updated_at = excluded.updated_at`,
        )
        for (const file of staged) upsert.run(canvasId, file.path, file.type, file.bytes, updatedAt)
      })
      return { ok: true as const, files: [...next.keys()].sort() }
    })
  }

  publishDraft(canvasId: string, ticketId?: string | null) {
    if (!CANVAS_ID.test(canvasId)) return Promise.resolve(toolError('NOT_FOUND', 'No such canvas.'))
    return this.locked(canvasId, () => {
      try {
        const canvas = this.rawCanvas(canvasId)
        if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
        if (typeof ticketId === 'string' && ticketId !== '') {
          if (ticketId.length > 80) return toolError('VALIDATION', 'ticket id is not allowed.')
          const prior = this.db
            .prepare('SELECT ticket_id FROM canvas_ticket_publishes WHERE ticket_id = ?')
            .get(ticketId)
          if (prior)
            return toolError(
              'VALIDATION',
              'This ticket already published. Call canvas_publish once, after every file is staged.',
            )
        }
        const rows = this.db
          .prepare('SELECT path, media_type, bytes FROM canvas_drafts WHERE canvas_id = ? ORDER BY path ASC')
          .all(canvasId)
        const files = rows.map(row => ({
          path: String(row.path),
          type: String(row.media_type),
          bytes: Buffer.from(row.bytes as Uint8Array),
        }))
        const preview = canvas.preview_revision == null ? null : Number(canvas.preview_revision)
        const published = this.publishLocked({
          canvasId,
          kind: preview == null ? 'snapshot' : 'delta',
          baseRevision: preview,
          entry: 'index.html',
          expectedFence: Number(canvas.fence_generation),
          files,
        })
        if (published.ok === true && typeof ticketId === 'string' && ticketId !== '') {
          this.db
            .prepare('INSERT INTO canvas_ticket_publishes (ticket_id, canvas_id, revision) VALUES (?, ?, ?)')
            .run(ticketId, canvasId, published.revision)
        }
        return published
      } catch (error) {
        return asStoreFailure(error)
      }
    })
  }

  list(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) return toolError('VALIDATION', 'sessionId is not allowed.')
    const rows = this.db
      .prepare(`SELECT id FROM canvases WHERE session_id = ? ORDER BY created_at ASC, id ASC`)
      .all(sessionId)
    return { ok: true as const, canvases: rows.map(row => this.canvasRow(row.id)) }
  }

  get(canvasId: string) {
    if (!CANVAS_ID.test(canvasId)) return toolError('NOT_FOUND', 'No such canvas.')
    const canvas = this.canvasRow(canvasId)
    if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
    const revisions = this.db
      .prepare(
        `SELECT revision, parent, kind, entry, status, hash, error, created_at
         FROM canvas_revisions WHERE canvas_id = ? ORDER BY revision ASC`,
      )
      .all(canvasId)
      .map(row => ({
        revision: row.revision,
        parent: row.parent,
        kind: row.kind,
        entry: row.entry,
        status: row.status,
        hash: row.hash ? `sha256:${row.hash}` : null,
        error: row.error,
        createdAt: row.created_at,
      }))
    return { ok: true as const, canvas, revisions }
  }

  manifest(canvasId: string, revision: number) {
    const found = this.revisionFiles(canvasId, revision)
    if (found.ok === false) return found
    return {
      ok: true as const,
      kind: found.kind,
      revision: found.revision,
      baseRevision: found.parent,
      entry: found.entry,
      manifest: found.manifest,
    }
  }

  publish(input: {
    canvasId: string
    kind: 'snapshot' | 'delta'
    baseRevision?: number | null
    entry: string
    expectedFence: number
    files: CanvasFileInput[]
  }) {
    return this.locked(input.canvasId, () => {
      try {
        return this.publishLocked(input)
      } catch (error) {
        return asStoreFailure(error)
      }
    })
  }

  fail(input: { canvasId: string; expectedFence: number; message: string }) {
    return this.locked(input.canvasId, () => {
      const canvas = this.rawCanvas(input.canvasId)
      if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
      if (Number(canvas.fence_generation) !== input.expectedFence)
        return toolError('CAS_CONFLICT', 'The canvas fence changed.')
      const message = input.message.trim()
      if (message === '' || message.length > 500) return toolError('VALIDATION', 'failure message is required.')
      const revision = this.nextRevision(input.canvasId)
      const createdAt = nowIso()
      this.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO canvas_revisions (
               canvas_id, revision, parent, kind, entry, status, hash, error, created_at
             ) VALUES (?, ?, ?, 'failed', NULL, 'failed', NULL, ?, ?)`,
          )
          .run(input.canvasId, revision, canvas.preview_revision, message, createdAt)
        this.db
          .prepare('UPDATE canvases SET fence_generation = ? WHERE id = ?')
          .run(input.expectedFence + 1, input.canvasId)
        this.prune(input.canvasId, createdAt)
      })
      return { ok: true as const, revision, fence: input.expectedFence + 1, canvas: this.canvasRow(input.canvasId) }
    })
  }

  adopt(input: { canvasId: string; revision: number }) {
    return this.locked(input.canvasId, () => {
      const canvas = this.rawCanvas(input.canvasId)
      if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
      const revision = this.db
        .prepare('SELECT status FROM canvas_revisions WHERE canvas_id = ? AND revision = ?')
        .get(input.canvasId, input.revision)
      if (!revision) return toolError('NOT_FOUND', 'No such revision.')
      if (revision.status === 'failed') return toolError('VALIDATION', 'A failed revision cannot be adopted.')
      this.db.prepare('UPDATE canvases SET stable_revision = ? WHERE id = ?').run(input.revision, input.canvasId)
      this.db
        .prepare(`UPDATE canvas_revisions SET status = 'preview' WHERE canvas_id = ? AND status = 'stable'`)
        .run(input.canvasId)
      this.db
        .prepare(`UPDATE canvas_revisions SET status = 'stable' WHERE canvas_id = ? AND revision = ?`)
        .run(input.canvasId, input.revision)
      return { ok: true as const, stableRevision: input.revision, canvas: this.canvasRow(input.canvasId) }
    })
  }

  mint(input: { canvasId: string; minRevision: number; maxRevision: number; ttlMs?: number }) {
    const canvas = this.rawCanvas(input.canvasId)
    if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
    if (
      !Number.isInteger(input.minRevision) ||
      !Number.isInteger(input.maxRevision) ||
      input.minRevision < 1 ||
      input.maxRevision < input.minRevision
    )
      return toolError('VALIDATION', 'revision range is not allowed.')
    const known = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM canvas_revisions
         WHERE canvas_id = ? AND revision BETWEEN ? AND ? AND status != 'failed'`,
      )
      .get(input.canvasId, input.minRevision, input.maxRevision).n
    if (Number(known) < 1) return toolError('NOT_FOUND', 'No renderable revision in that range.')
    const token = randomBytes(24).toString('base64url')
    const tokenId = `ctok_${randomBytes(9).toString('base64url')}`
    const ttl = input.ttlMs ?? CANVAS_TOKEN_TTL_MS
    if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > CANVAS_TOKEN_TTL_MS)
      return toolError('VALIDATION', 'token ttl is not allowed.')
    const expiresAt = new Date(Date.now() + ttl).toISOString()
    this.db
      .prepare(
        `INSERT INTO canvas_tokens (id, canvas_id, token_hash, min_revision, max_revision, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(tokenId, input.canvasId, sha256(token), input.minRevision, input.maxRevision, expiresAt)
    return {
      ok: true as const,
      token,
      tokenId,
      expiresAt,
      minRevision: input.minRevision,
      maxRevision: input.maxRevision,
    }
  }

  revoke(input: { canvasId: string; tokenId: string }) {
    if (!CANVAS_ID.test(input.canvasId)) return toolError('NOT_FOUND', 'No such canvas.')
    const result = this.db
      .prepare(`UPDATE canvas_tokens SET revoked_at = ? WHERE id = ? AND canvas_id = ? AND revoked_at IS NULL`)
      .run(nowIso(), input.tokenId, input.canvasId)
    if (Number(result.changes) < 1) return toolError('NOT_FOUND', 'No such token.')
    return { ok: true as const }
  }

  /**
   * Capability-token read. Callers must not consult the login cookie.
   */
  readMedia(input: { token: string; revision: number; path: string }) {
    const path = normalizeCanvasPath(input.path)
    if (!path || !/^[A-Za-z0-9_-]{20,128}$/.test(input.token))
      return toolError('VALIDATION', 'canvas media path is not allowed.')
    const token = this.db
      .prepare(
        `SELECT canvas_id, min_revision, max_revision, expires_at, revoked_at
         FROM canvas_tokens WHERE token_hash = ?`,
      )
      .get(sha256(input.token))
    if (!token || token.revoked_at || token.expires_at <= nowIso())
      return toolError('FORBIDDEN', 'canvas media token is not valid.')
    if (input.revision < token.min_revision || input.revision > token.max_revision)
      return toolError('FORBIDDEN', 'canvas media token is not valid.')
    const file = this.db
      .prepare(
        `SELECT f.media_type, b.bytes, b.size
         FROM canvas_files f
         JOIN canvas_blobs b ON b.hash = f.hash
         WHERE f.canvas_id = ? AND f.revision = ? AND f.path = ?`,
      )
      .get(token.canvas_id, input.revision, path)
    if (!file) return toolError('NOT_FOUND', 'No such canvas file.')
    const bytes = Buffer.from(file.bytes)
    if (bytes.length !== file.size || !rasterOk(file.media_type, bytes))
      return toolError('NOT_FOUND', 'No such canvas file.')
    return { ok: true as const, type: file.media_type as string, bytes, canvasId: token.canvas_id as string }
  }

  publishLocked(input: {
    canvasId: string
    kind: 'snapshot' | 'delta'
    baseRevision?: number | null
    entry: string
    expectedFence: number
    files: CanvasFileInput[]
  }): ToolPayload {
    if (input.kind !== 'snapshot' && input.kind !== 'delta')
      return toolError('VALIDATION', 'kind must be snapshot or delta.')
    if (!Number.isInteger(input.expectedFence) || input.expectedFence < 0)
      return toolError('VALIDATION', 'expectedFence is required.')
    const canvas = this.rawCanvas(input.canvasId)
    if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
    if (Number(canvas.fence_generation) !== input.expectedFence)
      return toolError('CAS_CONFLICT', 'The canvas fence changed.')
    const checked = checkFiles(input.entry, input.files)
    if (!Array.isArray(checked)) return checked
    const entry = normalizeCanvasPath(input.entry)
    if (!entry) return toolError('VALIDATION', 'entry path is not allowed.')
    let parent: number | null = null
    if (input.kind === 'delta') {
      if (canvas.preview_revision == null) return toolError('VALIDATION', 'A delta needs a snapshot first.')
      if (Number(canvas.preview_revision) !== input.baseRevision)
        return toolError('CAS_CONFLICT', 'baseRevision is not the current preview.')
      parent = Number(canvas.preview_revision)
    }
    for (const file of input.files) {
      const path = normalizeCanvasPath(file.path)
      if (!path) continue
      const previous = parent == null ? null : this.fileSizeAt(input.canvasId, parent, path)
      const short = shorterThanCurrent(file, previous)
      if (short) return toolError('VALIDATION', short)
    }
    const revision = this.nextRevision(input.canvasId)
    const createdAt = nowIso()
    const hash = manifestHash(checked)
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO canvas_revisions (
             canvas_id, revision, parent, kind, entry, status, hash, error, created_at
           ) VALUES (?, ?, ?, ?, ?, 'preview', ?, NULL, ?)`,
        )
        .run(input.canvasId, revision, parent, input.kind, entry, hash, createdAt)
      const insertBlob = this.db.prepare(
        'INSERT INTO canvas_blobs (hash, bytes, size) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      )
      const insertFile = this.db.prepare(
        `INSERT INTO canvas_files (canvas_id, revision, path, hash, media_type, size)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const file of input.files) {
        const path = normalizeCanvasPath(file.path)
        const item = checked.find(candidate => candidate.path === path)
        if (!path || !item) throw new Error('manifest drifted')
        const digest = item.hash.slice('sha256:'.length)
        insertBlob.run(digest, file.bytes, file.bytes.length)
        insertFile.run(input.canvasId, revision, path, digest, item.type, file.bytes.length)
      }
      this.db
        .prepare('UPDATE canvases SET preview_revision = ?, fence_generation = ? WHERE id = ?')
        .run(revision, input.expectedFence + 1, input.canvasId)
      this.prune(input.canvasId, createdAt)
    })
    const stored = this.db
      .prepare('SELECT revision, parent, kind, status FROM canvas_revisions WHERE canvas_id = ? AND revision = ?')
      .get(input.canvasId, revision)
    this.remember(canvas.session_id, input.canvasId, stored, input.expectedFence + 1)
    return {
      ok: true,
      revision,
      kind: input.kind,
      baseRevision: parent,
      entry,
      fence: input.expectedFence + 1,
      manifest: checked,
      canvas: this.canvasRow(input.canvasId),
    }
  }

  remember(
    sessionId: string,
    canvasId: string,
    revision: { revision: number; parent: number | null; kind: string },
    fence: number,
  ) {
    if (revision.kind !== 'snapshot' && revision.kind !== 'delta') return
    this.notices.set(canvasId, {
      sessionId,
      wire: {
        type: 'canvas.revision',
        canvasId,
        revision: revision.revision,
        baseRevision: revision.parent,
        kind: revision.kind,
        stamp: `${canvasId}:${revision.revision}:${fence}`,
      },
    })
  }

  fileSizeAt(canvasId: string, revision: number | null, path: string) {
    if (revision == null) return null
    const row = this.db
      .prepare('SELECT size FROM canvas_files WHERE canvas_id = ? AND revision = ? AND path = ?')
      .get(canvasId, revision, path)
    return row ? Number(row.size) : null
  }

  previewPaths(canvasId: string) {
    const canvas = this.rawCanvas(canvasId)
    if (!canvas || canvas.preview_revision == null) return []
    return this.db
      .prepare('SELECT path FROM canvas_files WHERE canvas_id = ? AND revision = ? ORDER BY path ASC')
      .all(canvasId, Number(canvas.preview_revision))
      .map(row => String(row.path))
  }

  /** Current preview. HTML and CSS include text. Other files are path, type, and size only. */
  previewListing(canvasId: string) {
    const canvas = this.rawCanvas(canvasId)
    if (!canvas) return toolError('NOT_FOUND', 'No such canvas.')
    const revision = canvas.preview_revision == null ? null : Number(canvas.preview_revision)
    if (revision == null) return { ok: true as const, revision: null, files: [] as PreviewRead[] }
    const rows = this.db
      .prepare(
        `SELECT f.path, f.media_type, f.size, b.bytes
         FROM canvas_files f
         JOIN canvas_blobs b ON b.hash = f.hash
         WHERE f.canvas_id = ? AND f.revision = ?
         ORDER BY f.path ASC`,
      )
      .all(canvasId, revision)
    return {
      ok: true as const,
      revision,
      files: rows.map(row => {
        const type = String(row.media_type)
        const item: PreviewRead = { path: String(row.path), type, bytes: Number(row.size) }
        if (type === 'text/html' || type === 'text/css')
          item.text = Buffer.from(row.bytes as Uint8Array).toString('utf8')
        return item
      }),
    }
  }

  /** Staged bytes win. Otherwise the current preview file. */
  currentFile(canvasId: string, path: string) {
    const draft = this.db
      .prepare('SELECT media_type, bytes FROM canvas_drafts WHERE canvas_id = ? AND path = ?')
      .get(canvasId, path)
    if (draft) return { type: String(draft.media_type), bytes: Buffer.from(draft.bytes as Uint8Array) }
    const canvas = this.rawCanvas(canvasId)
    const revision = canvas?.preview_revision == null ? null : Number(canvas.preview_revision)
    if (revision == null) return null
    const row = this.db
      .prepare(
        `SELECT f.media_type, b.bytes
         FROM canvas_files f
         JOIN canvas_blobs b ON b.hash = f.hash
         WHERE f.canvas_id = ? AND f.revision = ? AND f.path = ?`,
      )
      .get(canvasId, revision, path)
    if (!row) return null
    return { type: String(row.media_type), bytes: Buffer.from(row.bytes as Uint8Array) }
  }

  revisionFiles(canvasId: string, revision: number) {
    if (!CANVAS_ID.test(canvasId) || !Number.isInteger(revision) || revision < 1)
      return toolError('NOT_FOUND', 'No such revision.')
    const row = this.db
      .prepare(
        `SELECT revision, parent, kind, entry, status, error FROM canvas_revisions
         WHERE canvas_id = ? AND revision = ?`,
      )
      .get(canvasId, revision)
    if (!row) return toolError('NOT_FOUND', 'No such revision.')
    if (row.status === 'failed' || row.kind === 'failed')
      return toolError('VALIDATION', row.error || 'This revision failed.')
    const files = this.db
      .prepare(
        `SELECT path, hash, size, media_type FROM canvas_files
         WHERE canvas_id = ? AND revision = ? ORDER BY path ASC`,
      )
      .all(canvasId, revision)
    return {
      ok: true as const,
      revision: row.revision as number,
      parent: row.parent as number | null,
      kind: row.kind as 'snapshot' | 'delta',
      entry: row.entry as string,
      manifest: files.map(file => ({
        path: file.path as string,
        hash: `sha256:${file.hash}`,
        bytes: file.size as number,
        type: file.media_type as string,
      })),
    }
  }

  prune(canvasId: string, now: string) {
    const canvas = this.rawCanvas(canvasId)
    if (!canvas) return
    const revisions = this.db
      .prepare('SELECT revision FROM canvas_revisions WHERE canvas_id = ? ORDER BY revision DESC')
      .all(canvasId)
      .map(row => row.revision as number)
    const keep = new Set<number>(revisions.slice(0, CANVAS_KEEP_REVISIONS))
    if (canvas.stable_revision != null) keep.add(canvas.stable_revision)
    if (canvas.preview_revision != null) keep.add(canvas.preview_revision)
    const tokens = this.db
      .prepare(
        `SELECT min_revision, max_revision FROM canvas_tokens
         WHERE canvas_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .all(canvasId, now)
    for (const token of tokens) {
      for (const revision of revisions) {
        if (revision >= token.min_revision && revision <= token.max_revision) keep.add(revision)
      }
    }
    for (const revision of revisions) {
      if (keep.has(revision)) continue
      this.db.prepare('DELETE FROM canvas_files WHERE canvas_id = ? AND revision = ?').run(canvasId, revision)
      this.db.prepare('DELETE FROM canvas_revisions WHERE canvas_id = ? AND revision = ?').run(canvasId, revision)
    }
    this.db.prepare('DELETE FROM canvas_blobs WHERE hash NOT IN (SELECT hash FROM canvas_files)').run()
  }

  nextRevision(canvasId: string) {
    const row = this.db.prepare('SELECT MAX(revision) AS n FROM canvas_revisions WHERE canvas_id = ?').get(canvasId)
    return Number(row?.n ?? 0) + 1
  }

  rawCanvas(canvasId: string) {
    if (!CANVAS_ID.test(canvasId)) return null
    return this.db
      .prepare(
        `SELECT id, session_id, ticket_id, title, stable_revision, preview_revision, fence_generation, created_at
         FROM canvases WHERE id = ?`,
      )
      .get(canvasId)
  }

  canvasRow(canvasId: string) {
    const row = this.rawCanvas(canvasId)
    if (!row) return null
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      ticketId: (row.ticket_id as string | null) ?? null,
      title: row.title as string,
      stableRevision: (row.stable_revision as number | null) ?? null,
      previewRevision: (row.preview_revision as number | null) ?? null,
      fence: Number(row.fence_generation),
      createdAt: row.created_at as string,
    }
  }

  transaction(run: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw error
    }
  }

  locked<T>(canvasId: string, fn: () => T): Promise<T> {
    const previous = this.tails.get(canvasId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.tails.set(
      canvasId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }
}
