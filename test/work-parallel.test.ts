import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import test from 'node:test'
import { openStore } from '../src/store.ts'
import { createEngine } from '../src/engine.ts'
import { createMockWorld } from '../src/work-mock.ts'
import { createWorkRuntime } from '../src/work-worker.ts'
import { DEFAULT_WORK_BUDGET } from '../src/work-admit.ts'
import { RESERVE_WALL_MS } from '../src/work-tickets.ts'
import { field } from './narrow.ts'

/**
 * Slot/queue scheduling. These cases call the runtime through the mock host.
 * They are not a model deciding, and they are not a real DSH process.
 */
function boot(budget?: Partial<typeof DEFAULT_WORK_BUDGET>) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-parallel-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const world = createMockWorld()
  const clock = { ms: Date.parse('2026-11-08T00:00:00.000Z') }
  const work = createWorkRuntime(store, engine, {
    createChild: spec => world.createChild(spec),
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    remove: (sessionId, messageId) => world.remove(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: sessionId => world.snapshot(sessionId),
    childPresent: sessionId => world.hasSession(sessionId),
    now: () => new Date(clock.ms),
    pid: 42,
    schedule: (fn, _ms) => {
      return () => {}
    },
    ...(budget ? { budget } : {}),
  })
  engine.markBot('bot-a')
  return { dir, store, engine, world, work, clock, close: () => store.close() }
}

/**
 * Assert `work` finishes without waiting on a blocked createChild.
 * Wall-clock bounds are flaky under a full `npm test` load.
 */
async function assertUnblocked<T>(work: Promise<T>, blocked: Promise<unknown>, label: string): Promise<T> {
  let blockedWon = false
  const blockWatch = blocked.then(() => {
    blockedWon = true
    return 'blocked' as const
  })
  const outcome = await Promise.race([
    work.then(value => ({ ok: 'work' as const, value })),
    blockWatch.then(() => ({ ok: 'blocked' as const, value: undefined as unknown as T })),
    new Promise<{ ok: 'timeout'; value: undefined }>(resolve => {
      setTimeout(() => resolve({ ok: 'timeout', value: undefined }), 5000)
    }),
  ])
  assert.equal(outcome.ok, 'work', `${label} (${outcome.ok})`)
  assert.equal(blockedWon, false, label)
  return (outcome as { ok: 'work'; value: T }).value
}

function running(ctx: any, ticketId: string) {
  const detail = ctx.work.detail(ticketId)
  const ticket = detail!.ticket
  const noTurnEnd = !ticket.child_session_id
    ? true
    : ctx.world.events(ticket.child_session_id).every((event: any) => event!.type !== 'turn/end')
  return { ticket, noTurnEnd, pending: ticket.child_session_id ? ctx.world.pendingIds(ticket.child_session_id) : [] }
}

test('same bot two workers overlap in the mock host, not merely two accepted rows', async () => {
  const ctx = boot()
  const inflight: string[] = []
  const world = createMockWorld()
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      inflight.push(spec.sessionId)
      if (inflight.length === 1) await yieldTurn()
      return world.createChild(spec)
    },
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
  })
  const firstP = work.dispatch('bot-a', { briefing: 'overlap-one', idempotencyKey: 'one' })
  const secondP = work.dispatch('bot-a', { briefing: 'overlap-two', idempotencyKey: 'two' })
  const [first, second] = await Promise.all([firstP, secondP])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.queued, false)
  assert.equal(second.queued, false)
  assert.equal(first.ticketStatus, 'enqueued')
  assert.equal(second.ticketStatus, 'enqueued')
  assert.notEqual(first.childSessionId, second.childSessionId)
  assert.equal(inflight.length, 2)
  assert.equal(world.calls.length, 2)
  assert.equal(world.pendingIds(first.childSessionId).includes(first.nativeMessageId), true)
  assert.equal(world.pendingIds(second.childSessionId).includes(second.nativeMessageId), true)
  assert.equal(
    world.events(first.childSessionId).some((event: any) => event!.type === 'turn/end'),
    false,
  )
  assert.equal(
    world.events(second.childSessionId).some((event: any) => event!.type === 'turn/end'),
    false,
  )
  work.observeSession(first.childSessionId, world.seeUser(first.childSessionId, first.nativeMessageId, 1))
  work.observeSession(second.childSessionId, world.seeUser(second.childSessionId, second.nativeMessageId, 1))
  assert.equal(work.detail(first.ticketId)!.ticket.status, 'started')
  assert.equal(work.detail(second.ticketId)!.ticket.status, 'started')
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 2)
  ctx.close()
})

test('a third ticket queues and starts automatically after a running slot is released', async () => {
  const ctx = boot({ perBot: 2, global: 4, perBotQueue: 8, globalQueue: 16 })
  const first = await ctx.work.dispatch('bot-a', { briefing: 'run-one', idempotencyKey: 'one' })
  const second = await ctx.work.dispatch('bot-a', { briefing: 'run-two', idempotencyKey: 'two' })
  const third = await ctx.work.dispatch('bot-a', { briefing: 'run-three', idempotencyKey: 'three' })
  assert.equal(first.ticketStatus, 'enqueued')
  assert.equal(second.ticketStatus, 'enqueued')
  assert.equal(third.ok, true)
  assert.equal(third.queued, true)
  assert.equal(third.ticketStatus, 'accepted')
  assert.equal(third.childSessionId, null)
  assert.equal(ctx.world.calls.length, 2)
  ctx.work.observeSession(first.childSessionId, ctx.world.seeUser(first.childSessionId, first.nativeMessageId, 1))
  const reported = field(await ctx.work.report(first.childSessionId, { kind: 'result', text: 'first done' }), 'eventId')
  ctx.work.observeSession(first.childSessionId, ctx.world.endTurn(first.childSessionId, 1, 'completed'))
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(first.ticketId)!.events[0].event_id, reported.eventId)
  const promoted = ctx.work.detail(third.ticketId)!.ticket
  assert.equal(promoted.status, 'enqueued')
  assert.equal(promoted.child_session_id != null, true)
  assert.equal(ctx.work.detail(second.ticketId)!.ticket.status, 'enqueued')
  assert.equal(running(ctx, second.ticketId).noTurnEnd, true)
  assert.equal(running(ctx, third.ticketId).noTurnEnd, true)
  assert.equal(ctx.world.calls.length, 3)
  assert.equal(ctx.world.pendingIds(promoted.child_session_id).length > 0, true)
  ctx.close()
})

test('needs_user does not occupy a running slot, and a combined cap still refuses a new row', async () => {
  const ctx = boot({ perBot: 1, global: 4, perBotQueue: 1, globalQueue: 4 })
  const first = await ctx.work.dispatch('bot-a', { briefing: 'ask later', idempotencyKey: 'ask' })
  ctx.work.observeSession(first.childSessionId, ctx.world.seeUser(first.childSessionId, first.nativeMessageId, 1))
  await ctx.work.report(first.childSessionId, { kind: 'question', text: 'which color?' })
  ctx.work.observeSession(first.childSessionId, ctx.world.endTurn(first.childSessionId, 1, 'completed'))
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'needs_user')
  const second = await ctx.work.dispatch('bot-a', { briefing: 'other work', idempotencyKey: 'other' })
  assert.equal(second.ok, true)
  assert.equal(second.queued, false)
  assert.equal(second.ticketStatus, 'enqueued')
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'needs_user')
  const third = await ctx.work.dispatch('bot-a', { briefing: 'overflow', idempotencyKey: 'overflow' })
  assert.equal(third.code, 'BUDGET')
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 2)
  const supplied = await ctx.work.supply('bot-a', { ticketId: first.ticketId, text: 'use blue' })
  assert.equal(supplied.ok, true)
  assert.equal(supplied.queued, true)
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'needs_user')
  await ctx.work.cancelTicket('bot-a', { ticketId: second.ticketId })
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(second.ticketId)!.ticket.status, 'cancelled')
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.child_session_id, first.childSessionId)
  ctx.close()
})

test('global slot cap queues a second bot and starts the oldest waiter after a release', async () => {
  const ctx = boot({ perBot: 2, global: 3, perBotQueue: 4, globalQueue: 4 })
  ctx.engine.markBot('bot-b')
  ctx.engine.markBot('bot-c')
  const a1 = await ctx.work.dispatch('bot-a', { briefing: 'a1', idempotencyKey: 'a1' })
  const a2 = await ctx.work.dispatch('bot-a', { briefing: 'a2', idempotencyKey: 'a2' })
  const b1 = await ctx.work.dispatch('bot-b', { briefing: 'b1', idempotencyKey: 'b1' })
  const b2 = await ctx.work.dispatch('bot-b', { briefing: 'b2', idempotencyKey: 'b2' })
  const c1 = await ctx.work.dispatch('bot-c', { briefing: 'c1', idempotencyKey: 'c1' })
  assert.equal(a1.queued, false)
  assert.equal(a2.queued, false)
  assert.equal(b1.queued, false)
  assert.equal(b2.queued, true)
  assert.equal(c1.queued, true)
  const cancelled = await ctx.work.cancelTicket('bot-a', { ticketId: a1.ticketId })
  assert.equal(cancelled.ok, true)
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(a1.ticketId)!.ticket.status, 'cancelled')
  assert.equal(ctx.work.detail(a2.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(b1.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(b2.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(c1.ticketId)!.ticket.status, 'accepted')
  assert.equal(ctx.work.detail(b2.ticketId)!.ticket.child_session_id != null, true)
  ctx.close()
})

test('cancel or fail of one ticket does not stop the others, and stale reports stay stale', async () => {
  const ctx = boot({ perBot: 2, global: 4 })
  const keep = await ctx.work.dispatch('bot-a', { briefing: 'keep going', idempotencyKey: 'keep' })
  const drop = await ctx.work.dispatch('bot-a', { briefing: 'drop me', idempotencyKey: 'drop' })
  const wait = await ctx.work.dispatch('bot-a', { briefing: 'wait in line', idempotencyKey: 'wait' })
  ctx.work.observeSession(keep.childSessionId, ctx.world.seeUser(keep.childSessionId, keep.nativeMessageId, 1))
  ctx.work.observeSession(drop.childSessionId, ctx.world.seeUser(drop.childSessionId, drop.nativeMessageId, 1))
  await ctx.work.cancelTicket('bot-a', { ticketId: drop.ticketId })
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(drop.ticketId)!.ticket.status, 'cancelled')
  assert.equal(ctx.work.detail(keep.ticketId)!.ticket.status, 'started')
  const promoted = ctx.work.detail(wait.ticketId)!.ticket
  assert.equal(promoted.status, 'enqueued')
  const lateDrop = field(
    await ctx.work.report(drop.childSessionId, { kind: 'result', text: 'a cancelled result' }),
    'applyStatus',
  )
  assert.equal(lateDrop.applyStatus, 'stale')
  const kept = field(await ctx.work.report(keep.childSessionId, { kind: 'result', text: 'keep result' }), 'eventId')
  ctx.work.observeSession(keep.childSessionId, ctx.world.endTurn(keep.childSessionId, 1, 'completed'))
  await ctx.work.promoteQueued()
  assert.equal(ctx.work.detail(keep.ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(keep.ticketId)!.events[0].event_id, kept.eventId)
  const waitInput = ctx.world.pendingIds(promoted.child_session_id)[0]
  ctx.work.observeSession(promoted.child_session_id, ctx.world.seeUser(promoted.child_session_id, waitInput, 1))
  const redirected = await ctx.work.redirect('bot-a', { ticketId: wait.ticketId, text: 'new brief' })
  assert.equal(redirected.ok, true)
  assert.equal(redirected.briefingRevision, 2)
  const staleRevision = field(
    await ctx.work.report(promoted.child_session_id, {
      kind: 'result',
      text: 'old revision',
      briefingRevision: 1,
    }),
    'applyStatus',
  )
  assert.equal(staleRevision.applyStatus, 'stale')
  ctx.work.observeSession(
    promoted.child_session_id,
    ctx.world.seeUser(promoted.child_session_id, redirected.nativeMessageId, 2),
  )
  const fresh = field(
    await ctx.work.report(promoted.child_session_id, { kind: 'result', text: 'new revision result' }),
    'eventId',
  )
  ctx.work.observeSession(promoted.child_session_id, ctx.world.endTurn(promoted.child_session_id, 2, 'completed'))
  assert.equal(ctx.work.detail(wait.ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(wait.ticketId)!.events.at(-1).event_id, fresh.eventId)
  assert.equal(ctx.work.detail(drop.ticketId)!.ticket.status, 'cancelled')
  ctx.close()
})

test('a new runtime recovers reserved starts and does not double-start a ticket', async () => {
  const ctx = boot()
  const quiet = createWorkRuntime(ctx.store, ctx.engine, {
    resident: false,
    now: () => new Date(ctx.clock.ms),
  })
  const first = await quiet.dispatch('bot-a', { briefing: 'held-one', idempotencyKey: 'one' })
  const second = await quiet.dispatch('bot-a', { briefing: 'held-two', idempotencyKey: 'two' })
  const third = await quiet.dispatch('bot-a', { briefing: 'held-three', idempotencyKey: 'three' })
  assert.equal(first.ticketStatus, 'accepted')
  assert.equal(second.ticketStatus, 'accepted')
  assert.equal(first.childSessionId, null)
  assert.equal(third.queued, true)
  assert.equal(ctx.world.calls.length, 0)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(second.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(third.ticketId)!.ticket.status, 'accepted')
  assert.equal(ctx.world.calls.length, 2)
  await ctx.work.tick()
  assert.equal(ctx.world.calls.length, 2)
  const replay = await ctx.work.dispatch('bot-a', { briefing: 'held-one', idempotencyKey: 'one' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.ticketId, first.ticketId)
  const reuse = await ctx.work.dispatch('bot-a', { briefing: 'a different job', idempotencyKey: 'one' })
  assert.equal(reuse.code, 'IDEMPOTENCY_KEY_REUSE')
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 3)
  ctx.close()
})

test('lease expiry of a running ticket starts the next queued ticket on tick', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 2, globalQueue: 4 })
  const first = await ctx.work.dispatch('bot-a', { briefing: 'will expire', idempotencyKey: 'lease' })
  const second = await ctx.work.dispatch('bot-a', { briefing: 'next up', idempotencyKey: 'next' })
  assert.equal(second.queued, true)
  ctx.work.observeSession(first.childSessionId, ctx.world.seeUser(first.childSessionId, first.nativeMessageId, 1))
  ctx.world.dropChild(first.childSessionId)
  ctx.store.db
    .prepare(`UPDATE work_attempts SET lease_until = ? WHERE id = ?`)
    .run('2026-11-07T00:00:00.000Z', first.attemptId)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(first.ticketId)!.ticket.status, 'failed')
  assert.equal(ctx.work.detail(second.ticketId)!.ticket.status, 'enqueued')
  assert.equal(ctx.work.detail(second.ticketId)!.ticket.child_session_id != null, true)
  ctx.close()
})

test('custom perBot=1 starts one worker and queues the next; perBot=3 starts three', async () => {
  const tight = boot({ perBot: 1, global: 4, perBotQueue: 4, globalQueue: 8 })
  const first = await tight.work.dispatch('bot-a', { briefing: 'only-one', idempotencyKey: 'one' })
  const second = await tight.work.dispatch('bot-a', { briefing: 'wait', idempotencyKey: 'two' })
  assert.equal(first.ok, true)
  assert.equal(first.queued, false)
  assert.equal(second.ok, true)
  assert.equal(second.queued, true)
  assert.equal(tight.work.detail(second.ticketId!)!.ticket.status, 'accepted')
  tight.close()

  const wide = boot({ perBot: 3, global: 4, perBotQueue: 2, globalQueue: 8 })
  const started: Array<{ ticketId?: string }> = []
  for (const key of ['a', 'b', 'c']) {
    const result = await wide.work.dispatch('bot-a', { briefing: `job-${key}`, idempotencyKey: key })
    assert.equal(result.ok, true)
    assert.equal(result.queued, false)
    started.push(result)
  }
  const fourth = await wide.work.dispatch('bot-a', { briefing: 'job-d', idempotencyKey: 'd' })
  assert.equal(fourth.ok, true)
  assert.equal(fourth.queued, true)
  assert.equal(
    started.every(item => running(wide, item.ticketId!).noTurnEnd),
    true,
  )
  wide.close()
})

test('a later runtime with a lower cap does not cancel workers that are already running', async () => {
  const ctx = boot({ perBot: 3, global: 4, perBotQueue: 2, globalQueue: 4 })
  const first = await ctx.work.dispatch('bot-a', { briefing: 'keep-1', idempotencyKey: 'k1' })
  const second = await ctx.work.dispatch('bot-a', { briefing: 'keep-2', idempotencyKey: 'k2' })
  const third = await ctx.work.dispatch('bot-a', { briefing: 'keep-3', idempotencyKey: 'k3' })
  assert.equal(
    [first, second, third].every(item => item.ok && item.queued === false),
    true,
  )

  const later = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: spec => ctx.world.createChild(spec),
    push: (sessionId, messageId, text) => ctx.world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => ctx.world.logHas(sessionId, messageId),
    pendingIds: sessionId => ctx.world.pendingIds(sessionId),
    snapshot: sessionId => ctx.world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
    budget: { perBot: 1, global: 2, perBotQueue: 1, globalQueue: 2 },
  })
  for (const ticketId of [first.ticketId, second.ticketId, third.ticketId]) {
    const ticket = later.detail(ticketId)!.ticket
    assert.equal(ticket.status, 'enqueued')
    assert.equal(running(ctx, ticketId).noTurnEnd, true)
  }
  const extra = await later.dispatch('bot-a', { briefing: 'after-lower', idempotencyKey: 'extra' })
  assert.equal(extra.ok, false)
  assert.equal(extra.code, 'BUDGET')
  assert.equal(later.detail(first.ticketId)!.ticket.status, 'enqueued')
  assert.equal(later.detail(second.ticketId)!.ticket.status, 'enqueued')
  assert.equal(later.detail(third.ticketId)!.ticket.status, 'enqueued')
  ctx.close()
})

test('global cap is the effective limit when perBot is larger', async () => {
  const ctx = boot({ perBot: 8, global: 2, perBotQueue: 8, globalQueue: 2 })
  const first = await ctx.work.dispatch('bot-a', { briefing: 'g1', idempotencyKey: 'g1' })
  const second = await ctx.work.dispatch('bot-a', { briefing: 'g2', idempotencyKey: 'g2' })
  const third = await ctx.work.dispatch('bot-a', { briefing: 'g3', idempotencyKey: 'g3' })
  assert.equal(first.queued, false)
  assert.equal(second.queued, false)
  assert.equal(third.queued, true)
  const fourth = await ctx.work.dispatch('bot-a', { briefing: 'g4', idempotencyKey: 'g4' })
  const fifth = await ctx.work.dispatch('bot-a', { briefing: 'g5', idempotencyKey: 'g5' })
  assert.equal(fourth.queued, true)
  assert.equal(fifth.ok, false)
  assert.equal(fifth.code, 'BUDGET')
  ctx.close()
})

test('cancel and grant-deny return without waiting for a slow createChild of the next ticket', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 })
  let releaseNext: (value?: unknown) => void = () => {}
  const blocked = new Promise(resolve => {
    releaseNext = resolve
  })
  const world = createMockWorld()
  let firstId = ''
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      if (firstId !== '' && spec.ticketId !== firstId) await blocked
      return world.createChild(spec)
    },
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
    budget: { perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 },
  })
  const first = await work.dispatch('bot-a', { briefing: 'running', idempotencyKey: 'run' })
  firstId = first.ticketId
  const second = await work.dispatch('bot-a', { briefing: 'waiting', idempotencyKey: 'wait' })
  assert.equal(second.queued, true)
  const cancelled = await assertUnblocked(
    work.cancelTicket('bot-a', { ticketId: first.ticketId }),
    blocked,
    'cancel waited for the next createChild',
  )
  assert.equal(cancelled.ok, true)
  releaseNext()
  await work.promoteQueued()
  assert.equal(work.detail(second.ticketId!)!.ticket.status, 'enqueued')
  assert.equal(work.detail(second.ticketId!)!.ticket.child_session_id != null, true)
  ctx.close()
})

test('a hung reserved start expires, frees the slot, and a late createChild is cancelled', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 })
  let releaseHung: (value?: unknown) => void = () => {}
  const hung = new Promise(resolve => {
    releaseHung = resolve
  })
  const world = createMockWorld()
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      if (ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n === 1) await hung
      return world.createChild(spec)
    },
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
    budget: { perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 },
  })
  const firstP = work.dispatch('bot-a', { briefing: 'hang on start', idempotencyKey: 'hang' })
  const began = Date.now()
  let firstId = ''
  while (Date.now() - began < 2000 && firstId === '') {
    const row = ctx.store.db.prepare('SELECT id, status FROM work_tickets LIMIT 1').get()
    if (row?.id) firstId = row.id
    else await yieldTurn()
  }
  assert.equal(firstId !== '', true)
  const second = await work.dispatch('bot-a', { briefing: 'next in line', idempotencyKey: 'next' })
  assert.equal(second.queued, true)
  ctx.clock.ms += RESERVE_WALL_MS + 1
  await assertUnblocked(work.tick(), hung, 'tick waited for the hung createChild')
  assert.equal(work.detail(firstId)!.ticket.status, 'failed')
  const events = work.detail(firstId)!.events
  assert.equal(
    events.some((event: any) => String(event.text ?? '').includes('reserved start did not create a worker')),
    true,
  )
  await work.promoteQueued()
  assert.equal(work.detail(second.ticketId!)!.ticket.status, 'enqueued')
  assert.equal(work.detail(second.ticketId!)!.ticket.child_session_id != null, true)
  releaseHung()
  await firstP
  assert.equal(work.detail(firstId)!.ticket.child_session_id == null, true)
  assert.equal(
    world.cancels.some((item: any) => item.reason === 'stale-start'),
    true,
  )
  ctx.close()
})

test('concurrent promoteQueued does not start the same reserved ticket twice', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 })
  let release: (value?: unknown) => void = () => {}
  const gate = new Promise(resolve => {
    release = resolve
  })
  let calls = 0
  const world = createMockWorld()
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      calls += 1
      await gate
      return world.createChild(spec)
    },
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
    budget: { perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 },
  })
  const firstP = work.dispatch('bot-a', { briefing: 'once only', idempotencyKey: 'once' })
  const began = Date.now()
  while (Date.now() - began < 2000 && calls === 0) await yieldTurn()
  const p1 = work.promoteQueued()
  const p2 = work.promoteQueued()
  release()
  await Promise.all([firstP, p1, p2])
  assert.equal(calls, 1)
  ctx.close()
})

test('grant-deny returns without waiting for a slow createChild of the next ticket', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 })
  let releaseNext: (value?: unknown) => void = () => {}
  const blocked = new Promise(resolve => {
    releaseNext = resolve
  })
  const world = createMockWorld()
  let firstId = ''
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      if (firstId !== '' && spec.ticketId !== firstId) await blocked
      return world.createChild(spec)
    },
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(ctx.clock.ms),
    budget: { perBot: 1, global: 2, perBotQueue: 2, globalQueue: 2 },
  })
  const first = await work.dispatch('bot-a', { briefing: 'needs a grant', idempotencyKey: 'grant-run' })
  firstId = first.ticketId
  const second = await work.dispatch('bot-a', { briefing: 'next after deny', idempotencyKey: 'grant-wait' })
  assert.equal(second.queued, true)
  const denied = await assertUnblocked(
    work.grant('bot-a', { ticketId: first.ticketId, deny: true }),
    blocked,
    'grant-deny waited for the next createChild',
  )
  assert.equal(denied.ok, true)
  assert.equal(denied.denied, true)
  releaseNext()
  await work.promoteQueued()
  assert.equal(work.detail(first.ticketId)!.ticket.status, 'failed')
  assert.equal(work.detail(second.ticketId!)!.ticket.status, 'enqueued')
  ctx.close()
})
