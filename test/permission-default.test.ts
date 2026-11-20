import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDesk } from '../src/desk.ts'
import { createEngine } from '../src/engine.ts'
import { registerHttp } from '../src/http.ts'
import {
  applyFreshMainPermission,
  forgetPending,
  permissionDefaultFile,
  permissionDefaultView,
  PRODUCT_DEFAULT_PRESET,
  readPermissionDefault,
  rememberFreshMain,
  setDefaultPermission,
} from '../src/permission-default.ts'
import { setPermission } from '../src/permissions.ts'
import { openStore } from '../src/store.ts'

const API = '/session-foundations/api'

const BUNDLES: Record<string, { sandbox: string; approval: string }> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

type LiveSession = { id: string; preset: string; sandbox: string; approval: string }

function host(options: { sessions?: Map<string, LiveSession>; catalogDefault?: string } = {}) {
  const sessions = options.sessions ?? new Map<string, LiveSession>()
  const calls: Array<{ id: string; name: string; sandbox: string; approval: string }> = []
  const service = {
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only', description: 'Read files.' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
        { value: 'auto', name: 'Auto' },
      ],
      defaultOptions: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
      defaultPreset: options.catalogDefault ?? 'workspace-write',
    }),
    current: (session: LiveSession) => session.preset,
    set(session: LiveSession, name: string) {
      const bundle = BUNDLES[name]
      if (!bundle) throw new Error(`permission: unknown preset "${name}"`)
      session.preset = name
      session.sandbox = bundle.sandbox
      session.approval = bundle.approval
      calls.push({ id: session.id, name, sandbox: session.sandbox, approval: session.approval })
    },
  }
  const ctx = {
    get: (name: string) =>
      name === 'permissionPresets'
        ? service
        : name === 'sessions'
          ? { get: (id: string) => sessions.get(id) }
          : undefined,
    agents: { get: (id: string) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) },
  }
  return { ctx, sessions, calls, service }
}

function live(id: string, preset = 'workspace-write'): LiveSession {
  const bundle = BUNDLES[preset] ?? BUNDLES['workspace-write']
  return { id, preset, sandbox: bundle.sandbox, approval: bundle.approval }
}

test('a missing file and an old file without the field default to fully allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-absent-'))
  const file = permissionDefaultFile(dir)
  const { ctx } = host()
  try {
    assert.equal(readPermissionDefault(file).stored, null)
    assert.equal(readPermissionDefault(file).ignoredStored, false)
    assert.equal(permissionDefaultView(ctx, file).defaultPreset, PRODUCT_DEFAULT_PRESET)
    writeFileSync(file, '{}\n')
    assert.equal(permissionDefaultView(ctx, file).defaultPreset, 'danger-full-access')
    assert.equal(permissionDefaultView(ctx, file).stored, null)
    writeFileSync(file, `${JSON.stringify({ revision: 3, note: 'legacy' })}\n`)
    const legacy = permissionDefaultView(ctx, file)
    assert.equal(legacy.stored, null)
    assert.equal(legacy.ignoredStored, false)
    assert.equal(legacy.defaultPreset, 'danger-full-access')
    assert.equal(legacy.hostDefault, 'workspace-write')
    assert.equal(legacy.scope, 'new-main-session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid stored values are ignored and invalid writes do not replace them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-invalid-'))
  const file = permissionDefaultFile(dir)
  const { ctx } = host()
  try {
    writeFileSync(file, `${JSON.stringify({ defaultPreset: 'nope', pending: ['session-keep'] })}\n`)
    const ignored = permissionDefaultView(ctx, file)
    assert.equal(ignored.stored, 'nope')
    assert.equal(ignored.ignoredStored, true)
    assert.equal(ignored.defaultPreset, 'danger-full-access')
    for (const name of ['auto', 'custom', '', 'nope', 'readonly']) {
      const rejected = setDefaultPermission(ctx, file, name)
      assert.equal(rejected.ok, false, name)
      assert.equal(rejected.code, 'VALIDATION')
    }
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultPreset, 'nope')
    assert.deepEqual(readPermissionDefault(file).pending, ['session-keep'])
    writeFileSync(file, `${JSON.stringify({ defaultPreset: 'auto' })}\n`)
    assert.equal(readPermissionDefault(file).ignoredStored, true)
    assert.equal(permissionDefaultView(ctx, file).defaultPreset, 'danger-full-access')
    writeFileSync(file, `${JSON.stringify({ defaultPreset: 1 })}\n`)
    assert.equal(readPermissionDefault(file).stored, null)
    assert.equal(readPermissionDefault(file).ignoredStored, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every configured mode persists across a fresh read and drives sandbox plus approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-modes-'))
  const file = permissionDefaultFile(dir)
  const { ctx, sessions, calls } = host()
  try {
    for (const name of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const saved = setDefaultPermission(ctx, file, name)
      assert.equal(saved.ok, true)
      const reread = readPermissionDefault(file)
      assert.equal(reread.stored, name)
      assert.equal(permissionDefaultView(ctx, file).defaultPreset, name)
      const id = `session-${name}`
      sessions.set(id, live(id, 'workspace-write'))
      assert.equal(rememberFreshMain(file, id), true)
      const applied = applyFreshMainPermission(ctx, file, id, () => true)
      assert.equal(applied.applied, true)
      assert.equal(applied.preset, name)
      const session = sessions.get(id)
      assert.equal(session?.preset, name)
      assert.equal(session?.sandbox, BUNDLES[name].sandbox)
      assert.equal(session?.approval, BUNDLES[name].approval)
    }
    assert.deepEqual(
      calls.map(call => call.name),
      ['read-only', 'workspace-write', 'danger-full-access'],
    )
    const again = readPermissionDefault(file)
    assert.equal(again.stored, 'danger-full-access')
    assert.deepEqual(again.pending, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new main session uses the saved default, not the host composition default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-fresh-'))
  const file = permissionDefaultFile(dir)
  const { ctx, sessions, calls } = host({ catalogDefault: 'workspace-write' })
  const id = 'session-new-main'
  sessions.set(id, live(id))
  try {
    rememberFreshMain(file, id)
    const applied = applyFreshMainPermission(ctx, file, id, () => true)
    assert.equal(applied.preset, 'danger-full-access')
    assert.equal(sessions.get(id)?.sandbox, 'danger-full-access')
    assert.equal(sessions.get(id)?.approval, 'never')
    assert.equal(calls.length, 1)
    const second = applyFreshMainPermission(ctx, file, id, () => true)
    assert.equal(second.reason, 'not-pending')
    assert.equal(calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing sessions and an explicit per-session choice survive a global change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-keep-'))
  const file = permissionDefaultFile(dir)
  const { ctx, sessions, calls } = host()
  const existing = 'session-existing'
  const chosen = 'session-chosen'
  const later = 'session-later'
  sessions.set(existing, live(existing, 'read-only'))
  sessions.set(chosen, live(chosen))
  sessions.set(later, live(later))
  try {
    rememberFreshMain(file, chosen)
    const explicit = setPermission(ctx, chosen, 'read-only')
    assert.equal(explicit.ok, true)
    assert.equal(forgetPending(file, chosen), true)
    setDefaultPermission(ctx, file, 'danger-full-access')
    assert.equal(applyFreshMainPermission(ctx, file, existing, () => true).reason, 'not-pending')
    assert.equal(applyFreshMainPermission(ctx, file, chosen, () => true).reason, 'not-pending')
    assert.equal(sessions.get(existing)?.sandbox, 'read-only')
    assert.equal(sessions.get(chosen)?.sandbox, 'read-only')
    assert.equal(sessions.get(chosen)?.approval, 'ask')
    rememberFreshMain(file, later)
    assert.equal(applyFreshMainPermission(ctx, file, later, () => true).preset, 'danger-full-access')
    assert.equal(sessions.get(existing)?.preset, 'read-only')
    assert.equal(sessions.get(chosen)?.preset, 'read-only')
    assert.equal(sessions.get(later)?.sandbox, 'danger-full-access')
    assert.ok(calls.every(call => call.id !== existing))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pending id survives a restart read and a worker is not a main session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-restart-'))
  const file = permissionDefaultFile(dir)
  const { ctx, sessions, calls } = host()
  const id = 'session-armed'
  sessions.set(id, live(id))
  try {
    setDefaultPermission(ctx, file, 'workspace-write')
    rememberFreshMain(file, id)
    assert.equal(rememberFreshMain(file, 'worker-job'), false)
    const restarted = readPermissionDefault(file)
    assert.equal(restarted.stored, 'workspace-write')
    assert.deepEqual(restarted.pending, [id])
    assert.equal(applyFreshMainPermission(ctx, file, 'worker-job', () => false).reason, 'not-main')
    assert.equal(applyFreshMainPermission(ctx, file, id, () => false).reason, 'not-main')
    assert.deepEqual(readPermissionDefault(file).pending, [id])
    assert.equal(calls.length, 0)
    const applied = applyFreshMainPermission(ctx, file, id, () => true)
    assert.equal(applied.preset, 'workspace-write')
    assert.equal(sessions.get(id)?.sandbox, 'workspace-write')
    assert.equal(sessions.get(id)?.approval, 'ask')
    assert.equal(calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply waits until the session is live, then uses the default saved before the crash window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-live-'))
  const file = permissionDefaultFile(dir)
  const { ctx, sessions } = host()
  const id = 'session-delayed'
  try {
    rememberFreshMain(file, id)
    const early = applyFreshMainPermission(ctx, file, id, () => true)
    assert.equal(early.reason, 'rejected')
    assert.deepEqual(readPermissionDefault(file).pending, [id])
    sessions.set(id, live(id))
    assert.equal(applyFreshMainPermission(ctx, file, id, () => true).preset, 'danger-full-access')
    assert.equal(sessions.get(id)?.sandbox, 'danger-full-access')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workbench create arms only a fresh main session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-desk-'))
  const file = permissionDefaultFile(dir)
  const cwd = join(dir, 'workspace')
  const armed: string[] = []
  let created = 0
  let reuseBlank = true
  const desk = createDesk({
    ledgerFile: join(dir, 'desk-ledger.json'),
    profileDir: dir,
    sessionCwd: cwd,
    isBot: () => true,
    mark: (sessionId: string) => ({ kind: 'bot', session_id: sessionId }),
    hold: () => {},
    release: () => {},
    usage: async () => ({ connected: false }),
    onFreshMain: sessionId => {
      armed.push(sessionId)
      rememberFreshMain(file, sessionId)
    },
    rpc: async endpoint => {
      if (endpoint === 'session/list') {
        return {
          status: 200,
          body: {
            result: {
              ok: true,
              value: {
                items: reuseBlank ? [{ sessionId: 'session-blank', running: false, blank: true, cwd }] : [],
              },
            },
          },
        }
      }
      if (endpoint === 'session/create') {
        created += 1
        const sessionId = reuseBlank ? 'session-blank' : `session-fresh-${created}`
        return { status: 200, body: { result: { ok: true, value: { sessionId } } } }
      }
      return { status: 404, body: { result: { ok: false } } }
    },
  })
  const post = (key: string) =>
    desk.handle(
      'POST',
      `${API}/sessions`,
      new URL(`http://127.0.0.1${API}/sessions`),
      incoming({}, { 'idempotency-key': key }),
    )
  try {
    const reused = await post('blank-reuse')
    assert.equal(reused.status, 201)
    assert.equal(reused.body.reused, true)
    assert.equal(reused.body.sessionId, 'session-blank')
    assert.deepEqual(armed, [])
    reuseBlank = false
    const fresh = await post('fresh-key')
    assert.equal(fresh.body.sessionId, 'session-fresh-2')
    assert.equal(fresh.body.reused, false)
    assert.deepEqual(armed, ['session-fresh-2'])
    const replay = await post('fresh-key')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.reused, true)
    assert.deepEqual(armed, ['session-fresh-2'])
    assert.deepEqual(readPermissionDefault(file).pending, ['session-fresh-2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default route keeps the workbench auth gate and readback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-default-http-'))
  const store = openStore(dir)
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  const sessions = new Map<string, LiveSession>([['session-live', live('session-live', 'workspace-write')]])
  const { service } = host({ sessions })
  let dispose = () => {}
  const ctx = {
    effect: (fn: () => unknown) => {
      const done = fn()
      if (typeof done === 'function') dispose = done as () => void
    },
    get: (name: string) => {
      if (name === 'connection') {
        return { requestRejection: (req: IncomingMessage) => (req.headers.authorization === 'test-owner' ? 0 : 401) }
      }
      if (name === 'permissionPresets') return service
      if (name === 'sessions') return { get: (id: string) => sessions.get(id) }
      return undefined
    },
    agents: { get: (id: string) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) },
    webServer: {
      register: (route: (typeof routes)[number]) => {
        routes.push(route)
        return () => {}
      },
    },
    profileContext: { dir: join(dir, 'profile') },
  }
  registerHttp(
    ctx as never,
    createEngine(store),
    () => null,
    () => null,
    dir,
  )
  const handler = routes.find(route => route.path === '/dsh-bot')!.handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { authorization: 'test-owner', 'content-type': 'application/json' }
  try {
    const anonymous = await fetch(`${origin}/dsh-bot/api/permissions/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'danger-full-access' }),
    })
    assert.equal(anonymous.status, 401)
    assert.equal((await anonymous.json()).code, 'FORBIDDEN')
    const files = await fetch(`${origin}/dsh-bot/api/files?sessionId=session-live&path=${encodeURIComponent('/etc')}`)
    assert.equal(files.status, 401)
    const first = await (await fetch(`${origin}/dsh-bot/api/permissions/default`, { headers })).json()
    assert.equal(first.defaultPreset, 'danger-full-access')
    assert.equal(first.stored, null)
    assert.equal(first.scope, 'new-main-session')
    assert.ok(first.options.some((option: { value: string }) => option.value === 'workspace-write'))
    assert.ok(!first.options.some((option: { value: string }) => option.value === 'auto'))
    const rejected = await fetch(`${origin}/dsh-bot/api/permissions/default`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'auto' }),
    })
    assert.equal(rejected.status, 400)
    const saved = await (
      await fetch(`${origin}/dsh-bot/api/permissions/default`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'workspace-write' }),
      })
    ).json()
    assert.equal(saved.ok, true)
    assert.equal(saved.defaultPreset, 'workspace-write')
    const readback = await (await fetch(`${origin}/session-foundations/api/permissions/default`, { headers })).json()
    assert.equal(readback.stored, 'workspace-write')
    assert.equal(readPermissionDefault(permissionDefaultFile(dir)).stored, 'workspace-write')
    rememberFreshMain(permissionDefaultFile(dir), 'session-live')
    const chosen = await (
      await fetch(`${origin}/dsh-bot/api/permissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'session-live', name: 'read-only' }),
      })
    ).json()
    assert.equal(chosen.currentValue, 'read-only')
    assert.equal(sessions.get('session-live')?.sandbox, 'read-only')
    const skipped = applyFreshMainPermission(ctx as never, permissionDefaultFile(dir), 'session-live', () => true)
    assert.equal(skipped.reason, 'not-pending')
    assert.equal(sessions.get('session-live')?.sandbox, 'read-only')
    assert.equal(sessions.get('session-live')?.approval, 'ask')
  } finally {
    server.close()
    dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function incoming(body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return Object.assign(Readable.from(payload), { headers })
}
