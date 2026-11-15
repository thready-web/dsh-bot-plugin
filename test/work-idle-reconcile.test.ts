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
import { field } from './narrow.ts'

/**
 * Counts full log snapshots the idle tick asks for.
 * A regression that walks closed history shows up as calls and events, not as CPU.
 */
function boot(budget?: Partial<typeof DEFAULT_WORK_BUDGET>) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-idle-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const world = createMockWorld()
  const clock = { ms: Date.parse('2026-11-15T00:00:00.000Z') }
  const reads: Array<{ sessionId: string; events: number }> = []
  const work = createWorkRuntime(store, engine, {
    createChild: spec => world.createChild(spec),
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    remove: (sessionId, messageId) => world.remove(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, options) => world.cancel(sessionId, options),
    snapshot: async sessionId => {
      const events = await world.snapshot(sessionId)
      reads.push({ sessionId, events: events.length })
      return events
    },
    childPresent: sessionId => world.hasSession(sessionId),
    now: () => new Date(clock.ms),
    pid: 42,
    ...(budget ? { budget } : {}),
  })
  engine.markBot('bot-a')
  engine.markBot('bot-b')
  return { store, engine, world, work, clock, reads, close: () => store.close() }
}

function pad(world: ReturnType<typeof createMockWorld>, sessionId: string, count: number) {
  const slot = world.session(sessionId)
  for (let i = 0; i < count; i++) {
    slot.seq += 1
    slot.events.push({ type: 'assistant/message', seq: slot.seq, data: { text: 'closed-history', turn: 0 } })
  }
}

test('repeated ticks on terminal history do not take full snapshots', async () => {
  const ctx = boot({ perBot: 16, global: 16, perBotQueue: 16, globalQueue: 16 })
  const jobs = []
  for (let i = 0; i < 15; i++) {
    const owner = i < 13 ? 'bot-a' : 'bot-b'
    const job = await ctx.work.dispatch(owner, { briefing: `closed ${i}`, idempotencyKey: `closed-${i}` })
    assert.equal(typeof job.childSessionId, 'string')
    jobs.push(job)
    ctx.store.db.prepare(`UPDATE work_tickets SET status = 'failed' WHERE id = ?`).run(job.ticketId)
    ctx.store.db.prepare(`UPDATE work_attempts SET status = 'failed' WHERE ticket_id = ?`).run(job.ticketId)
    pad(ctx.world, job.childSessionId, 400)
  }
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'cancelled' WHERE id = ?`).run(jobs[0]!.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'cancelled' WHERE ticket_id = ?`).run(jobs[0]!.ticketId)
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'delivered' WHERE id = ?`).run(jobs[1]!.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'succeeded' WHERE ticket_id = ?`).run(jobs[1]!.ticketId)
  pad(ctx.world, 'bot-a', 400)
  pad(ctx.world, 'bot-b', 400)
  assert.ok(ctx.world.events(jobs[2]!.childSessionId).length >= 400)
  assert.deepEqual(ctx.work.book.childIdsForReconcile(), [])
  assert.deepEqual(ctx.work.book.ownerIdsForReconcile(), [])
  ctx.reads.length = 0
  for (let i = 0; i < 5; i++) await ctx.work.tick()
  // 5 ticks × 17 logs × 400 events would be reread in full by the old loop.
  assert.equal(ctx.reads.length, 0)
  pad(ctx.world, jobs[2]!.childSessionId, 400)
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  ctx.close()
})

test('an active child still becomes ready from the log, then idle ticks stop', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', { briefing: 'finish the job', idempotencyKey: 'live' })
  ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  const reported = field(await ctx.work.report(job.childSessionId, { kind: 'result', text: 'done' }), 'applyStatus')
  assert.equal(reported.applyStatus, 'pending_completion')
  ctx.world.endTurn(job.childSessionId, 1, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'ready')
  assert.equal(ctx.work.detail(job.ticketId)!.attempts[0]!.status, 'succeeded')
  pad(ctx.world, job.childSessionId, 500)
  pad(ctx.world, 'bot-a', 500)
  ctx.reads.length = 0
  for (let i = 0; i < 4; i++) await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  ctx.close()
})

test('retry reopens the same child and a later result still reconciles', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', { briefing: 'try once', idempotencyKey: 'retry' })
  ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  await ctx.work.tick()
  await ctx.work.report(job.childSessionId, { kind: 'failure', text: 'broke' })
  ctx.world.endTurn(job.childSessionId, 1, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'failed')
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  const retried = field(await ctx.work.retry('bot-a', { ticketId: job.ticketId }), 'fencingToken')
  assert.equal(retried.childSessionId, job.childSessionId)
  assert.equal(retried.fencingToken, 2)
  ctx.world.seeUser(job.childSessionId, retried.nativeMessageId, 2)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  const reported = field(
    await ctx.work.report(job.childSessionId, { kind: 'result', text: 'second try' }),
    'applyStatus',
  )
  assert.equal(reported.applyStatus, 'pending_completion')
  ctx.world.endTurn(job.childSessionId, 2, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'ready')
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  ctx.close()
})

test('needs_user does not reread a started attempt until supply resumes it', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', { briefing: 'ask', idempotencyKey: 'ask' })
  ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  await ctx.work.tick()
  await ctx.work.report(job.childSessionId, { kind: 'question', text: 'which?' })
  ctx.world.endTurn(job.childSessionId, 1, 'completed')
  await ctx.work.tick()
  const waiting = ctx.work.detail(job.ticketId)!
  assert.equal(waiting.ticket.status, 'needs_user')
  assert.equal(waiting.attempts[0]!.status, 'started')
  pad(ctx.world, job.childSessionId, 300)
  ctx.reads.length = 0
  for (let i = 0; i < 3; i++) await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  const supplied = field(
    await ctx.work.supply('bot-a', { ticketId: job.ticketId, text: 'the blue one' }),
    'nativeMessageId',
  )
  assert.equal(supplied.ok, true)
  ctx.world.seeUser(job.childSessionId, supplied.nativeMessageId, 2)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  await ctx.work.report(job.childSessionId, { kind: 'result', text: 'blue applied' })
  ctx.world.endTurn(job.childSessionId, 2, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'ready')
  ctx.close()
})

test('a shared owner log is snapshotted only while a publish intent is unbound', async () => {
  const ctx = boot({ perBot: 4, global: 4, perBotQueue: 4, globalQueue: 4 })
  const closed = await ctx.work.dispatch('bot-a', { briefing: 'already failed', idempotencyKey: 'closed' })
  const live = await ctx.work.dispatch('bot-a', { briefing: 'still going', idempotencyKey: 'live' })
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'failed' WHERE id = ?`).run(closed.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'failed' WHERE id = ?`).run(closed.attemptId)
  pad(ctx.world, closed.childSessionId, 500)
  pad(ctx.world, 'bot-a', 500)
  ctx.world.seeUser(live.childSessionId, live.nativeMessageId, 1)
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.deepEqual(new Set(ctx.reads.map(item => item.sessionId)), new Set([live.childSessionId]))
  const reported = field(await ctx.work.report(live.childSessionId, { kind: 'result', text: 'candidate' }), 'eventId')
  ctx.world.endTurn(live.childSessionId, 1, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(live.ticketId)!.ticket.status, 'ready')
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  const published = field(
    await ctx.work.publish('bot-a', { resultEventId: reported.eventId, text: 'for the user' }),
    'publishId',
  )
  assert.equal(published.status, 'intent')
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.deepEqual(
    ctx.reads.map(item => item.sessionId),
    ['bot-a'],
  )
  assert.equal(
    ctx.store.db.prepare(`SELECT status FROM user_deliveries WHERE publish_id = ?`).get(published.publishId).status,
    'intent',
  )
  ctx.world.toolCall('bot-a', 'foundations_publish', { resultEventId: reported.eventId, text: 'for the user' })
  ctx.world.assistant('bot-a', 'for the user')
  await ctx.work.tick()
  assert.equal(
    ctx.store.db.prepare(`SELECT status FROM user_deliveries WHERE publish_id = ?`).get(published.publishId).status,
    'log_bound',
  )
  assert.equal(ctx.work.detail(live.ticketId)!.ticket.status, 'delivered')
  assert.equal(
    ctx.reads.some(item => item.sessionId === closed.childSessionId),
    false,
  )
  ctx.reads.length = 0
  pad(ctx.world, 'bot-a', 500)
  for (let i = 0; i < 3; i++) await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  ctx.close()
})

test('a pending input still flushes while a closed sibling log is not read', async () => {
  const ctx = boot({ perBot: 4, global: 4 })
  const closed = await ctx.work.dispatch('bot-a', { briefing: 'done', idempotencyKey: 'done' })
  const pending = await ctx.work.dispatch('bot-a', { briefing: 'flush me', idempotencyKey: 'flush' })
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'failed' WHERE id = ?`).run(closed.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'failed' WHERE id = ?`).run(closed.attemptId)
  pad(ctx.world, closed.childSessionId, 200)
  ctx.store.db
    .prepare(
      `UPDATE work_inputs SET flush_status = 'intent', flush_attempts = 0, flush_pid = NULL WHERE native_message_id = ?`,
    )
    .run(pending.nativeMessageId)
  ctx.world.forgetLog(pending.childSessionId, pending.nativeMessageId)
  const pushes = ctx.world.pushes.length
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(ctx.world.pushes.length, pushes + 1)
  assert.equal(ctx.world.pushes.at(-1)!.messageId, pending.nativeMessageId)
  assert.equal(
    ctx.store.db
      .prepare(`SELECT flush_status FROM work_inputs WHERE native_message_id = ?`)
      .get(pending.nativeMessageId).flush_status,
    'accepted',
  )
  assert.equal(
    ctx.reads.some(item => item.sessionId === closed.childSessionId),
    false,
  )
  ctx.close()
})

test('a failure notice is admitted after the child log is no longer reread', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', { briefing: 'fail open', idempotencyKey: 'fail-open' })
  ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  await ctx.work.tick()
  const reported = field(await ctx.work.report(job.childSessionId, { kind: 'failure', text: 'disk full' }), 'eventId')
  ctx.world.endTurn(job.childSessionId, 1, 'completed')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'failed')
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  assert.equal(ctx.world.pendingIds('bot-a').length > 0, true)
  const notices = ctx.work.detail(job.ticketId)!.notices
  assert.equal(
    notices.some(item => item.event_id === reported.eventId),
    true,
  )
  ctx.close()
})

test('a failed attempt with a pending result is reconciled once, then left alone', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', { briefing: 'half applied', idempotencyKey: 'half' })
  ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  await ctx.work.tick()
  const reported = field(await ctx.work.report(job.childSessionId, { kind: 'result', text: 'late' }), 'eventId')
  assert.equal(reported.applyStatus, 'pending_completion')
  ctx.world.endTurn(job.childSessionId, 1, 'completed')
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'failed' WHERE id = ?`).run(job.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'failed' WHERE id = ?`).run(job.attemptId)
  ctx.reads.length = 0
  await ctx.work.tick()
  assert.equal(
    ctx.reads.some(item => item.sessionId === job.childSessionId),
    true,
  )
  assert.equal(
    ctx.work.detail(job.ticketId)!.events.find(item => item.event_id === reported.eventId)!.apply_status,
    'stale',
  )
  ctx.reads.length = 0
  pad(ctx.world, job.childSessionId, 200)
  await ctx.work.tick()
  await ctx.work.tick()
  assert.equal(ctx.reads.length, 0)
  ctx.close()
})
