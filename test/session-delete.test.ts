import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { openCanvasStore } from '../src/canvas-store.ts'
import { createDesk } from '../src/desk.ts'
import { isFenced, unfence } from '../src/deleting.ts'
import { createEngine } from '../src/engine.ts'
import { executeDelete } from '../src/session-delete-job.ts'
import { deleteOwnedLogs, deleteOwnedSessions, sessionClosure } from '../src/session-wipe.ts'
import { openStore } from '../src/store.ts'

const OWNER = 'session-delete-owner'
const OTHER = 'session-delete-other'
const WORKER = 'worker-delete-ticket'

test('delete removes a bot, its worker, and unreferenced blobs, and keeps shared data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-wipe-'))
  const store = openStore(dir)
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  const engine = createEngine(store)
  try {
    const persona = engine.confirmPersona('shared soul')
    engine.bindPersona(OWNER, persona.id)
    engine.bindPersona(OTHER, persona.id)
    engine.ensureSession(WORKER, { parentSessionId: OWNER })
    const privateSkill = engine.registerSkill(OWNER, 'private', 'alpha', '1.0.0', 'private', Buffer.from('only-owner'))
    const shared = engine.registerSkill(OWNER, 'public', 'beta', '1.0.0', 'shared', Buffer.from('shared-skill'))
    engine.registerSkill(OTHER, 'public', 'beta', '1.0.0', 'shared', Buffer.from('shared-skill'))
    const stamp = new Date().toISOString()
    store.db
      .prepare(
        `INSERT INTO facts (session_id, kind, content, status, source_type, revision, priority, created_at, updated_at)
         VALUES (?, 'user_fact', ?, 'active', 'explicit_tool', 1, 100, ?, ?)`,
      )
      .run(OWNER, 'owner fact', stamp, stamp)
    store.db
      .prepare(
        `INSERT INTO facts (session_id, kind, content, status, source_type, revision, priority, created_at, updated_at)
         VALUES (?, 'user_fact', ?, 'active', 'explicit_tool', 1, 100, ?, ?)`,
      )
      .run(OTHER, 'other fact', stamp, stamp)
    store.db
      .prepare(
        `INSERT INTO work_tickets (
           id, owner_session_id, child_session_id, revision, briefing_revision, status, review_status,
           briefing_hash, correlation_id, budget_json, created_at, updated_at
         ) VALUES ('ticket-delete-1', ?, ?, 1, 1, 'started', 'none', 'brief-owner', '', '{}', ?, ?)`,
      )
      .run(OWNER, WORKER, stamp, stamp)
    store.db
      .prepare(
        `INSERT INTO work_tickets (
           id, owner_session_id, child_session_id, revision, briefing_revision, status, review_status,
           briefing_hash, correlation_id, budget_json, created_at, updated_at
         ) VALUES ('ticket-delete-2', ?, NULL, 1, 1, 'started', 'none', 'brief-other', '', '{}', ?, ?)`,
      )
      .run(OTHER, stamp, stamp)
    mkdirSync(join(dir, 'blobs', 'work'), { recursive: true })
    writeFileSync(join(dir, 'blobs', 'work', 'brief-owner.txt'), 'owner brief')
    writeFileSync(join(dir, 'blobs', 'work', 'brief-other.txt'), 'other brief')
    mkdirSync(join(dir, 'src', 'skills', 'private', OWNER, 'alpha'), { recursive: true })
    writeFileSync(join(dir, 'src', 'skills', 'private', OWNER, 'alpha', 'SKILL.md'), 'only-owner')
    mkdirSync(join(dir, 'src', 'skills', 'public', 'beta'), { recursive: true })
    writeFileSync(join(dir, 'src', 'skills', 'public', 'beta', 'SKILL.md'), 'catalog')
    mkdirSync(join(dir, 'export', OWNER), { recursive: true })
    writeFileSync(join(dir, 'export', OWNER, 'memory.md'), 'export')
    const created = canvas.create({ sessionId: OWNER, title: 'Owner' })
    const kept = canvas.create({ sessionId: OTHER, title: 'Other' })
    assert.equal(created.ok, true)
    assert.equal(kept.ok, true)

    const home = join(dir, 'home')
    const sessionsRoot = join(home, 'sessions')
    mkdirSync(join(sessionsRoot, 'project', OWNER), { recursive: true })
    mkdirSync(join(sessionsRoot, 'project', WORKER), { recursive: true })
    writeFileSync(join(sessionsRoot, 'project', OWNER, 'session.v4.jsonl.zstd'), 'log')
    writeFileSync(join(sessionsRoot, 'project', WORKER, 'session.v4.jsonl.zstd'), 'worker')
    const cache = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, `${OWNER}.json`), '{}')
    writeFileSync(
      join(home, 'storages', 'workspace.json'),
      JSON.stringify({
        global: { archivedSessionIds: [OWNER] },
        tables: { workspaces: { a: { sessionIds: [OWNER, OTHER] } } },
      }),
    )

    assert.deepEqual(sessionClosure(store.db, OWNER).sort(), [OWNER, WORKER].sort())
    await deleteOwnedSessions(store, sessionClosure(store.db, OWNER))
    canvas.deleteSessions(sessionClosure(store.db, OWNER).filter(id => id === OWNER || id === WORKER))
    deleteOwnedLogs({
      sessionsRoot,
      stateRoot: home,
      sessionIds: [OWNER, WORKER],
    })

    assert.equal(store.db.prepare('SELECT id FROM facts WHERE session_id = ?').get(OWNER), undefined)
    assert.equal(store.db.prepare('SELECT content FROM facts WHERE session_id = ?').get(OTHER).content, 'other fact')
    assert.equal(store.db.prepare('SELECT session_id FROM session_bindings WHERE session_id = ?').get(OWNER), undefined)
    assert.equal(
      store.db.prepare('SELECT session_id FROM session_bindings WHERE session_id = ?').get(WORKER),
      undefined,
    )
    assert.equal(
      store.db.prepare('SELECT session_id FROM session_bindings WHERE session_id = ?').get(OTHER).session_id,
      OTHER,
    )
    assert.equal(store.db.prepare('SELECT id FROM work_tickets WHERE owner_session_id = ?').get(OWNER), undefined)
    assert.equal(
      store.db.prepare('SELECT id FROM work_tickets WHERE id = ?').get('ticket-delete-2').id,
      'ticket-delete-2',
    )
    assert.equal(store.readBlob('persona', persona.content_hash) !== null, true)
    assert.equal(store.readBlob('skill', privateSkill.content_hash), null)
    assert.equal(store.readBlob('skill', shared.content_hash)?.toString('utf8'), 'shared-skill')
    assert.equal(existsSync(join(dir, 'blobs', 'work', 'brief-owner.txt')), false)
    assert.equal(existsSync(join(dir, 'blobs', 'work', 'brief-other.txt')), true)
    assert.equal(existsSync(join(dir, 'src', 'skills', 'private', OWNER)), false)
    assert.equal(readFileSync(join(dir, 'src', 'skills', 'public', 'beta', 'SKILL.md'), 'utf8'), 'catalog')
    assert.equal(existsSync(join(dir, 'export', OWNER)), false)
    assert.equal(canvas.list(OWNER).ok, true)
    if (canvas.list(OWNER).ok) assert.deepEqual(canvas.list(OWNER).canvases, [])
    const listed = canvas.list(OTHER)
    assert.equal(listed.ok, true)
    if (listed.ok) assert.equal(listed.canvases.length, 1)
    assert.equal(existsSync(join(sessionsRoot, 'project', OWNER)), false)
    assert.equal(existsSync(join(sessionsRoot, 'project', WORKER)), false)
    const workspace = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(workspace.global.archivedSessionIds, [])
    assert.deepEqual(workspace.tables.workspaces.a.sessionIds, [OTHER])
    assert.equal(existsSync(join(cache, `${OWNER}.json`)), false)
  } finally {
    canvas.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete waits until turns stop, and a turn that will not stop keeps the fence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-quiesce-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const busy = 'session-delete-busy'
  try {
    engine.ensureSession(OWNER)
    store.db
      .prepare(
        `INSERT INTO facts (session_id, kind, content, status, source_type, revision, priority, created_at, updated_at)
         VALUES (?, 'user_fact', 'keep-until-idle', 'active', 'explicit_tool', 1, 100, ?, ?)`,
      )
      .run(OWNER, new Date().toISOString(), new Date().toISOString())
    const stopped: string[] = []
    const phases: string[] = []
    await executeDelete(
      host(store, stopped, async () => false),
      OWNER,
      event => phases.push(event.phase),
    )
    assert.deepEqual(phases, ['fence', 'stop', 'idle', 'store', 'canvas', 'files', 'done'])
    assert.deepEqual(stopped, [OWNER])
    assert.equal(store.db.prepare('SELECT id FROM facts WHERE session_id = ?').get(OWNER), undefined)
    assert.equal(isFenced(OWNER), false)

    engine.ensureSession(busy)
    store.db
      .prepare(
        `INSERT INTO facts (session_id, kind, content, status, source_type, revision, priority, created_at, updated_at)
         VALUES (?, 'user_fact', 'still-here', 'active', 'explicit_tool', 1, 100, ?, ?)`,
      )
      .run(busy, new Date().toISOString(), new Date().toISOString())
    const blocked: string[] = []
    await executeDelete(
      host(store, blocked, async () => true),
      busy,
      () => {},
    )
    assert.equal(store.db.prepare('SELECT content FROM facts WHERE session_id = ?').get(busy).content, 'still-here')
    assert.equal(isFenced(busy), true)
    assert.equal(blocked.includes(busy), true)
  } finally {
    unfence([OWNER, busy, WORKER])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fenced session cannot be prompted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-fence-prompt-'))
  const sessionId = 'session-delete-prompt'
  let prompted = false
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: '',
    isBot: () => true,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: true }),
    rpc: async (endpoint: string) => {
      if (endpoint === 'session/modelCatalog') {
        return { status: 200, body: { result: { ok: true, value: { routableProviders: ['local'] } } } }
      }
      if (endpoint === 'session/prompt') {
        prompted = true
        return { status: 200, body: { result: { ok: true, value: {} } } }
      }
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: { result: { ok: true, value: { items: [{ sessionId, running: false, blank: false, cwd: '/work' }] } } },
        }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    const { fence } = await import('../src/deleting.ts')
    fence([sessionId])
    const result = await desk.handle(
      'POST',
      '/session-foundations/api/tasks',
      new URL('http://127.0.0.1/session-foundations/api/tasks'),
      Object.assign(
        Readable.from([Buffer.from(JSON.stringify({ sessionId, text: 'hello', idempotencyKey: 'delete-key-1' }))]),
        {
          headers: {},
        },
      ),
    )
    assert.equal(result.status, 409)
    assert.equal(result.body.error, 'deleting')
    assert.equal(prompted, false)
  } finally {
    unfence([sessionId])
    rmSync(dir, { recursive: true, force: true })
  }
})

function host(
  store: ReturnType<typeof openStore>,
  stopped: string[],
  running: (sessionId: string) => Promise<boolean | null>,
) {
  return {
    store,
    canvas: null,
    sessionsRoot: '',
    stateRoot: '',
    running,
    stop: async (sessionId: string) => {
      stopped.push(sessionId)
      return true
    },
    silence: () => {},
    cancelQuestions: () => {},
    abandonApprovals: () => {},
    forgetDesk: () => {},
    dropMemory: () => {},
  }
}
