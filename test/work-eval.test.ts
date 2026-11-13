import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../src/store.ts'
import { createEngine } from '../src/engine.ts'
import { createMockWorld } from '../src/work-mock.ts'
import { createWorkRuntime } from '../src/work-worker.ts'
import { DEFAULT_WORK_BUDGET } from '../src/work-admit.ts'
import { field, present } from './narrow.ts'

/**
 * Protocol evaluation. These cases call the runtime directly.
 * They are not a model deciding, and they are not a DSH process.
 */

function boot(budget?: Partial<typeof DEFAULT_WORK_BUDGET>) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-eval-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const world = createMockWorld()
  const clock = { ms: Date.parse('2026-11-08T00:00:00.000Z') }
  let scheduled: { fn: () => void; ms: number } | null = null
  const work = createWorkRuntime(store, engine, {
    createChild: spec => world.createChild(spec),
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    remove: (sessionId, messageId) => world.remove(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: sessionId => world.snapshot(sessionId),
    now: () => new Date(clock.ms),
    pid: 42,
    schedule: (fn, ms) => {
      scheduled = { fn, ms }
      return () => {
        if (scheduled?.fn === fn) scheduled = null
      }
    },
    ...(budget ? { budget } : {}),
  })
  engine.markBot('bot-a')
  return {
    dir,
    store,
    engine,
    world,
    work,
    clock,
    scheduled: () => scheduled,
    close: () => store.close(),
  }
}

function hash(text: any) {
  return createHash('sha256').update(text).digest('hex')
}

async function startJob(ctx: any, briefing: any, key: any) {
  const result = await ctx.work.dispatch('bot-a', { briefing, idempotencyKey: key })
  assert.equal(result.ok, true)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  return result
}

test('eval: product defaults allow two running workers per bot and four globally', async () => {
  assert.equal(DEFAULT_WORK_BUDGET.perBot, 2)
  assert.equal(DEFAULT_WORK_BUDGET.global, 4)
  assert.equal(DEFAULT_WORK_BUDGET.perBotQueue, 8)
  assert.equal(DEFAULT_WORK_BUDGET.globalQueue, 16)
  assert.equal(DEFAULT_WORK_BUDGET.mainMaxSteps, 80)
  assert.equal(DEFAULT_WORK_BUDGET.mainWallMs, 30 * 60_000)
  assert.equal(DEFAULT_WORK_BUDGET.chatMaxSteps, 80)
  assert.equal(DEFAULT_WORK_BUDGET.chatWallMs, 30 * 60_000)
  const ctx = boot()
  assert.equal(ctx.work.limits.perBot, 2)
  assert.equal(ctx.work.limits.global, 4)
  ctx.engine.markBot('bot-b')
  ctx.engine.markBot('bot-c')
  const first = await ctx.work.dispatch('bot-a', { briefing: 'alpha', idempotencyKey: 'a' })
  const secondSame = await ctx.work.dispatch('bot-a', { briefing: 'alpha-two', idempotencyKey: 'a2' })
  assert.equal(first.ok, true)
  assert.equal(secondSame.ok, true)
  assert.equal(first.queued, false)
  assert.equal(secondSame.queued, false)
  assert.equal(first.ticketStatus, 'enqueued')
  assert.equal(secondSame.ticketStatus, 'enqueued')
  assert.notEqual(first.childSessionId, secondSame.childSessionId)
  const queued = await ctx.work.dispatch('bot-a', { briefing: 'alpha-three', idempotencyKey: 'a3' })
  assert.equal(queued.ok, true)
  assert.equal(queued.queued, true)
  assert.equal(queued.ticketStatus, 'accepted')
  assert.equal(queued.childSessionId, null)
  const botB1 = await ctx.work.dispatch('bot-b', { briefing: 'beta', idempotencyKey: 'b' })
  const botB2 = await ctx.work.dispatch('bot-b', { briefing: 'beta-two', idempotencyKey: 'b2' })
  assert.equal(botB1.ok, true)
  assert.equal(botB1.queued, false)
  assert.equal(botB2.ok, true)
  assert.equal(botB2.queued, false)
  const botC = await ctx.work.dispatch('bot-c', { briefing: 'gamma', idempotencyKey: 'c' })
  assert.equal(botC.ok, true)
  assert.equal(botC.queued, true)
  assert.equal(botC.childSessionId, null)
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 6)
  assert.equal(DEFAULT_WORK_BUDGET.perBot, 2)
  assert.equal(DEFAULT_WORK_BUDGET.global, 4)
  ctx.close()
})

test('eval: three active tickets require an explicit budget and are not the product default', async () => {
  const ctx = boot({ perBot: 3, global: 3 })
  assert.equal(ctx.work.limits.perBot, 3)
  assert.equal(ctx.work.limits.global, 3)
  assert.notEqual(ctx.work.limits.perBot, DEFAULT_WORK_BUDGET.perBot)
  const jobs = []
  for (const key of ['one', 'two', 'three']) {
    const job = await ctx.work.dispatch('bot-a', { briefing: key, idempotencyKey: key })
    assert.equal(job.ok, true)
    assert.equal(job.ticketStatus, 'enqueued')
    jobs.push(job)
  }
  assert.equal(
    jobs.every(job => ctx.world.events(job.childSessionId).every((event: any) => event!.type !== 'turn/end')),
    true,
  )
  for (const job of jobs) {
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  }
  assert.equal(
    jobs.every(job => ctx.world.events(job.childSessionId).every((event: any) => event!.type !== 'turn/end')),
    true,
  )
  const late = field(
    await ctx.work.report(jobs[2].childSessionId, { kind: 'result', text: 'the gamma result' }),
    'eventId',
  )
  const early = field(
    await ctx.work.report(jobs[0].childSessionId, { kind: 'result', text: 'the alpha result' }),
    'eventId',
  )
  ctx.work.observeSession(jobs[2].childSessionId, ctx.world.endTurn(jobs[2].childSessionId, 1, 'completed'))
  assert.equal(ctx.work.detail(jobs[2].ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(jobs[0].ticketId)!.ticket.status, 'started')
  ctx.work.observeSession(jobs[0].childSessionId, ctx.world.endTurn(jobs[0].childSessionId, 1, 'completed'))
  const first = ctx.work.detail(jobs[0].ticketId)
  const third = ctx.work.detail(jobs[2].ticketId)
  assert.equal(first!.events[0].payload_hash, hash('the alpha result'))
  assert.equal(third!.events[0].payload_hash, hash('the gamma result'))
  assert.equal(first!.events[0].event_id, early.eventId)
  assert.equal(third!.events[0].event_id, late.eventId)
  assert.equal(DEFAULT_WORK_BUDGET.perBot, 2)
  ctx.close()
})

test('eval: one budget denial and one cancel leave the other ticket runnable', async () => {
  const ctx = boot({ perBot: 3, global: 3 })
  const jobs = []
  for (const key of ['keep', 'stop', 'drop']) {
    jobs.push(await startJob(ctx, key, key))
  }
  const [keep, stop, drop] = jobs
  ctx.work.observeSession(drop.childSessionId, { type: 'turn/start', data: { turn: 1 } })
  for (let step = 1; step <= 30; step += 1) {
    ctx.work.observeSession(drop.childSessionId, { type: 'step/end', data: { turn: 1, step } })
  }
  assert.equal(ctx.work.detail(drop.ticketId)!.ticket.status, 'started')
  ctx.store.db
    .prepare(`UPDATE work_tickets SET budget_json = ? WHERE id = ?`)
    .run(
      JSON.stringify({ wallMs: DEFAULT_WORK_BUDGET.workerWallMs, maxTokens: DEFAULT_WORK_BUDGET.workerMaxTokens }),
      drop.ticketId,
    )
  ctx.work.observeSession(drop.childSessionId, { type: 'turn/start', data: { turn: 2 } })
  ctx.scheduled()!.fn()
  assert.equal(JSON.parse(ctx.work.detail(drop.ticketId)!.ticket.budget_json).quota.waiting, true)
  await ctx.work.grant('bot-a', { ticketId: drop.ticketId, deny: true })
  assert.equal(ctx.work.detail(drop.ticketId)!.ticket.status, 'failed')
  assert.equal(ctx.work.detail(keep.ticketId)!.ticket.status, 'started')
  assert.equal(ctx.work.detail(stop.ticketId)!.ticket.status, 'started')
  const cancelled = await ctx.work.cancelTicket('bot-a', { ticketId: stop.ticketId })
  assert.equal(cancelled.ok, true)
  assert.equal(ctx.work.detail(keep.ticketId)!.ticket.status, 'started')
  assert.equal(ctx.world.pendingIds(keep.childSessionId).includes(keep.nativeMessageId), true)
  const reported = field(await ctx.work.report(keep.childSessionId, { kind: 'result', text: 'still here' }), 'eventId')
  ctx.work.observeSession(keep.childSessionId, ctx.world.endTurn(keep.childSessionId, 1, 'completed'))
  assert.equal(ctx.work.detail(keep.ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(keep.ticketId)!.events[0].event_id, reported.eventId)
  assert.equal(ctx.work.detail(drop.ticketId)!.ticket.status, 'failed')
  assert.equal(ctx.work.detail(stop.ticketId)!.ticket.status, 'cancelled')
  ctx.close()
})

test('eval: queued reports share one wake and a second wake waits out the merge window', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'merge the notes', 'merge')
  await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'step one' })
  await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'step two' })
  const admitted = await ctx.work.admit('bot-a')
  assert.equal(admitted.admitted, true)
  const notices = ctx.work.detail(job.ticketId)!.notices
  assert.equal(notices.length, 2)
  assert.equal(notices[0].native_message_id, notices[1].native_message_id)
  const splice = ctx.world.events('bot-a').find((event: any) => event!.type === 'agent/inbox/spliced')
  assert.equal(present(splice).data.target, 'next-turn')
  const seen = ctx.world.seeUser('bot-a', notices[0].native_message_id, 1)
  ctx.work.observeSession('bot-a', seen)
  ctx.work.observeSession('bot-a', ctx.world.endTurn('bot-a', 1, 'completed'))
  assert.equal(
    ctx.work.detail(job.ticketId)!.notices.every((row: any) => row.observe_status === 'completed'),
    true,
  )
  ctx.clock.ms += 200
  await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'step three' })
  const held = await ctx.work.admit('bot-a')
  assert.equal(held.admitted, false)
  assert.equal(held.reason, 'merge-window')
  assert.equal(new Set(ctx.work.detail(job.ticketId)!.notices.map((row: any) => row.native_message_id)).size, 1)
  ctx.clock.ms += 1000
  const again = await ctx.work.admit('bot-a')
  assert.equal(again.admitted, true)
  const ids = ctx.work.detail(job.ticketId)!.notices.map((row: any) => row.native_message_id)
  assert.equal(new Set(ids).size, 2)
  const extra = await ctx.work.admit('bot-a')
  assert.equal(extra.admitted, false)
  assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 3)
  ctx.close()
})

test('eval: a report during an open main turn is ledgered and does not take the user turn', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'report while running', 'live')
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 4 } })
  const userId = ctx.world.postUser('bot-a', 'the main loop is still answering')
  const cancels = ctx.world.cancels.length
  const reported = field(
    await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'progress: the filter is still missing' }),
    'eventId',
  )
  assert.equal(reported.ok, true)
  const before = ctx.work.detail(job.ticketId)
  assert.equal(before!.events.length, 1)
  assert.equal(before!.events[0].kind, 'progress')
  assert.equal(before!.notices.length, 0)
  const held = await ctx.work.admit('bot-a')
  assert.equal(held.reason, 'user-pending')
  assert.deepEqual(ctx.world.pendingIds('bot-a'), [userId])
  assert.equal(
    ctx.world.events('bot-a').some((event: any) => event!.type === 'turn/end'),
    false,
  )
  assert.equal(ctx.world.cancels.length, cancels)
  assert.equal(
    ctx.world.pushes.some(
      item => item.sessionId === 'bot-a' && item.text.includes('progress: the filter is still missing'),
    ),
    false,
  )
  const claimed = ctx.world.claim('bot-a')
  assert.equal(claimed!.messageId, userId)
  assert.equal(claimed!.text, 'the main loop is still answering')
  ctx.work.observeSession('bot-a', ctx.world.endTurn('bot-a', 4, 'completed'))
  const woke = field(await ctx.work.admit('bot-a'), 'nativeMessageId')
  assert.equal(woke.admitted, true)
  const after = ctx.work.detail(job.ticketId)
  assert.equal(after!.notices.length, 1)
  assert.equal(after!.notices[0].event_id, reported.eventId)
  assert.equal(after!.events.length, 1)
  const notice = present(ctx.world.pushes.find(item => item.sessionId === 'bot-a'))
  assert.match(notice.text, /\[foundations:ticket\]/)
  assert.equal(notice.text.includes('progress: the filter is still missing'), false)
  const duplicate = await ctx.work.admit('bot-a')
  assert.equal(duplicate.admitted, false)
  assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1)
  const later = ctx.world.postUser('bot-a', 'the next user line')
  const pending = ctx.world.pendingIds('bot-a')
  assert.equal(pending[0], woke.nativeMessageId)
  assert.equal(pending.at(-1), later)
  ctx.close()
})

test('eval: a result notice carries the body and tells the main bot to answer', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'hand over the result', 'speak')
  const reported = field(
    await ctx.work.report(job.childSessionId, { kind: 'result', text: 'the page is written' }),
    'eventId',
  )
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
  const woke = await ctx.work.admit('bot-a')
  assert.equal(woke.admitted, true)
  const notice = present(ctx.world.pushes.find(item => item.sessionId === 'bot-a'))
  assert.match(notice.text, /the page is written/)
  assert.match(notice.text, new RegExp(reported.eventId))
  assert.match(notice.text, /foundations_publish/)
  assert.match(notice.text, /write that same text as the reply/)
  ctx.close()
})

test('eval: question remains needs_user until a caller supplies text', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'add a filter or not', 'ask')
  const asked = field(
    await ctx.work.report(job.childSessionId, { kind: 'question', text: 'a filter or a count?' }),
    'applyStatus',
  )
  assert.equal(asked.applyStatus, 'pending_completion')
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'needs_user')
  await ctx.work.tick()
  const parked = ctx.work.detail(job.ticketId)
  assert.equal(parked!.ticket.status, 'needs_user')
  assert.equal(
    parked!.inputs.some((input: any) => input.kind === 'supply' || input.kind === 'redirect'),
    false,
  )
  assert.equal(ctx.world.calls.length, 1)
  const supplied = field(
    await ctx.work.supply('bot-a', { ticketId: job.ticketId, text: 'add the filter and the open count' }),
    'childSessionId',
  )
  assert.equal(supplied.ok, true)
  assert.equal(supplied.childSessionId, job.childSessionId)
  assert.equal(supplied.briefingRevision, 2)
  assert.equal(supplied.ticketStatus, 'enqueued')
  assert.equal(ctx.world.calls.length, 1)
  ctx.close()
})

test('eval: redirect keeps the child and a late old revision cannot become the delivery', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'write a first draft', 'collab')
  const old = field(
    await ctx.work.report(job.childSessionId, { kind: 'result', text: 'the draft has no filter' }),
    'eventId',
  )
  const redirected = field(
    await ctx.work.redirect('bot-a', {
      ticketId: job.ticketId,
      text: 'add a filter and the open count to the current file',
    }),
    'childSessionId',
  )
  assert.equal(redirected.childSessionId, job.childSessionId)
  assert.equal(redirected.briefingRevision, 2)
  assert.equal(redirected.fencingToken, 1)
  assert.equal(ctx.world.calls.length, 1)
  const late = field(
    await ctx.work.report(job.childSessionId, {
      kind: 'result',
      text: 'a late old result',
      briefingRevision: 1,
    }),
    'applyStatus',
  )
  assert.equal(late.applyStatus, 'stale')
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
  let detail = ctx.work.detail(job.ticketId)
  assert.equal(detail!.events.find((event: any) => event!.event_id === old.eventId).apply_status, 'stale')
  assert.equal(detail!.events.find((event: any) => event!.event_id === late.eventId).apply_status, 'stale')
  assert.equal(detail!.ticket.status, 'enqueued')
  ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, redirected.nativeMessageId, 2))
  const phase2 = field(
    await ctx.work.report(job.childSessionId, { kind: 'result', text: 'phase two is written' }),
    'applyStatus',
  )
  assert.equal(phase2.applyStatus, 'pending_completion')
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
  assert.equal(
    ctx.work.detail(job.ticketId)!.events.find((event: any) => event!.event_id === phase2.eventId).apply_status,
    'pending_completion',
  )
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 2, 'completed'))
  detail = ctx.work.detail(job.ticketId)
  assert.equal(detail!.ticket.status, 'ready')
  assert.equal(detail!.events.find((event: any) => event!.event_id === phase2.eventId).apply_status, 'applied')
  assert.equal(
    detail!.events.find((event: any) => event!.event_id === phase2.eventId).payload_hash,
    hash('phase two is written'),
  )
  assert.equal(detail!.events.find((event: any) => event!.event_id === late.eventId).apply_status, 'stale')
  const rejected = await ctx.work.publish('bot-a', {
    resultEventId: late.eventId,
    text: 'do not deliver the old result',
  })
  assert.equal(rejected.ok, false)
  const published = await ctx.work.publish('bot-a', { resultEventId: phase2.eventId, text: 'phase two is written' })
  assert.equal(published.status, 'intent')
  ctx.world.toolCall('bot-a', 'foundations_publish', { resultEventId: phase2.eventId, text: 'phase two is written' })
  ctx.world.assistant('bot-a', 'phase two is written')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'delivered')
  assert.equal(ctx.work.detail(job.ticketId)!.deliveries.length, 1)
  ctx.close()
})

test('eval: main budget cancel keeps the next user message', async () => {
  const ctx = boot({ mainMaxSteps: 2, mainWallMs: 20_000 })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 1 } })
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'foundations_dispatch', arguments: {} } })
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 2 } })
  assert.equal(ctx.world.cancels.length, 0)
  ctx.clock.ms += 20_000
  ctx.scheduled()!.fn()
  assert.equal(present(ctx.world.cancels.at(-1)).reason, 'main-budget:wall')
  assert.equal(present(ctx.world.cancels.at(-1)).keepInbox, true)
  assert.equal(present(ctx.world.cancels.at(-1)).sessionId, 'bot-a')
  const userId = ctx.world.postUser('bot-a', 'the line after the budget cancel')
  ctx.work.observeSession('bot-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(ctx.world.pendingIds('bot-a'), [userId])
  const claimed = ctx.world.claim('bot-a')
  assert.equal(claimed!.text, 'the line after the budget cancel')
  const job = await startJob(ctx, 'worker over budget', 'over')
  const botCancels = ctx.world.cancels.filter(item => item.sessionId === 'bot-a').length
  ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
  for (let step = 1; step <= 30; step += 1) {
    ctx.work.observeSession(job.childSessionId, { type: 'step/end', data: { turn: 1, step } })
  }
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  ctx.scheduled()!.fn()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  assert.equal(
    ctx.world.cancels.some(item => item.sessionId === job.childSessionId),
    false,
  )
  assert.match(ctx.work.detail(job.ticketId)!.events.at(-1).text, /\[foundations:extension\]/)
  assert.equal(ctx.world.cancels.filter(item => item.sessionId === 'bot-a').length, botCancels)
  ctx.close()
})

test('eval: a new runtime reconciles the ledger and does not keep the old turn', async () => {
  const ctx = boot()
  const job = await startJob(ctx, 'the ticket from before restart', 'restart')
  const reported = field(
    await ctx.work.report(job.childSessionId, { kind: 'result', text: 'the result from before restart' }),
    'eventId',
  )
  ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
  const published = await ctx.work.publish('bot-a', {
    resultEventId: reported.eventId,
    text: 'the result from before restart',
  })
  ctx.world.toolCall('bot-a', 'foundations_publish', {
    resultEventId: reported.eventId,
    text: 'the result from before restart',
  })
  ctx.world.assistant('bot-a', 'the result from before restart')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'delivered')
  const pushes = ctx.world.pushes.length
  const creates = ctx.world.calls.length
  const restarted = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: spec => ctx.world.createChild(spec),
    push: (...args) => ctx.world.push(...args),
    logHas: (...args) => ctx.world.logHas(...args),
    remove: (...args) => ctx.world.remove(...args),
    pendingIds: id => ctx.world.pendingIds(id),
    cancel: (...args) => ctx.world.cancel(...args),
    snapshot: id => ctx.world.snapshot(id),
    now: () => new Date(ctx.clock.ms),
    pid: 99,
    schedule: () => () => {},
  })
  const orphan = field(
    await restarted.report(job.childSessionId, { kind: 'progress', text: 'no matching turn after restart' }),
    'code',
  )
  assert.equal(orphan.code, 'NOT_FOUND')
  await restarted.tick()
  const detail = restarted.detail(job.ticketId)
  assert.equal(detail!.ticket.child_session_id, job.childSessionId)
  assert.equal(detail!.ticket.status, 'delivered')
  assert.equal(detail!.attempts.length, 1)
  assert.equal(detail!.deliveries.length, 1)
  assert.equal(detail!.events.length, 1)
  assert.equal(ctx.world.pushes.length, pushes)
  assert.equal(ctx.world.calls.length, creates)
  const live = await startJob(ctx, 'another ticket is still open', 'live-gap')
  const gap = field(
    await restarted.report(live.childSessionId, { kind: 'progress', text: 'the new runtime has not read the log' }),
    'code',
  )
  assert.equal(gap.code, 'NOT_FOUND')
  await restarted.tick()
  const bound = await restarted.report(live.childSessionId, {
    kind: 'progress',
    text: 'it can be written after reconcile',
  })
  assert.equal(bound.ok, true)
  assert.equal(ctx.world.calls.length, creates + 1)
  ctx.close()
})
