import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDesk } from '../src/desk.ts'
import { openLedger } from '../src/desk-ledger.ts'
import { sessionDirectory } from '../src/session-files.ts'

const API = '/session-foundations/api'

test('ledger reuses an idempotency key and does not mint a second task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-ledger-'))
  const ledger = openLedger(join(dir, 'ledger.json'))
  const first = ledger.rememberTask('task-key-1', {
    sessionId: 'session-a',
    status: 'blocked_unconfigured',
    reason: 'unconfigured',
  })
  const second = ledger.rememberTask('task-key-1', { sessionId: 'session-b', status: 'accepted', reason: '' })
  assert.equal(second.created, false)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.sessionId, 'session-a')
  rmSync(dir, { recursive: true, force: true })
})

test('desk creates a bot, archives only blanks, and does not prompt without a model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-desk-'))
  const seen: any[] = []
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: () => false,
    mark: (sessionId: any) => ({ kind: 'bot', session_id: sessionId }),
    hold: () => {},
    release: () => {},
    usage: async () => ({
      connected: false,
      code: 'usage_unconfigured',
      error: 'OLLAMA_API_KEY is not available',
      token: 'hide-me',
    }),
    rpc: async (endpoint: any, args: any) => {
      seen.push(endpoint)
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: {
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 'session-abc', running: false, blank: true, cwd: '/work' },
                  { sessionId: 'session-kept', running: false, blank: false, cwd: '/work' },
                ],
              },
            },
          },
        }
      }
      if (endpoint === 'session/create') {
        return { status: 200, body: { result: { ok: true, value: { sessionId: 'session-created' } } } }
      }
      if (endpoint === 'workspace/archiveSession') {
        return { status: 200, body: { result: { ok: true, value: { archivedSessionIds: [args.request.sessionId] } } } }
      }
      if (endpoint === 'session/modelCatalog') {
        return { status: 200, body: { result: { ok: true, value: { routableProviders: [] } } } }
      }
      if (endpoint === 'session/prompt') throw new Error('prompt should not be called')
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    const created = await desk.handle(
      'POST',
      `${API}/sessions`,
      url('/sessions'),
      incoming({ name: 'Scout' }, { 'idempotency-key': 'create-key-1' }),
    )
    assert.equal(created.status, 201)
    assert.equal(created.body.sessionId, 'session-created')
    assert.equal(created.body.kind, 'bot')
    assert.match(created.body.marker, /bot\.json$/)
    assert.equal(existsSync(created.body.marker), true)
    const again = await desk.handle(
      'POST',
      `${API}/sessions`,
      url('/sessions'),
      incoming({}, { 'idempotency-key': 'create-key-1' }),
    )
    assert.equal(again.status, 200)
    assert.equal(again.body.reused, true)
    const listed = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(listed.body.result.value.items[0].sessionId, 'session-abc')
    const archived = await desk.handle('POST', `${API}/sessions/session-abc/archive`, url('/archive'), incoming({}))
    assert.equal(archived.status, 200)
    assert.deepEqual(archived.body.archivedSessionIds, ['session-abc'])
    const kept = await desk.handle('POST', `${API}/sessions/session-kept/archive`, url('/archive'), incoming({}))
    assert.equal(kept.status, 409)
    assert.equal(kept.body.error, 'not_blank')
    const absent = await desk.handle('POST', `${API}/sessions/session-missing/archive`, url('/archive'), incoming({}))
    assert.equal(absent.status, 404)
    const task = await desk.handle(
      'POST',
      `${API}/tasks`,
      url('/tasks'),
      incoming({ sessionId: 'session-created', text: 'do the thing' }, { 'idempotency-key': 'task-key-01' }),
    )
    assert.equal(task.status, 409)
    assert.equal(task.body.error, 'model_unconfigured')
    assert.equal(task.body.task.status, 'blocked_unconfigured')
    const repeat = await desk.handle(
      'POST',
      `${API}/tasks`,
      url('/tasks'),
      incoming({ sessionId: 'session-created', text: 'do the thing again' }, { 'idempotency-key': 'task-key-01' }),
    )
    assert.equal(repeat.body.task.id, task.body.task.id)
    assert.equal(seen.includes('session/prompt'), false)
    const usage = await desk.handle('GET', `${API}/usage`, url('/usage'), incoming())
    assert.equal(usage.body.connected, false)
    assert.match(usage.body.error, /OLLAMA_API_KEY/)
    assert.equal(usage.body.token, undefined)
    assert.equal(desk.owns('GET', `${API}/sessions/bots`), false)
    assert.equal(desk.owns('POST', `${API}/sessions/mark`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live bot turn is cancelled before the next prompt, and an idle turn is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-interrupt-'))
  const order: any[] = []
  let running = false
  let cancelOk = true
  let holdCancel = false
  let proceed: ((value?: unknown) => void) | null = null
  const wake = () => {
    proceed?.()
  }
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: (sessionId: any) => sessionId === 'session-bot',
    mark: (sessionId: any) => ({ kind: 'bot', session_id: sessionId }),
    hold: () => {
      order.push('hold')
    },
    release: () => {
      order.push('release')
    },
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any, args: any) => {
      if (endpoint === 'session/modelCatalog') {
        return { status: 200, body: { result: { ok: true, value: { routableProviders: [{ id: 'mock' }] } } } }
      }
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: {
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 'session-bot', running, cwd: join(dir, 'workspace') },
                  { sessionId: 'session-plain', running, cwd: join(dir, 'workspace') },
                ],
              },
            },
          },
        }
      }
      if (endpoint === 'session/cancel') {
        order.push('cancel')
        assert.equal(args.request.sessionId, 'session-bot')
        if (holdCancel) {
          await new Promise(resolve => {
            proceed = resolve
          })
        }
        running = false
        return {
          status: 200,
          body: { result: cancelOk ? { ok: true } : { ok: false, error: { code: 'busy', message: 'cancel failed' } } },
        }
      }
      if (endpoint === 'session/prompt') {
        order.push(`prompt:${args.request.content[0].text}`)
        return { status: 200, body: { result: { ok: true } } }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  const post = (key: any, sessionId: any, text: any) =>
    desk.handle('POST', `${API}/tasks`, url('/tasks'), incoming({ sessionId, text }, { 'idempotency-key': key }))
  try {
    running = false
    const idle = await post('idle-key-1', 'session-bot', 'hello')
    assert.equal(idle.status, 202)
    assert.deepEqual(order, ['prompt:hello'])

    order.length = 0
    running = true
    const first = await post('live-key-1', 'session-bot', 'the first line')
    assert.equal(first.status, 202)
    assert.equal(first.body.interrupted, true)
    assert.deepEqual(order, ['hold', 'cancel', 'prompt:the first line'])

    order.length = 0
    running = true
    const second = await post('live-key-2', 'session-bot', 'a revision')
    assert.equal(second.status, 202)
    assert.deepEqual(order, ['hold', 'cancel', 'prompt:a revision'])
    const tasks = await desk.handle('GET', `${API}/tasks`, url('/tasks'), incoming())
    const older = tasks.body.items.find((item: any) => item.reason === 'interrupted')
    assert.equal(older.status, 'cancelled')
    assert.equal(tasks.body.items.filter((item: any) => item.status === 'accepted').length, 1)

    order.length = 0
    running = true
    const plain = await post('plain-key-1', 'session-plain', 'a plain session')
    assert.equal(plain.status, 202)
    assert.deepEqual(order, ['prompt:a plain session'])

    order.length = 0
    running = true
    cancelOk = false
    const failed = await post('fail-key-01', 'session-bot', 'cancel failed')
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error, 'cancel_failed')
    assert.deepEqual(order, ['hold', 'cancel', 'release'])

    order.length = 0
    cancelOk = true
    running = true
    holdCancel = true
    const left = post('race-key-1', 'session-bot', 'said first')
    const right = post('race-key-2', 'session-bot', 'said second')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(order.filter(item => item === 'cancel').length, 1)
    holdCancel = false
    wake()
    const raced = await Promise.all([left, right])
    assert.equal(
      raced.every(item => item.status === 202),
      true,
    )
    assert.equal(order.filter(item => item === 'cancel').length, 1)
    assert.equal(order.filter(item => item.startsWith('prompt:')).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file preview reads a worker workspace and rejects a foreign session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-file-'))
  const reads: any[] = []
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: join(dir, 'workspace'),
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any, args: any) => {
      if (endpoint !== 'workspaceFiles/read') return { status: 404, body: { result: { ok: false } } }
      reads.push({ scope: args.workspaceFileScopeId, path: args.path })
      const missing = args.path === 'missing.txt'
      return {
        status: 200,
        body: {
          result: missing
            ? { ok: false, error: { code: 'workspace-file/not-found', message: 'missing' } }
            : { ok: true, value: { text: '{\n  "name": "shiguang-coffee"\n}\n', eof: true, bytes: 32 } },
        },
      }
    },
  })
  const preview = (sessionId: any, path: any) =>
    desk.handle(
      'GET',
      `${API}/file`,
      new URL(
        `http://127.0.0.1${API}/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
      ),
      incoming(),
    )
  try {
    const worker = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', 'package.json')
    assert.equal(worker.status, 200)
    assert.equal(worker.body.path, 'package.json')
    assert.match(worker.body.text, /shiguang-coffee/)
    assert.equal(worker.body.eof, true)
    assert.deepEqual(reads[0], { scope: 'worker-ea04885a-66a7-4292-9560-986ab0e9576b', path: 'package.json' })
    const parent = await preview('session-2dfcc21a-a5d8-4d10-98f1-fd7c6f736e2d', 'src/App.jsx')
    assert.equal(parent.status, 200)
    const foreign = await preview('bot-ea04885a-66a7-4292-9560-986ab0e9576b', 'package.json')
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error, 'invalid_file')
    const escape = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', '../package.json')
    assert.equal(escape.status, 400)
    assert.equal(reads.length, 2)
    const missing = await preview('worker-ea04885a-66a7-4292-9560-986ab0e9576b', 'missing.txt')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'file_unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session preview is stored on disk, returned with the list, and dropped when that session is purged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-preview-desk-'))
  const listed = {
    status: 200,
    body: {
      result: { ok: true, value: { items: [{ sessionId: 'session-abc', running: false, blank: true, cwd: '/work' }] } },
    },
  }
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: '',
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any) => {
      if (endpoint === 'session/list') return listed
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    assert.equal(desk.owns('POST', `${API}/sessions/previews`), true)
    const saved = await desk.handle(
      'POST',
      `${API}/sessions/previews`,
      url('/sessions/previews'),
      incoming({ sessionId: 'session-abc', preview: 'what time' }),
    )
    assert.equal(saved.status, 200)
    assert.equal(saved.body.preview, 'what time')
    const sessions = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(sessions.body.previews['session-abc'], 'what time')
    const reopened = createDesk({
      ledgerFile: join(dir, 'desk-ledger.json'),
      profileDir: dir,
      sessionCwd: '',
      isBot: () => false,
      mark: () => ({ kind: 'bot' }),
      hold: () => {},
      release: () => {},
      usage: async () => ({ connected: false }),
      rpc: async () => listed,
    })
    const again = await reopened.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(again.body.previews['session-abc'], 'what time')
    const rejected = await desk.handle(
      'POST',
      `${API}/sessions/previews`,
      url('/sessions/previews'),
      incoming({ sessionId: '../x', preview: 'no' }),
    )
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error, 'bad_session')
    const purged = await desk.handle('POST', `${API}/sessions/session-abc/purge`, url('/purge'), incoming({}))
    assert.equal(purged.status, 200)
    const after = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(after.body.previews['session-abc'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete removes a session that already has messages, detaches an idle one, and leaves a running turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-delete-'))
  const cwd = '/work'
  const full = 'session-full'
  const live = 'session-live'
  const open = 'session-open'
  const stuck = 'session-stuck'
  const blank = 'session-blank'
  const log = sessionDirectory(join(dir, 'sessions'), cwd, full)
  const openLog = sessionDirectory(join(dir, 'sessions'), cwd, open)
  mkdirSync(log, { recursive: true })
  mkdirSync(openLog, { recursive: true })
  writeFileSync(join(log, 'session.v4.jsonl.zstd'), 'messages')
  writeFileSync(join(openLog, 'session.v4.jsonl.zstd'), 'open')
  const cache = join(dir, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, `${full}.json`), '{}')
  const workspace = join(dir, 'storages', 'workspace.json')
  writeFileSync(
    workspace,
    JSON.stringify({
      global: { archivedSessionIds: [full, live] },
      tables: { workspaces: { a: { sessionIds: [full, live, open, stuck] } } },
    }),
  )
  const released: string[] = []
  const unloaded: string[] = []
  const attached = new Set([open, stuck])
  const items = [
    { sessionId: full, running: false, blank: false, cwd },
    { sessionId: live, running: true, blank: false, cwd },
    { sessionId: open, running: false, blank: false, cwd },
    { sessionId: stuck, running: false, blank: false, cwd },
    { sessionId: blank, running: false, blank: true, cwd },
  ]
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: '',
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    releaseLoaded: sessionId => {
      released.push(sessionId)
    },
    releaseAttached: sessionId => {
      unloaded.push(sessionId)
      if (sessionId === open) attached.delete(sessionId)
    },
    stillAttached: sessionId => attached.has(sessionId),
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any) => {
      if (endpoint === 'session/list') {
        return { status: 200, body: { result: { ok: true, value: { items } } } }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    assert.equal(desk.owns('POST', `${API}/sessions/${full}/delete`), true)
    const saved = await desk.handle(
      'POST',
      `${API}/sessions/previews`,
      url('/sessions/previews'),
      incoming({ sessionId: full, preview: 'hello' }),
    )
    assert.equal(saved.status, 200)
    const deleted = await desk.handle('POST', `${API}/sessions/${full}/delete`, url('/delete'), incoming({}))
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.deleted, true)
    assert.deepEqual(released, [full])
    assert.deepEqual(unloaded, [])
    assert.equal(existsSync(log), false)
    assert.equal(existsSync(join(cache, `${full}.json`)), false)
    const stored = JSON.parse(readFileSync(workspace, 'utf8'))
    assert.deepEqual(stored.global.archivedSessionIds, [live])
    assert.deepEqual(stored.tables.workspaces.a.sessionIds, [live, open, stuck])
    const listed = await desk.handle('GET', `${API}/sessions`, url('/sessions'), incoming())
    assert.equal(listed.body.previews[full], undefined)
    const running = await desk.handle('POST', `${API}/sessions/${live}/delete`, url('/delete'), incoming({}))
    assert.equal(running.status, 409)
    assert.equal(running.body.error, 'running')
    assert.deepEqual(released, [full])
    assert.deepEqual(unloaded, [])
    const detached = await desk.handle('POST', `${API}/sessions/${open}/delete`, url('/delete'), incoming({}))
    assert.equal(detached.status, 200)
    assert.equal(detached.body.deleted, true)
    assert.deepEqual(unloaded, [open])
    assert.equal(existsSync(openLog), false)
    assert.deepEqual(JSON.parse(readFileSync(workspace, 'utf8')).tables.workspaces.a.sessionIds, [live, stuck])
    const held = await desk.handle('POST', `${API}/sessions/${stuck}/delete`, url('/delete'), incoming({}))
    assert.equal(held.status, 409)
    assert.equal(held.body.error, 'attached')
    assert.deepEqual(released, [full, open, stuck])
    assert.deepEqual(unloaded, [open, stuck])
    assert.deepEqual(JSON.parse(readFileSync(workspace, 'utf8')).tables.workspaces.a.sessionIds, [live, stuck])
    const purged = await desk.handle('POST', `${API}/sessions/${full}/purge`, url('/purge'), incoming({}))
    assert.equal(purged.status, 409)
    assert.equal(purged.body.error, 'not_blank')
    const missing = await desk.handle('POST', `${API}/sessions/session-missing/delete`, url('/delete'), incoming({}))
    assert.equal(missing.status, 404)
    const removedBlank = await desk.handle('POST', `${API}/sessions/${blank}/delete`, url('/delete'), incoming({}))
    assert.equal(removedBlank.status, 200)
    assert.equal(removedBlank.body.deleted, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete removes the persistence log, not the copy under the profile directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-delete-root-'))
  const home = join(dir, 'home')
  const profile = join(home, 'profiles', 'primary')
  const cwd = '/work'
  const id = 'session-real'
  const real = sessionDirectory(join(home, 'sessions'), cwd, id)
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'session.v4.jsonl.zstd'), 'log')
  const decoy = sessionDirectory(join(profile, 'sessions'), cwd, id)
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'bot.json'), '{}\n')
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
  const desk = createDesk({
    ledgerFile: join(profile, 'session-foundations', 'desk-ledger.json'),
    profileDir: profile,
    sessionsRoot: join(home, 'sessions'),
    stateRoot: home,
    sessionCwd: '',
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any) => {
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: { result: { ok: true, value: { items: [{ sessionId: id, running: false, blank: false, cwd }] } } },
        }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  try {
    const deleted = await desk.handle('POST', `${API}/sessions/${id}/delete`, url('/delete'), incoming({}))
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.deleted, true)
    assert.equal(existsSync(real), false)
    assert.equal(existsSync(decoy), true)
    assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file browser uses the session workspace and keeps the runtime directory closed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-bot-browser-'))
  const home = join(base, 'home')
  const dshHome = join(home, '.dsh-bot')
  const workspace = join(dshHome, 'workspace')
  const other = join(base, 'other')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(workspace, 'readme.md'), 'session work')
  writeFileSync(join(other, 'other.txt'), 'other work')
  writeFileSync(join(dshHome, 'token'), 'secret')
  const sessionId = 'session-browser'
  const desk = createDesk({
    ledgerFile: join(base, 'desk-ledger.json'),
    profileDir: base,
    sessionCwd: other,
    files: { home, dshHome },
    isBot: () => false,
    mark: () => ({ kind: 'bot' }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    rpc: async (endpoint: any) => {
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: { result: { ok: true, value: { items: [{ sessionId, cwd: workspace }] } } },
        }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  const read = (sub: string) =>
    desk.handle('GET', `${API}${sub.split('?')[0]}`, new URL(`http://127.0.0.1${API}${sub}`), incoming())
  try {
    assert.equal(desk.owns('GET', `${API}/files`), true)
    assert.equal(desk.owns('GET', `${API}/files/raw`), false)
    assert.equal(desk.owns('POST', `${API}/files`), false)
    const roots = await read(`/files/roots?sessionId=${sessionId}`)
    assert.equal(roots.status, 200)
    assert.equal(roots.body.workspace.endsWith(`${join('.dsh-bot', 'workspace')}`), true)
    assert.notEqual(roots.body.workspace, other)
    const listed = await read(`/files?sessionId=${sessionId}&path=${encodeURIComponent(workspace)}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items[0].name, 'readme.md')
    const token = await read(`/files/text?sessionId=${sessionId}&path=${encodeURIComponent(join(dshHome, 'token'))}`)
    assert.equal(token.status, 403)
    assert.equal(token.body.error, 'denied')
    const foreign = await read('/files/roots?sessionId=bot-nope')
    assert.equal(foreign.status, 400)
    const uploaded = await desk.saveUpload(
      Object.assign(Readable.from([Buffer.from('via-desk')]), { headers: {} }),
      new URL(
        `http://127.0.0.1${API}/files?sessionId=${sessionId}&dir=${encodeURIComponent(workspace)}&name=added.txt`,
      ),
    )
    assert.equal(uploaded.status, 201)
    assert.equal(readFileSync(join(workspace, 'added.txt'), 'utf8'), 'via-desk')
    const text = await read(
      `/files/text?sessionId=${sessionId}&path=${encodeURIComponent(join(workspace, 'readme.md'))}`,
    )
    assert.equal(text.status, 200)
    assert.equal(text.body.text, 'session work')
    const raw = await desk.openDownload(
      incoming(),
      new URL(
        `http://127.0.0.1${API}/files/raw?sessionId=${sessionId}&path=${encodeURIComponent(join(workspace, 'readme.md'))}`,
      ),
    )
    assert.equal('stream' in raw, true)
    if (!('stream' in raw)) return
    const chunks: Buffer[] = []
    for await (const chunk of raw.stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'session work')
    const huge = await desk.saveUpload(
      Object.assign(Readable.from([Buffer.from('x')]), { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } }),
      new URL(`http://127.0.0.1${API}/files?sessionId=${sessionId}&dir=${encodeURIComponent(workspace)}&name=huge.bin`),
    )
    assert.equal(huge.status, 413)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/**
 * @param {string} path
 */
function url(path: any) {
  return new URL(`http://127.0.0.1${API}${path}`)
}

function incoming(body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return Object.assign(Readable.from(payload), { headers })
}
