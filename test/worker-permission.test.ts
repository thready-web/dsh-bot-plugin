import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { permissionDefaultFile, readPermissionDefault, rememberFreshMain } from '../src/permission-default.ts'
import { effectivePermission } from '../src/permissions.ts'
import { openStore } from '../src/store.ts'
import {
  applyWorkerPermission,
  clearPendingWorkerPermissions,
  dropWorkerPermission,
  pendingWorkerPermission,
  rememberWorkerPermission,
} from '../src/worker-permission.ts'

const BUNDLES: Record<string, { sandbox: string; approval: string }> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
}

type LiveSession = {
  id: string
  preset: string
  sandbox: string
  approval: string
  snapshotEvents?: () => Array<{ type: string; seq: number; data?: { inserted?: Array<{ id?: string }> } }>
}

function live(id: string, preset = 'workspace-write'): LiveSession {
  const bundle = BUNDLES[preset] ?? BUNDLES['workspace-write']
  return { id, preset, sandbox: bundle.sandbox, approval: bundle.approval }
}

function host(options: { sessions?: Map<string, LiveSession> } = {}) {
  const sessions = options.sessions ?? new Map<string, LiveSession>()
  const calls: Array<{ id: string; name: string; sandbox: string; approval: string }> = []
  const service = {
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
        { value: 'auto', name: 'Auto' },
        { value: 'custom', name: 'Custom' },
      ],
      defaultOptions: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
      defaultPreset: 'workspace-write',
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
    sessions: { get: (id: string) => sessions.get(id) },
  }
  return { ctx, sessions, calls, service }
}

test('a missing session is not reported as the host composition default', () => {
  const { ctx } = host()
  const missing = effectivePermission(ctx, 'session-absent')
  assert.equal(missing.available, true)
  assert.equal(missing.found, false)
  assert.equal(missing.preset, '')
  const { ctx: bare } = host()
  bare.get = () => undefined
  assert.equal(effectivePermission(bare, 'session-absent').available, false)
})

test('every selectable parent preset is snapshotted and applied after the host pin', () => {
  const { ctx, sessions, calls } = host()
  const parent = 'session-parent'
  sessions.set(parent, live(parent, 'danger-full-access'))
  try {
    for (const name of ['danger-full-access', 'workspace-write', 'read-only', 'auto'] as const) {
      clearPendingWorkerPermissions()
      const worker = `worker-${name}`
      sessions.set(parent, live(parent, name))
      sessions.set(worker, live(worker, 'workspace-write'))
      const intent = rememberWorkerPermission(ctx, worker, parent)
      assert.equal(intent?.preset, name)
      assert.equal(intent?.reason, 'ok')
      const session = sessions.get(worker)
      assert.ok(session)
      session.preset = 'workspace-write'
      session.sandbox = 'workspace-write'
      session.approval = 'ask'
      const applied = applyWorkerPermission(ctx, worker, 'startup')
      assert.equal(applied.applied, true)
      assert.equal(applied.preset, name)
      assert.equal(session.preset, name)
      assert.equal(session.sandbox, BUNDLES[name].sandbox)
      assert.equal(session.approval, BUNDLES[name].approval)
      sessions.set(parent, live(parent, name === 'read-only' ? 'danger-full-access' : 'read-only'))
      assert.equal(applyWorkerPermission(ctx, worker, 'startup').reason, 'not-pending')
      assert.equal(applyWorkerPermission(ctx, worker, 'resume').reason, 'not-pending')
      assert.equal(applyWorkerPermission(ctx, worker, 'clear').reason, 'not-pending')
      assert.equal(applyWorkerPermission(ctx, worker, 'compact').reason, 'not-pending')
      assert.equal(session.preset, name)
      assert.equal(session.sandbox, BUNDLES[name].sandbox)
      assert.equal(session.approval, BUNDLES[name].approval)
    }
    assert.deepEqual(
      calls.map(call => call.name),
      ['danger-full-access', 'workspace-write', 'read-only', 'auto'],
    )
  } finally {
    clearPendingWorkerPermissions()
  }
})

test('a later parent change and a non-creation event leave an existing worker alone', () => {
  const { ctx, sessions, calls } = host()
  const parent = 'session-parent'
  const worker = 'worker-existing'
  const unrelated = 'session-other'
  sessions.set(parent, live(parent, 'danger-full-access'))
  sessions.set(worker, live(worker, 'workspace-write'))
  sessions.set(unrelated, live(unrelated, 'workspace-write'))
  try {
    assert.equal(rememberWorkerPermission(ctx, 'session-not-a-worker', parent), null)
    assert.equal(applyWorkerPermission(ctx, unrelated, 'startup').reason, 'not-pending')
    assert.equal(applyWorkerPermission(ctx, worker, 'startup').reason, 'not-pending')
    assert.equal(sessions.get(worker)?.sandbox, 'workspace-write')
    assert.equal(sessions.get(unrelated)?.sandbox, 'workspace-write')
    assert.equal(calls.length, 0)
  } finally {
    clearPendingWorkerPermissions()
  }
})

test('resume does not consume the snapshot, and a failed create drops it', () => {
  const { ctx, sessions } = host()
  const parent = 'session-parent'
  const worker = 'worker-delayed'
  sessions.set(parent, live(parent, 'danger-full-access'))
  try {
    rememberWorkerPermission(ctx, worker, parent)
    assert.equal(applyWorkerPermission(ctx, worker, 'resume').reason, 'not-startup')
    assert.equal(pendingWorkerPermission(worker)?.preset, 'danger-full-access')
    assert.equal(applyWorkerPermission(ctx, worker, 'startup').reason, 'rejected')
    assert.equal(pendingWorkerPermission(worker)?.preset, 'danger-full-access')
    sessions.set(worker, live(worker, 'workspace-write'))
    assert.equal(applyWorkerPermission(ctx, worker, 'startup').preset, 'danger-full-access')
    assert.equal(sessions.get(worker)?.approval, 'never')
    assert.equal(pendingWorkerPermission(worker), null)

    rememberWorkerPermission(ctx, 'worker-dropped', parent)
    dropWorkerPermission('worker-dropped')
    sessions.set('worker-dropped', live('worker-dropped', 'workspace-write'))
    assert.equal(applyWorkerPermission(ctx, 'worker-dropped', 'startup').reason, 'not-pending')
    assert.equal(sessions.get('worker-dropped')?.sandbox, 'workspace-write')
  } finally {
    clearPendingWorkerPermissions()
  }
})

test('missing, custom, invalid, and unavailable parents fail closed on the host pin', () => {
  const { ctx, sessions, calls } = host()
  const parent = 'session-parent'
  sessions.set(parent, live(parent, 'workspace-write'))
  try {
    const missing = rememberWorkerPermission(ctx, 'worker-missing', 'session-absent')
    assert.equal(missing?.reason, 'missing')
    sessions.set('worker-missing', live('worker-missing'))
    assert.equal(applyWorkerPermission(ctx, 'worker-missing', 'startup').reason, 'missing')
    assert.equal(sessions.get('worker-missing')?.sandbox, 'workspace-write')
    assert.equal(sessions.get('worker-missing')?.approval, 'ask')

    sessions.get(parent)!.preset = 'custom'
    const custom = rememberWorkerPermission(ctx, 'worker-custom', parent)
    assert.equal(custom?.reason, 'custom')
    sessions.set('worker-custom', live('worker-custom'))
    assert.equal(applyWorkerPermission(ctx, 'worker-custom', 'startup').reason, 'custom')
    assert.equal(sessions.get('worker-custom')?.preset, 'workspace-write')

    sessions.get(parent)!.preset = 'nope'
    const invalid = rememberWorkerPermission(ctx, 'worker-invalid', parent)
    assert.equal(invalid?.reason, 'invalid')
    sessions.set('worker-invalid', live('worker-invalid'))
    assert.equal(applyWorkerPermission(ctx, 'worker-invalid', 'startup').reason, 'invalid')
    assert.equal(sessions.get('worker-invalid')?.sandbox, 'workspace-write')

    const bare = host()
    bare.ctx.get = () => undefined
    const unavailable = rememberWorkerPermission(bare.ctx, 'worker-unavailable', parent)
    assert.equal(unavailable?.reason, 'unavailable')
    assert.equal(applyWorkerPermission(bare.ctx, 'worker-unavailable', 'startup').reason, 'unavailable')
    assert.equal(calls.length, 0)
    assert.equal(
      calls.some(call => call.name === 'danger-full-access'),
      false,
    )
  } finally {
    clearPendingWorkerPermissions()
  }
})

test('foundations_dispatch inherits the parent after the host pin and leaves everyone else alone', async () => {
  clearPendingWorkerPermissions()
  const dir = mkdtempSync(join(tmpdir(), 'worker-perm-dispatch-'))
  const dataDir = join(dir, 'data')
  const parentId = 'session-parent'
  const sessions = new Map<string, LiveSession>()
  const agents = new Map<string, Record<string, unknown>>()
  const calls: Array<{ id: string; name: string }> = []
  const created: Array<{ sessionId?: string; meta?: { agentPreset?: string } }> = []
  const order: string[] = []
  const seenAfterPin: Array<{ id: string; preset: string; sandbox: string; approval: string }> = []
  const fresh = new Set<string>()
  const pinned = new Set<string>()
  let settingsReads = 0
  let settingsUpdates = 0
  let emitOnCreate = true
  let failCreate = false
  const listeners: Array<{ event: string; fn: (payload: any) => unknown; prepend: boolean }> = []
  const disposers: Array<() => void> = []

  function place(id: string, preset: string) {
    const events: Array<{ type: string; seq: number; data?: { inserted?: Array<{ id?: string }> } }> = []
    const session = live(id, preset)
    session.snapshotEvents = () => events
    const agent = {
      id,
      session,
      followup(message: { id?: string }) {
        events.push({
          type: 'agent/inbox/spliced',
          seq: events.length + 1,
          data: { inserted: [{ id: message?.id }] },
        })
      },
      steer(message: { id?: string }) {
        this.followup(message)
      },
      cancel() {},
      inbox: { nextTurn: [] as Array<{ id?: string }> },
      model: { current: () => null },
    }
    sessions.set(id, session)
    agents.set(id, agent)
    return agent
  }

  const service = {
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
        { value: 'auto', name: 'Auto' },
        { value: 'custom', name: 'Custom' },
      ],
      defaultOptions: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
      defaultPreset: 'workspace-write',
    }),
    current: (session: LiveSession) => session.preset,
    set(session: LiveSession, name: string) {
      const bundle = BUNDLES[name]
      if (!bundle) throw new Error(`permission: unknown preset "${name}"`)
      session.preset = name
      session.sandbox = bundle.sandbox
      session.approval = bundle.approval
      calls.push({ id: session.id, name })
      if (session.id.startsWith('worker-')) order.push(`inherit:${session.id}`)
    },
  }

  listeners.push({
    event: 'agent/created',
    prepend: true,
    fn: payload => {
      const id = payload?.agent?.id
      if (typeof id !== 'string') return
      order.push(`host-pin:${id}`)
      if (payload?.source !== 'startup' || !fresh.has(id) || pinned.has(id)) return
      pinned.add(id)
      const session = sessions.get(id)
      if (!session) return
      session.preset = 'workspace-write'
      session.sandbox = 'workspace-write'
      session.approval = 'ask'
    },
  })

  const presets = {
    async register(spec: { id: string }) {
      return spec
    },
    async mount() {},
    presetForSession() {
      return null
    },
    async resolve(id: string) {
      return { id }
    },
    defaultId: null,
  }
  const ctx = {
    profileContext: { dir },
    systemPrompt: {
      section() {
        return () => {}
      },
      context() {
        return () => {}
      },
    },
    tools: {
      register(entry: { name: string; execute?: (args: any, exec: any) => Promise<any> }) {
        tools.push(entry)
        return () => {}
      },
    },
    on(event: string, fn: (payload: any) => unknown, options?: boolean | { prepend?: boolean }) {
      const prepend = typeof options === 'object' && options?.prepend === true
      listeners.push({ event, fn, prepend })
      return () => {}
    },
    effect(fn: () => unknown) {
      const done = fn()
      if (typeof done === 'function') disposers.push(done as () => void)
    },
    logger: { info() {}, warn() {} },
    webServer: null,
    get(name: string) {
      if (name === 'permissionPresets') return service
      if (name === 'sessions') return ctx.sessions
      if (name === 'agentPresets') return presets
      if (name === 'settings') {
        settingsReads += 1
        return {
          update() {
            settingsUpdates += 1
          },
        }
      }
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      async create(options: { sessionId: string; meta?: { agentPreset?: string } }) {
        if (failCreate) throw new Error('create failed')
        created.push(options)
        fresh.add(options.sessionId)
        place(options.sessionId, 'workspace-write')
        if (emitOnCreate) {
          await emit('agent/created', { agent: agents.get(options.sessionId), source: 'startup' })
        }
        return { agent: agents.get(options.sessionId), dispose() {} }
      },
    },
    sessions: {
      get: (id: string) => sessions.get(id),
      async flush() {
        return true
      },
    },
    agentPresets: presets,
  }
  const tools: Array<{ name: string; execute?: (args: any, exec: any) => Promise<any> }> = []

  async function emit(event: string, payload: unknown) {
    const matched = listeners.filter(listener => listener.event === event)
    const ordered = [...matched.filter(listener => listener.prepend), ...matched.filter(listener => !listener.prepend)]
    for (const listener of ordered) await listener.fn(payload)
  }

  place(parentId, 'danger-full-access')
  const plugin = await import('../src/index.ts')
  plugin.apply(ctx as never, {
    dataDir,
    work: { perBot: 16, global: 16, perBotQueue: 16, globalQueue: 16 },
    budgetNotice: false,
  })
  listeners.push({
    event: 'agent/created',
    prepend: false,
    fn: payload => {
      const id = payload?.agent?.id
      if (typeof id !== 'string' || !id.startsWith('worker-')) return
      const session = sessions.get(id)
      if (!session) return
      seenAfterPin.push({ id, preset: session.preset, sandbox: session.sandbox, approval: session.approval })
      order.push(`after:${id}`)
    },
  })

  function mark(sessionId: string) {
    const store = openStore(dataDir)
    try {
      createEngine(store).markBot(sessionId)
    } finally {
      store.close()
    }
  }
  mark(parentId)

  async function dispatch(briefing: string, key: string, owner = parentId) {
    const tool = tools.find(entry => entry.name === 'foundations_dispatch')
    assert.ok(tool?.execute)
    return tool.execute({ briefing, idempotencyKey: key }, { agent: { id: owner } })
  }

  function workerOf(result: { childSessionId?: string | null }) {
    assert.equal(typeof result.childSessionId, 'string')
    const session = sessions.get(result.childSessionId ?? '')
    assert.ok(session)
    return session
  }

  try {
    const full = await dispatch('list /root/project/floor', 'floor-1')
    assert.equal(full.ok, true)
    const fullWorker = workerOf(full)
    assert.equal(fullWorker.preset, 'danger-full-access')
    assert.equal(fullWorker.sandbox, 'danger-full-access')
    assert.equal(fullWorker.approval, 'never')
    assert.equal(created[0]?.meta?.agentPreset, 'foundations-files')
    const fullId = full.childSessionId as string
    assert.deepEqual(
      order.filter(item => item.endsWith(fullId)),
      [`host-pin:${fullId}`, `inherit:${fullId}`, `after:${fullId}`],
    )
    assert.equal(seenAfterPin.find(item => item.id === fullId)?.preset, 'danger-full-access')
    assert.equal(seenAfterPin.find(item => item.id === fullId)?.approval, 'never')

    sessions.get(parentId)!.preset = 'read-only'
    sessions.get(parentId)!.sandbox = 'read-only'
    sessions.get(parentId)!.approval = 'ask'
    await emit('agent/created', { agent: { id: fullId }, source: 'resume' })
    assert.equal(fullWorker.preset, 'danger-full-access')
    assert.equal(fullWorker.approval, 'never')
    const replay = await dispatch('list /root/project/floor', 'floor-1')
    assert.equal(replay.childSessionId, fullId)
    assert.equal(replay.replayed, true)
    assert.equal(fullWorker.sandbox, 'danger-full-access')
    assert.equal(calls.filter(call => call.id === fullId).length, 1)

    sessions.get(parentId)!.preset = 'workspace-write'
    sessions.get(parentId)!.sandbox = 'workspace-write'
    sessions.get(parentId)!.approval = 'ask'
    const wrote = await dispatch('stay inside the workspace', 'floor-2')
    const wroteWorker = workerOf(wrote)
    assert.equal(wroteWorker.preset, 'workspace-write')
    assert.equal(wroteWorker.sandbox, 'workspace-write')
    assert.equal(wroteWorker.approval, 'ask')
    assert.equal(created.at(-1)?.meta?.agentPreset, 'foundations-files')
    assert.equal(fullWorker.preset, 'danger-full-access')

    const { setDefaultPermission } = await import('../src/permission-default.ts')
    const saved = setDefaultPermission(ctx as never, permissionDefaultFile(dataDir), 'read-only')
    assert.equal(saved.ok, true)
    const followedParent = await dispatch('parent stays workspace-write', 'floor-3')
    const followed = workerOf(followedParent)
    assert.equal(followed.preset, 'workspace-write')
    assert.equal(followed.approval, 'ask')
    assert.equal(calls.filter(call => call.id === followedParent.childSessionId).at(-1)?.name, 'workspace-write')

    sessions.get(parentId)!.preset = 'read-only'
    sessions.get(parentId)!.sandbox = 'read-only'
    sessions.get(parentId)!.approval = 'ask'
    const readonly = workerOf(await dispatch('only read', 'floor-4'))
    assert.equal(readonly.preset, 'read-only')
    assert.equal(readonly.sandbox, 'read-only')
    assert.equal(readonly.approval, 'ask')

    sessions.get(parentId)!.preset = 'auto'
    sessions.get(parentId)!.sandbox = 'danger-full-access'
    sessions.get(parentId)!.approval = 'ask'
    const auto = workerOf(await dispatch('review each call', 'floor-5'))
    assert.equal(auto.preset, 'auto')
    assert.equal(auto.sandbox, 'danger-full-access')
    assert.equal(auto.approval, 'ask')

    sessions.get(parentId)!.preset = 'danger-full-access'
    sessions.get(parentId)!.sandbox = 'danger-full-access'
    sessions.get(parentId)!.approval = 'never'
    const canvas = await dispatch('Canvas preview cnv_abcdefghijklmnop. build the page', 'canvas-1')
    const canvasWorker = workerOf(canvas)
    assert.equal(created.at(-1)?.meta?.agentPreset, 'foundations-canvas')
    assert.equal(canvasWorker.preset, 'danger-full-access')
    assert.equal(canvasWorker.approval, 'never')

    mark('session-ghost')
    const ghost = await dispatch('look around', 'ghost-1', 'session-ghost')
    const ghostWorker = workerOf(ghost)
    assert.equal(ghostWorker.preset, 'workspace-write')
    assert.equal(ghostWorker.sandbox, 'workspace-write')
    assert.equal(ghostWorker.approval, 'ask')
    assert.equal(
      calls.some(call => call.id === ghost.childSessionId),
      false,
    )

    sessions.get(parentId)!.preset = 'custom'
    const custom = workerOf(await dispatch('custom knobs', 'custom-1'))
    assert.equal(custom.preset, 'workspace-write')
    assert.equal(custom.approval, 'ask')
    sessions.get(parentId)!.preset = 'nope'
    const invalid = workerOf(await dispatch('unknown preset', 'invalid-1'))
    assert.equal(invalid.preset, 'workspace-write')
    assert.equal(invalid.sandbox, 'workspace-write')

    const oldId = 'worker-already-there'
    place(oldId, 'workspace-write')
    await emit('agent/created', { agent: { id: oldId }, source: 'startup' })
    await emit('agent/created', { agent: { id: oldId }, source: 'resume' })
    assert.equal(sessions.get(oldId)?.preset, 'workspace-write')
    assert.equal(sessions.get(oldId)?.approval, 'ask')
    assert.equal(
      calls.some(call => call.id === oldId),
      false,
    )

    emitOnCreate = false
    sessions.get(parentId)!.preset = 'danger-full-access'
    sessions.get(parentId)!.sandbox = 'danger-full-access'
    sessions.get(parentId)!.approval = 'never'
    const late = await dispatch('apply after create returns', 'late-1')
    const lateWorker = workerOf(late)
    const lateId = late.childSessionId as string
    assert.equal(
      order.some(item => item === `host-pin:${lateId}`),
      false,
    )
    assert.equal(lateWorker.preset, 'danger-full-access')
    assert.equal(lateWorker.sandbox, 'danger-full-access')
    assert.equal(lateWorker.approval, 'never')
    assert.equal(
      seenAfterPin.some(item => item.id === lateId),
      false,
    )

    failCreate = true
    const failed = await dispatch('do not attach', 'fail-1')
    assert.equal(failed.childSessionId, null)
    const probe = openStore(dataDir)
    try {
      const row = probe.db
        .prepare('SELECT id, child_session_id FROM work_tickets WHERE idempotency_key = ?')
        .get('fail-1') as { id: string; child_session_id: string | null }
      assert.equal(row.child_session_id, null)
      const failedId = `worker-${row.id}`
      assert.equal(pendingWorkerPermission(failedId), null)
      place(failedId, 'workspace-write')
      await emit('agent/created', { agent: { id: failedId }, source: 'startup' })
      assert.equal(sessions.get(failedId)?.preset, 'workspace-write')
      assert.equal(
        calls.some(call => call.id === failedId),
        false,
      )
    } finally {
      probe.close()
    }

    const freshMain = 'session-fresh-main'
    place(freshMain, 'workspace-write')
    mark(freshMain)
    assert.equal(rememberFreshMain(permissionDefaultFile(dataDir), freshMain), true)
    await emit('agent/created', { agent: agents.get(freshMain), source: 'startup' })
    assert.equal(sessions.get(freshMain)?.preset, 'read-only')
    assert.equal(sessions.get(freshMain)?.sandbox, 'read-only')
    assert.equal(sessions.get(freshMain)?.approval, 'ask')
    assert.equal(fullWorker.preset, 'danger-full-access')
    const savedState = readPermissionDefault(permissionDefaultFile(dataDir))
    assert.equal(savedState.stored, 'read-only')
    assert.equal(
      savedState.pending.some(id => id.startsWith('worker-')),
      false,
    )
    assert.equal(savedState.pending.includes(freshMain), false)

    const plain = 'session-plain'
    place(plain, 'workspace-write')
    await emit('agent/created', { agent: { id: plain }, source: 'startup' })
    assert.equal(sessions.get(plain)?.preset, 'workspace-write')
    assert.equal(
      calls.some(call => call.id === plain),
      false,
    )
    assert.equal(settingsReads, 0)
    assert.equal(settingsUpdates, 0)
  } finally {
    failCreate = false
    for (const dispose of disposers) dispose()
    clearPendingWorkerPermissions()
    rmSync(dir, { recursive: true, force: true })
  }
})
