import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createMemoryCheckpoint } from './checkpoint.ts'
import { createEventLogReader } from './reader.ts'
import type { BoundedTransport, LiveTransport, TransportOutcome } from './transport.ts'
import type { LogEvent } from './types.ts'
import type { ResumeInfo } from './resume.ts'

function ev(seq: number): LogEvent {
  return { type: 'user/message', seq, time: seq, data: { id: `m${seq}` } }
}

function followFrom(firstSeq: number, cursor: number, tail: LogEvent[] = []): LiveTransport {
  return {
    kind: 'ws-follow',
    async open(_req, sink, signal) {
      sink.opened({ firstSeq, cursor, hasMore: firstSeq > 0 })
      sink.head(cursor)
      const records = Array.from({ length: Math.max(0, cursor - firstSeq + 1) }, (_, i) => ev(firstSeq + i))
      if (records.length) sink.events(records)
      for (const event of tail) sink.events([event])
      await wait(5, signal).catch(() => {})
      return { ok: false, retryable: true, code: 'FOLLOW_CLOSED' }
    },
  }
}

function pageTransport(events: LogEvent[], hits: number[] = []): BoundedTransport {
  return {
    kind: 'official-page',
    async fetch(req, sink) {
      hits.push(1)
      const batch = events.filter(event => event.seq > req.afterSeq && event.seq <= req.throughSeq)
      if (batch.length) sink.events(batch, { throughSeq: req.throughSeq })
      return { ok: true, throughSeq: req.throughSeq }
    },
  }
}

function failingEnhance(code: string, statusHits?: number[]): BoundedTransport {
  return {
    kind: 'cdc-snapshot',
    async fetch() {
      statusHits?.push(1)
      return { ok: false, retryable: false, code }
    },
  }
}

test('enhancement off fills the gap with the official page and stays off error', async () => {
  const history = Array.from({ length: 8 }, (_, seq) => ev(seq))
  const pageHits: number[] = []
  const received: number[] = []
  const phases: string[] = []
  const reader = createEventLogReader({
    follow: followFrom(6, 7),
    page: pageTransport(history, pageHits),
    checkpoint: createMemoryCheckpoint(),
    wait: yieldWait,
    raf: cb => {
      cb()
      return 1
    },
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    sub.onStatus(status => phases.push(status.phase))
    const ready = await sub.ready
    assert.equal(ready.ok, true)
    if (ready.ok) assert.equal(ready.caughtUpTo >= 6, true)
    assert.ok(pageHits.length >= 1)
    assert.ok(received.includes(0) && received.includes(7))
    assert.ok(!phases.includes('error'))
    assert.notEqual(sub.status.phase, 'error')
  } finally {
    sub.close()
  }
})

test('a mid-sync 404 from CDC falls back to official page and does not error the subscription', async () => {
  // Gap must exceed RANGE_MAX_EVENTS so the reader chooses CDC over range/page.
  const head = 2010
  const history = Array.from({ length: head + 1 }, (_, seq) => ev(seq))
  const pageHits: number[] = []
  const cdcHits: number[] = []
  const received: number[] = []
  const reader = createEventLogReader({
    follow: followFrom(head, head),
    page: pageTransport(history, pageHits),
    cdc: failingEnhance('ENHANCE_UNAVAILABLE', cdcHits),
    range: failingEnhance('ENHANCE_UNAVAILABLE'),
    checkpoint: createMemoryCheckpoint(),
    probe: async () => true,
    wait: yieldWait,
    raf: cb => {
      cb()
      return 1
    },
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'auto' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    const ready = await withTimeout(sub.ready, 2000)
    assert.equal(ready.ok, true)
    assert.ok(cdcHits.length >= 1)
    assert.ok(pageHits.length >= 1)
    assert.ok(received.includes(0) && received.includes(head))
    assert.notEqual(sub.status.phase, 'error')
  } finally {
    sub.close()
  }
})

// ---- page resume (background tab) ----

type FollowScript = (
  call: number,
  sink: Parameters<LiveTransport['open']>[1],
  signal: AbortSignal,
) => Promise<TransportOutcome>

function scriptedFollow(script: FollowScript) {
  const calls: number[] = []
  const follow: LiveTransport = {
    kind: 'ws-follow',
    open(_req, sink, signal) {
      calls.push(calls.length)
      return script(calls.length, sink, signal)
    },
  }
  return { follow, calls }
}

/** Opening frame like official follow: last `opening` events of `log` plus cursor. */
function openFrom(log: LogEvent[], sink: Parameters<LiveTransport['open']>[1], opening: number, alive?: () => boolean) {
  const cursor = log.length - 1
  const records = log.slice(Math.max(0, log.length - opening))
  const firstSeq = records.length ? records[0]!.seq : cursor + 1
  sink.opened({ firstSeq, cursor, hasMore: firstSeq > 0, ...(alive ? { alive } : {}) })
  sink.head(cursor)
  if (records.length) sink.events(records)
}

/** A socket that never sends another frame and never fires close: only an abort ends it. */
function hangUntilAborted(signal: AbortSignal): Promise<TransportOutcome> {
  return new Promise(resolve => {
    if (signal.aborted) resolve({ ok: false, retryable: false, code: 'ABORTED' })
    else
      signal.addEventListener('abort', () => resolve({ ok: false, retryable: false, code: 'ABORTED' }), { once: true })
  })
}

function resumeHook() {
  let fire: ((info: ResumeInfo) => void) | null = null
  return {
    onResume(cb: (info: ResumeInfo) => void) {
      fire = cb
      return () => {
        fire = null
      }
    },
    resume(info: ResumeInfo) {
      assert.ok(fire, 'reader did not subscribe to resume')
      fire!(info)
    },
  }
}

/** Short waits (waitFor polling) yield; long waits (backoff/poll) resolve fast or hang until aborted. */
function controlledWait() {
  const state = { mode: 'fast' as 'fast' | 'hang', longWaits: 0 }
  const fn = async (ms: number, signal: AbortSignal) => {
    if (ms <= 5 || state.mode === 'fast') {
      if (ms > 5) state.longWaits += 1
      await new Promise(resolve => setTimeout(resolve, 0))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return
    }
    state.longWaits += 1
    await new Promise<void>((_, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  return { state, fn }
}

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`condition not met in ${ms}ms`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function assertExactly(received: number[], through: number) {
  assert.deepEqual(
    received,
    Array.from({ length: through + 1 }, (_, seq) => seq),
    'every seq delivered once, in order',
  )
}

const syncRaf = {
  raf: (cb: () => void) => {
    cb()
    return 1
  },
  cancelRaf() {},
}

test('resume after a silent dead socket reopens follow and fills the gap without loss or duplicates', async () => {
  const log = Array.from({ length: 5 }, (_, seq) => ev(seq))
  const pageHits: number[] = []
  const hook = resumeHook()
  const { follow, calls } = scriptedFollow(async (_call, sink, signal) => {
    openFrom(log, sink, 5)
    // Socket goes silent: no frames, no close event (backgrounded/suspended tab, idle proxy).
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: {
      kind: 'official-page',
      async fetch(req, sink) {
        pageHits.push(req.afterSeq)
        const batch = log.filter(event => event.seq > req.afterSeq && event.seq <= req.throughSeq)
        if (batch.length) sink.events(batch)
        return { ok: true, throughSeq: req.throughSeq }
      },
    },
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: hook.onResume,
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await withTimeout(sub.ready, 2000)
    assertExactly(received, 4)
    // The session keeps running while the tab is away: seq 5..14 are written, none reach the dead socket.
    for (let seq = 5; seq < 15; seq += 1) log.push(ev(seq))
    await new Promise(resolve => setTimeout(resolve, 20))
    assertExactly(received, 4)
    assert.equal(calls.length, 1)
    hook.resume({ reason: 'visible', hiddenMs: 60_000 })
    await until(() => received.length >= 15)
    await until(() => sub.status.phase === 'live')
    assertExactly(received, 14)
    assert.equal(calls.length, 2, 'follow reopened exactly once')
    assert.ok(pageHits.includes(4), 'gap (4, F-1] filled from the official page')
    assert.equal(sub.status.appliedSeq, 14)
    // A second resume right away is debounced.
    hook.resume({ reason: 'focus', hiddenMs: 60_000 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 2)
  } finally {
    sub.close()
  }
})

test('resume on focus reopens follow when the socket reports it is no longer open', async () => {
  const log = Array.from({ length: 3 }, (_, seq) => ev(seq))
  const hook = resumeHook()
  let open = true
  const { follow, calls } = scriptedFollow(async (_call, sink, signal) => {
    open = true
    openFrom(log, sink, 1, () => open)
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: pageTransport(log),
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: hook.onResume,
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await withTimeout(sub.ready, 2000)
    hook.resume({ reason: 'focus', hiddenMs: 0 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'a healthy socket is left alone on a plain focus')
    log.push(ev(3), ev(4))
    open = false
    hook.resume({ reason: 'focus', hiddenMs: 0 })
    await until(() => received.length >= 5 && sub.status.phase === 'live')
    assertExactly(received, 4)
    assert.equal(calls.length, 2)
  } finally {
    sub.close()
  }
})

test('resume during reconnect backoff reconnects immediately', async () => {
  const log = Array.from({ length: 4 }, (_, seq) => ev(seq))
  const hook = resumeHook()
  const waits = controlledWait()
  waits.state.mode = 'hang'
  let failNext = 1
  const { follow, calls } = scriptedFollow(async (_call, sink, signal) => {
    if (failNext > 0) {
      failNext -= 1
      return { ok: false, retryable: true, code: 'FOLLOW_CLOSED' }
    }
    openFrom(log, sink, 2)
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: pageTransport(log),
    checkpoint: createMemoryCheckpoint(),
    wait: waits.fn,
    onResume: hook.onResume,
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await until(() => calls.length === 1 && waits.state.longWaits === 1)
    // Stuck in a backoff wait that (in this test) never ends on its own.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 1)
    assert.equal(received.length, 0)
    hook.resume({ reason: 'visible', hiddenMs: 0 })
    const ready = await withTimeout(sub.ready, 2000)
    assert.equal(ready.ok, true)
    assert.equal(calls.length, 2)
    assertExactly(received, 3)
    assert.equal(sub.status.phase, 'live')
  } finally {
    sub.close()
  }
})

test('resume while degraded to polling resets backoff and goes back to live follow', async () => {
  const log = Array.from({ length: 6 }, (_, seq) => ev(seq))
  const hook = resumeHook()
  const waits = controlledWait()
  const pageHits: number[] = []
  let followUp = false
  const phases: string[] = []
  const { follow, calls } = scriptedFollow(async (_call, sink, signal) => {
    if (!followUp) return { ok: false, retryable: true, code: 'FOLLOW_ERROR' }
    openFrom(log, sink, 1)
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: {
      kind: 'official-page',
      async fetch(req, sink) {
        pageHits.push(req.afterSeq)
        const batch = log.filter(event => event.seq > req.afterSeq && event.seq <= req.throughSeq)
        if (batch.length) sink.events(batch)
        return { ok: true, throughSeq: req.throughSeq }
      },
    },
    checkpoint: createMemoryCheckpoint(),
    wait: waits.fn,
    onResume: hook.onResume,
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    sub.onStatus(status => phases.push(status.phase))
    // Three follow failures put the reader in degraded polling mode.
    await until(() => calls.length >= 3 && pageHits.length >= 1)
    assert.ok(phases.includes('stalled'))
    waits.state.mode = 'hang'
    const before = calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    followUp = true
    log.push(ev(6), ev(7))
    hook.resume({ reason: 'online', hiddenMs: 0 })
    await until(() => sub.status.phase === 'live' && received.length >= 8)
    assert.ok(calls.length > before, 'follow reopened after resume')
    assertExactly(received, 7)
  } finally {
    sub.close()
  }
})

test('batches queued while rAF is paused are flushed on resume', async () => {
  const log = Array.from({ length: 3 }, (_, seq) => ev(seq))
  const hook = resumeHook()
  const { follow } = scriptedFollow(async (_call, sink, signal) => {
    openFrom(log, sink, 3)
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: pageTransport(log),
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: hook.onResume,
    livenessMs: false,
    // rAF never fires, like a background tab.
    raf: () => 7,
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await withTimeout(sub.ready, 2000)
    assert.equal(received.length, 0)
    hook.resume({ reason: 'visible', hiddenMs: 0 })
    assertExactly(received, 2)
  } finally {
    sub.close()
  }
})

test('while hidden, delivery uses a timer instead of rAF', async () => {
  const log = Array.from({ length: 3 }, (_, seq) => ev(seq))
  const { follow } = scriptedFollow(async (_call, sink, signal) => {
    openFrom(log, sink, 3)
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: pageTransport(log),
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: () => () => {},
    livenessMs: false,
    isHidden: () => true,
    raf: () => 7,
    cancelRaf() {},
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await withTimeout(sub.ready, 2000)
    await until(() => received.length === 3)
    assertExactly(received, 2)
  } finally {
    sub.close()
  }
})

test('a retryable gap failure retries instead of going live with a hole', async () => {
  const log = Array.from({ length: 10 }, (_, seq) => ev(seq))
  let pageFailures = 1
  const { follow, calls } = scriptedFollow(async (_call, sink, signal) => {
    openFrom(log, sink, 2)
    return hangUntilAborted(signal)
  })
  const phases: string[] = []
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: {
      kind: 'official-page',
      async fetch(req, sink) {
        if (pageFailures > 0) {
          pageFailures -= 1
          return { ok: false, retryable: true, code: 'PAGE_ERROR' }
        }
        const batch = log.filter(event => event.seq > req.afterSeq && event.seq <= req.throughSeq)
        if (batch.length) sink.events(batch)
        return { ok: true, throughSeq: req.throughSeq }
      },
    },
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: () => () => {},
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    sub.onStatus(status => phases.push(status.phase))
    const ready = await withTimeout(sub.ready, 2000)
    assert.equal(ready.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(phases.indexOf('live') > phases.indexOf('stalled'), true)
    assertExactly(received, 9)
  } finally {
    sub.close()
  }
})

test('live follow events after open keep flowing with an inline scheduler and head tracks applied', async () => {
  const log = Array.from({ length: 3 }, (_, seq) => ev(seq))
  let push: ((event: LogEvent) => void) | null = null
  const { follow } = scriptedFollow(async (_call, sink, signal) => {
    openFrom(log, sink, 3)
    push = event => sink.events([event])
    return hangUntilAborted(signal)
  })
  const received: number[] = []
  const reader = createEventLogReader({
    follow,
    page: pageTransport(log),
    checkpoint: createMemoryCheckpoint(),
    wait: controlledWait().fn,
    onResume: () => () => {},
    livenessMs: false,
    ...syncRaf,
  })
  const sub = reader.open('s', { enhancement: 'off' })
  try {
    sub.onBatch(batch => received.push(...batch.events.map(event => event.seq)))
    await withTimeout(sub.ready, 2000)
    for (let seq = 3; seq < 8; seq += 1) push!(ev(seq))
    assertExactly(received, 7)
    assert.equal(sub.status.headSeq, 7)
    assert.equal(sub.status.lag, 0)
  } finally {
    sub.close()
  }
})

async function yieldWait(_ms: number, signal: AbortSignal) {
  await Promise.resolve()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}`)), ms)),
  ])
}
