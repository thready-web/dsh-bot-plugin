import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createInteractionSync, createAuthorizationCatalog } from './interaction-sync.ts'

const idle = {
  ok: true,
  sessionId: 'one',
  questions: [],
  approvals: [],
  authorization: { available: true, catalogRevision: 1, inFlight: [], prompts: [], notices: [] },
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function clock() {
  let now = 0
  let id = 0
  const tasks = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const key = ++id
      tasks.set(key, { at: now + ms, fn })
      return () => {
        tasks.delete(key)
      }
    },
    async advance(ms: number) {
      const until = now + ms
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        tasks.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = until
    },
  }
}

test('connected idle uses two compact GETs in 60s instead of the former 41, with immediate relevant SSE updates', async t => {
  const timer = clock()
  let requests = 0
  const applied: unknown[] = []
  const sync = createInteractionSync({
    fetch: async () => {
      requests++
      return idle
    },
    apply: value => applied.push(value),
    schedule: timer.schedule,
  })
  await flush()
  sync.ingest(idle)
  await timer.advance(60_000)
  assert.equal(requests, 2)
  assert.equal(1 + Math.floor(60_000 / 1500), 41)
  assert.equal(applied.length, 1, 'unchanged snapshots do not trigger React updates')
  const active = {
    ...idle,
    questions: [{ callId: 'ask', timed: true, waitState: 'counting', remainingMs: 5000 }],
    approvals: [{ requestId: 'approval', state: 'open' }],
    authorization: {
      ...idle.authorization,
      prompts: [{ promptId: 'secret', kind: 'secret' }],
      notices: [{ message: 'Browser login' }],
    },
  }
  sync.ingest(active)
  assert.equal(applied.at(-1), active)
  sync.close()
  t.diagnostic(`60s idle REST requests: old=41, connected compact=2; applied snapshots=${applied.length}`)
})

test('old host/disconnect uses bounded fallback; reconnect stops fast polling and keeps active fallback responsive', async t => {
  const timer = clock()
  let requests = 0
  const sync = createInteractionSync({
    fetch: async () => {
      requests++
      return idle
    },
    apply() {},
    schedule: timer.schedule,
  })
  await flush()
  await timer.advance(60_000)
  assert.equal(requests, 6, 'unsupported SSE must still reconcile, with a 15s maximum interval')
  t.diagnostic(`60s unsupported-host REST requests=${requests}`)
  sync.ingest(idle)
  const before = requests
  await timer.advance(59_999)
  assert.equal(requests, before)
  sync.disconnected()
  await timer.advance(2000)
  assert.equal(requests, before + 1)
  sync.close()
  const activeTimer = clock()
  let activeRequests = 0
  const active = createInteractionSync({
    fetch: async () => {
      activeRequests++
      return idle
    },
    active: () => true,
    apply() {},
    schedule: activeTimer.schedule,
  })
  await flush()
  await activeTimer.advance(6000)
  assert.equal(activeRequests, 5, 'open questions/approvals/prompts retain 1.5s fallback')
  active.close()
})

test('single-flight REST cannot overwrite newer SSE or update after session switch; hidden views pause and resume', async () => {
  const timer = clock()
  let resolve: (value: unknown) => void = () => {}
  let requests = 0
  const applied: unknown[] = []
  const sync = createInteractionSync({
    fetch: () => {
      requests++
      return new Promise(done => {
        resolve = done
      })
    },
    apply: value => applied.push(value),
    schedule: timer.schedule,
  })
  sync.ingest({ ...idle, questions: [{ callId: 'newer' }] })
  const latest = applied[0]
  resolve(idle)
  await flush()
  assert.equal(applied.at(-1), latest)
  sync.setVisible(false)
  await timer.advance(120_000)
  assert.equal(requests, 1)
  sync.setVisible(true)
  assert.equal(requests, 2)
  void sync.refresh()
  void sync.refresh()
  assert.equal(requests, 2, 'overlapping invalidations coalesce')
  sync.close()
  resolve({ ...idle, sessionId: 'stale' })
  await flush()
  assert.equal(applied.at(-1), latest)
  const hidden = createInteractionSync({
    visible: false,
    fetch: async () => {
      requests++
      return idle
    },
    apply() {},
    schedule: timer.schedule,
  })
  await timer.advance(60_000)
  assert.equal(requests, 2)
  hidden.setVisible(true)
  await flush()
  assert.equal(requests, 3)
  hidden.close()
})

test('catalog is lazy, single-flight and cached; TTL, flow invalidation and separate App instances revalidate', async () => {
  let reads = 0
  let now = 0
  const cache = createAuthorizationCatalog(
    async () => {
      reads++
      return { entries: ['provider'] }
    },
    () => now,
  )
  assert.equal(reads, 0)
  await Promise.all([cache.get(), cache.get()])
  assert.equal(reads, 1)
  await cache.get()
  assert.equal(reads, 1)
  now = 30_000
  await cache.get()
  assert.equal(reads, 2)
  cache.invalidate()
  await cache.get()
  assert.equal(reads, 3)
  const other = createAuthorizationCatalog(async () => {
    reads++
    return {}
  })
  await other.get()
  assert.equal(reads, 4)
})

test('catalog invalidation during a pending read never returns a stale generation', async () => {
  const resolves: Array<(value: Record<string, unknown>) => void> = []
  const cache = createAuthorizationCatalog(() => new Promise(done => resolves.push(done)))
  const first = cache.get()
  cache.invalidate()
  const second = cache.get()
  resolves[0]!({ entries: ['stale'] })
  await flush()
  assert.equal(resolves.length, 2)
  resolves[1]!({ entries: ['current'] })
  assert.deepEqual(await first, { entries: ['current'] })
  assert.deepEqual(await second, { entries: ['current'] })
})

test('a stalled compact request is aborted at 10s and fallback can make progress', async () => {
  const timer = clock()
  const signals: AbortSignal[] = []
  const sync = createInteractionSync({
    fetch: signal => {
      signals.push(signal)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    },
    apply() {},
    schedule: timer.schedule,
  })
  await timer.advance(10_000)
  assert.equal(signals[0]!.aborted, true)
  await timer.advance(4000)
  assert.equal(signals.length, 2)
  sync.close()
  await flush()
  assert.equal(signals[1]!.aborted, true)
})
