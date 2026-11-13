import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../src/store.ts'
import { createEngine } from '../src/engine.ts'
import { createMockWorld } from '../src/work-mock.ts'
import { createWorkRuntime } from '../src/work-worker.ts'
import { createTicketBook } from '../src/work-tickets.ts'
import { nextLiveFrame, openWorkLive } from '../src/work-http.ts'
import { childCreateOptions, DEFAULT_WORK_BUDGET, estimateWorkerBudget } from '../src/work-admit.ts'
import { workToolDefinitions } from '../src/work-tools.ts'
import { createTriggers } from '../src/triggers.ts'
import { durableFollowup } from '../src/work-durable.ts'
import { field, present } from './narrow.ts'

function boot(budget?: Partial<typeof DEFAULT_WORK_BUDGET>) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-work-'))
  const logs: Array<{ level: string; message: string }> = []
  const trips: Array<{ sessionId: string; trip: any }> = []
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
    childPresent: sessionId => world.hasSession(sessionId),
    now: () => new Date(clock.ms),
    pid: 42,
    schedule: (fn, ms) => {
      scheduled = { fn, ms }
      return () => {
        if (scheduled?.fn === fn) scheduled = null
      }
    },
    log: (level, message) => logs.push({ level, message }),
    onMainBudget: (sessionId, trip) => trips.push({ sessionId, trip }),
    ...(budget ? { budget } : {}),
  })
  engine.markBot('bot-a')
  engine.ensureSession('plain-a')
  return {
    logs,
    trips,
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

async function dispatched(ctx: any, briefing = 'sort the attachments', key = 'job-1') {
  return ctx.work.dispatch('bot-a', { briefing, idempotencyKey: key, ownerSessionId: 'plain-a' })
}

test('create options omit parentAgent and fork lineage', () => {
  const options = childCreateOptions('worker-1', '/tmp/work')
  assert.equal(Object.hasOwn(options, 'parentAgent'), false)
  assert.equal(options.meta != null && Object.hasOwn(options.meta, 'parentSession'), false)
  assert.equal(options.meta!.cwd, '/tmp/work')
  assert.equal(Object.hasOwn(childCreateOptions('worker-2'), 'meta'), false)
  const modeled = childCreateOptions('worker-3', '', { provider: 'foundations-mock', model: 'mock-1' })
  assert.deepEqual(modeled.agentOptions, { provider: 'foundations-mock', model: 'mock-1' })
  assert.equal(Object.hasOwn(modeled, 'parentAgent'), false)
})

test('schema v4 adds work tables and leaves delivery kinds unchanged', () => {
  const ctx = boot()
  const versions = ctx.store.db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row: any) => row.version)
  assert.deepEqual(versions, [1, 2, 3, 4])
  const kinds = ctx.store.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'deliveries'`).get().sql
  assert.match(kinds, /message','timer','webhook'/)
  assert.doesNotMatch(kinds, /briefing/)
  ctx.close()
})

test('ordinary session dispatch is forbidden and writes no ticket', async () => {
  const ctx = boot()
  const denied = await ctx.work.dispatch('plain-a', { briefing: 'do not dispatch' })
  assert.equal(denied.code, 'FORBIDDEN')
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 0)
  ctx.close()
})

test('dispatch ignores a foreign owner and does not wait for the worker turn', async () => {
  const ctx = boot()
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const slow = createMockWorld()
  const work = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: async spec => {
      await gate
      return slow.createChild(spec)
    },
    push: (...args) => slow.push(...args),
    logHas: (...args) => slow.logHas(...args),
    pendingIds: id => slow.pendingIds(id),
    snapshot: id => slow.snapshot(id),
    now: () => new Date(ctx.clock.ms),
  })
  const pending = work.dispatch('bot-a', {
    briefing: 'take your time',
    idempotencyKey: 'slow',
    ownerSessionId: 'plain-a',
  })
  release!()
  const result = await pending
  assert.equal(result.status, 'enqueued')
  assert.equal(result.ticketStatus, 'enqueued')
  assert.equal(result.flush, 'accepted')
  assert.equal(result.childSessionId, `worker-${result.ticketId}`)
  assert.equal(Object.hasOwn(slow.calls[0], 'parentAgent'), false)
  assert.equal(ctx.engine.isBot(result.childSessionId), false)
  assert.equal(ctx.engine.binding(result.childSessionId).kind, 'session')
  const row = ctx.store.db.prepare('SELECT owner_session_id FROM work_tickets WHERE id = ?').get(result.ticketId)
  assert.equal(row.owner_session_id, 'bot-a')
  const splice = slow.events(result.childSessionId).find((event: any) => event!.type === 'agent/inbox/spliced')
  assert.equal(present(splice).data.target, 'next-turn')
  assert.equal(
    slow.events(result.childSessionId).some((event: any) => event!.type === 'turn/end'),
    false,
  )
  assert.equal(result.status === 'started', false)
  const pushed = slow.pushes[0].text
  const expected = estimateWorkerBudget('take your time', null)
  assert.match(pushed, /\[foundations:briefing\]/)
  assert.match(pushed, new RegExp(`budget_wall_ms: ${expected.wallMs}`))
  assert.match(pushed, new RegExp(`budget_max_tokens: ${expected.maxTokens}`))
  assert.match(pushed, /no step cap/)
  assert.match(pushed, /asks the main session for more/)
  assert.doesNotMatch(pushed, /budget_steps:/)
  assert.doesNotMatch(pushed, /\[foundations:message\]/)
  assert.equal(ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM deliveries`).get().n, 0)
  ctx.close()
})

test('create failure stays accepted without a child handle', async () => {
  const ctx = boot()
  ctx.world.state.failCreate = true
  const result = await dispatched(ctx, 'cannot create', 'fail-create')
  assert.equal(result.status, 'accepted')
  assert.equal(result.ticketStatus, 'accepted')
  assert.equal(result.childSessionId, null)
  assert.equal(result.flush, 'pending')
  assert.equal(result.nativeMessageId, null)
  assert.equal(result.fencingToken, 1)
  const again = await dispatched(ctx, 'cannot create', 'fail-create')
  assert.equal(again.replayed, true)
  assert.equal(again.ticketId, result.ticketId)
  assert.equal(ctx.world.calls.length, 1)
  ctx.close()
})

test('unconfirmed flush stays accepted even when the child exists', async () => {
  const ctx = boot()
  ctx.world.state.flushMode = 'ambiguous'
  const result = await dispatched(ctx, 'flush unconfirmed', 'amb')
  assert.equal(result.status, 'accepted')
  assert.equal(result.flush, 'ambiguous')
  assert.equal(result.childSessionId, `worker-${result.ticketId}`)
  assert.equal(result.ticketStatus, 'accepted')
  const attempt = ctx.store.db.prepare('SELECT status FROM work_attempts WHERE id = ?').get(result.attemptId)
  assert.equal(attempt.status, 'starting')
  ctx.close()
})

test('claimed is not started; user/message is', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const claimed = ctx.world.claim(result.childSessionId)
  ctx.work.observeClaimed(result.childSessionId, claimed!.messageId, claimed!.turn)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'enqueued')
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, claimed!.turn)
  ctx.work.observeSession(result.childSessionId, seen)
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'started')
  ctx.close()
})

test('user pending holds an unadmitted notice; an admitted notice stays ahead', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  const userId = ctx.world.postUser('bot-a', 'hear me first')
  const progress = await ctx.work.report(result.childSessionId, {
    kind: 'progress',
    text: 'halfway there',
    attemptId: 'forged-attempt',
    ticketId: 'forged-ticket',
  })
  assert.equal(progress.ok, true)
  const event = ctx.work.detail(result.ticketId)!.events[0]
  assert.equal(event.attempt_id, result.attemptId)
  assert.notEqual(event.attempt_id, 'forged-attempt')
  const held = await ctx.work.tick()
  assert.equal(held, undefined)
  assert.deepEqual(ctx.world.pendingIds('bot-a'), [userId])
  assert.equal(ctx.work.detail(result.ticketId)!.notices.length, 0)
  const first = ctx.world.claim('bot-a')
  assert.equal(first!.messageId, userId)

  const quiet = boot()
  const job = await dispatched(quiet)
  const seenJob = quiet.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  quiet.work.observeSession(job.childSessionId, seenJob)
  await quiet.work.report(job.childSessionId, { kind: 'progress', text: 'write it to the queue first' })
  await quiet.work.tick()
  const noticeId = quiet.world.pendingIds('bot-a')[0]
  const laterUser = quiet.world.postUser('bot-a', 'I arrived late')
  const claimedNotice = quiet.world.claim('bot-a')
  assert.equal(claimedNotice!.messageId, noticeId)
  assert.equal(quiet.world.pendingIds('bot-a')[0], laterUser)
  quiet.close()
  ctx.close()
})

test('starvation appends a terminal notice behind the user message already pending', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  await ctx.work.report(result.childSessionId, { kind: 'result', text: 'it is done' })
  const ended = ctx.world.endTurn(result.childSessionId, 1, 'completed')
  ctx.work.observeSession(result.childSessionId, ended)
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'ready')
  const userId = ctx.world.postUser('bot-a', 'I am still talking')
  await ctx.work.tick()
  assert.deepEqual(ctx.world.pendingIds('bot-a'), [userId])
  ctx.clock.ms += 31_000
  await ctx.work.tick()
  const pending = ctx.world.pendingIds('bot-a')
  assert.equal(pending[0], userId)
  assert.equal(pending.length, 2)
  const after = ctx.world.postUser('bot-a', 'the next line')
  assert.deepEqual(ctx.world.pendingIds('bot-a'), [userId, pending[1], after])
  ctx.close()
})

test('flush crash reconciliation follows the native message id', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const before = ctx.world.pushes.length
  ctx.store.db
    .prepare(
      `UPDATE work_inputs SET flush_status = 'flushing', flush_pid = 42, flush_attempts = 1 WHERE native_message_id = ?`,
    )
    .run(result.nativeMessageId)
  ctx.world.forgetLog(result.childSessionId, result.nativeMessageId)
  await ctx.work.tick()
  assert.equal(ctx.world.pushes.length, before)
  assert.equal(
    ctx.store.db.prepare(`SELECT flush_status FROM work_inputs WHERE native_message_id = ?`).get(result.nativeMessageId)
      .flush_status,
    'flushing',
  )

  const restarted = createWorkRuntime(ctx.store, ctx.engine, {
    createChild: spec => ctx.world.createChild(spec),
    push: (...args) => ctx.world.push(...args),
    logHas: (...args) => ctx.world.logHas(...args),
    pendingIds: id => ctx.world.pendingIds(id),
    snapshot: id => ctx.world.snapshot(id),
    now: () => new Date(ctx.clock.ms),
    pid: 7,
  })
  ctx.world.state.flushMode = 'accepted'
  await restarted.tick()
  assert.equal(ctx.world.pushes.length, before + 1)
  assert.equal(
    ctx.store.db.prepare(`SELECT flush_status FROM work_inputs WHERE native_message_id = ?`).get(result.nativeMessageId)
      .flush_status,
    'accepted',
  )
  assert.equal(present(ctx.world.pushes.at(-1)).messageId, result.nativeMessageId)

  ctx.store.db
    .prepare(
      `UPDATE work_inputs SET flush_status = 'intent', flush_attempts = 5, flush_pid = 7 WHERE native_message_id = ?`,
    )
    .run(result.nativeMessageId)
  ctx.world.forgetLog(result.childSessionId, result.nativeMessageId)
  const pushes = ctx.world.pushes.length
  await restarted.tick()
  assert.equal(ctx.world.pushes.length, pushes)
  assert.equal(
    ctx.store.db.prepare(`SELECT flush_status FROM work_inputs WHERE native_message_id = ?`).get(result.nativeMessageId)
      .flush_status,
    'dead',
  )
  ctx.close()
})

test('same fencing token with an older briefing revision is stale and unpublished', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  const reported = field(
    await ctx.work.report(result.childSessionId, {
      kind: 'result',
      text: 'the old result',
      fencingToken: 99,
      briefingRevision: 0,
    }),
    'applyStatus',
  )
  assert.equal(reported.applyStatus, 'pending_completion')
  const redirected = field(
    await ctx.work.redirect('bot-a', { ticketId: result.ticketId, text: 'try another way' }),
    'flush',
  )
  assert.equal(redirected.flush, 'accepted')
  assert.equal(redirected.briefingRevision, 2)
  assert.equal(redirected.fencingToken, 1)
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'enqueued')
  const ended = ctx.world.endTurn(result.childSessionId, 1, 'completed')
  ctx.work.observeSession(result.childSessionId, ended)
  const event = ctx.work.detail(result.ticketId)!.events.find((item: any) => item.event_id === reported.eventId)
  assert.equal(event.apply_status, 'stale')
  assert.equal(event.fencing_token, 1)
  const published = await ctx.work.publish('bot-a', { resultEventId: reported.eventId, text: 'do not send it' })
  assert.equal(published.ok, false)
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').get().n, 0)
  ctx.close()
})

test('result without a completed turn stays pending and does not become ready', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  const reported = field(
    await ctx.work.report(result.childSessionId, { kind: 'result', text: 'not finished yet' }),
    'applyStatus',
  )
  assert.equal(reported.applyStatus, 'pending_completion')
  await ctx.work.tick()
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'started')
  assert.equal(ctx.work.detail(result.ticketId)!.events[0].apply_status, 'pending_completion')
  assert.equal(ctx.work.detail(result.ticketId)!.events[0].text, 'not finished yet')
  ctx.close()
})

test('publish is one intent row and only an assistant event binds it', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  const reported = field(
    await ctx.work.report(result.childSessionId, { kind: 'result', text: 'candidate text' }),
    'eventId',
  )
  ctx.work.observeSession(result.childSessionId, ctx.world.endTurn(result.childSessionId, 1, 'completed'))
  const first = await ctx.work.publish('bot-a', { resultEventId: reported.eventId, text: 'the words for the user' })
  const second = await ctx.work.publish('bot-a', { resultEventId: reported.eventId, text: 'say it again' })
  assert.equal(first.already, false)
  assert.equal(second.already, true)
  assert.equal(second.publishId, first.publishId)
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').get().n, 1)
  assert.equal(first.status, 'intent')
  ctx.world.postUser('bot-a', '[foundations:ticket]\njust a wake-up')
  await ctx.work.tick()
  assert.equal(
    ctx.store.db.prepare(`SELECT status FROM user_deliveries WHERE publish_id = ?`).get(first.publishId).status,
    'intent',
  )
  const pushesBefore = ctx.world.pushes.length
  ctx.world.toolCall('bot-a', 'foundations_publish', {
    resultEventId: reported.eventId,
    text: 'the words for the user',
  })
  ctx.world.assistant('bot-a', 'the words for the user')
  await ctx.work.tick()
  const bound = ctx.store.db
    .prepare(`SELECT status, assistant_seq FROM user_deliveries WHERE publish_id = ?`)
    .get(first.publishId)
  assert.equal(bound.status, 'log_bound')
  assert.equal(typeof bound.assistant_seq, 'number')
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'delivered')
  await ctx.work.tick()
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').get().n, 1)
  assert.equal(
    ctx.world.pushes.slice(pushesBefore).some(item => item.text === 'the words for the user'),
    false,
  )
  assert.equal(
    ctx.store.db.prepare(`SELECT client_ack_at FROM user_deliveries WHERE publish_id = ?`).get(first.publishId)
      .client_ack_at,
    null,
  )
  ctx.close()
})

test('cancel drops an unclaimed notice and a later result cannot be published', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  await ctx.work.report(result.childSessionId, { kind: 'progress', text: 'still running' })
  await ctx.work.tick()
  assert.equal(ctx.world.pendingIds('bot-a').length, 1)
  const cancelled = await ctx.work.cancelTicket('bot-a', { ticketId: result.ticketId })
  assert.equal(cancelled.ok, true)
  assert.equal(ctx.world.pendingIds('bot-a').length, 0)
  assert.equal(present(ctx.world.cancels.at(-1)).keepInbox, false)
  const late = field(
    await ctx.work.report(result.childSessionId, { kind: 'result', text: 'a late result' }),
    'applyStatus',
  )
  assert.equal(late.applyStatus, 'stale')
  ctx.work.observeSession(result.childSessionId, ctx.world.endTurn(result.childSessionId, 1, 'completed'))
  const published = await ctx.work.publish('bot-a', { resultEventId: late.eventId, text: 'should not publish' })
  assert.equal(published.ok, false)
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').get().n, 0)
  ctx.close()
})

test('tight slot and queue caps refuse the next ticket without inserting it', async () => {
  const ctx = boot({ perBot: 1, global: 2, perBotQueue: 0, globalQueue: 0 })
  const first = await dispatched(ctx, 'the first job', 'one')
  assert.equal(first.ok, true)
  const second = await ctx.work.dispatch('bot-a', { briefing: 'the second job', idempotencyKey: 'two' })
  assert.equal(second.code, 'BUDGET')
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM work_tickets').get().n, 1)
  ctx.close()
})

test('a worker cannot dispatch or send, and a bot cannot report', async () => {
  const ctx = boot()
  const result = await dispatched(ctx)
  const denied = await ctx.work.dispatch(result.childSessionId, { briefing: 'a nested ticket' })
  assert.equal(denied.code, 'FORBIDDEN')
  const triggers = createTriggers(ctx.store, { push: async () => ({ ok: true, seq: 1 }) })
  const sent = field(
    await triggers.send(result.childSessionId, {
      targetSessionId: 'bot-a',
      text: 'should not send',
      idempotencyKey: 'w1',
    }),
    'code',
  )
  assert.equal(sent.code, 'FORBIDDEN')
  const tools = Object.fromEntries(workToolDefinitions(ctx.work, ctx.engine).map(item => [item.name, item]))
  const report = await tools.foundations_report.execute(
    { kind: 'progress', text: 'the main session must not report' },
    { agent: { id: 'bot-a' } },
  )
  assert.equal(report.code, 'FORBIDDEN')
  ctx.close()
})

test('main budget refuses the next step at pre-step, and the wall timer cancels with a hook cause', async () => {
  const ctx = boot({ chatMaxSteps: 4, chatWallMs: 120_000 })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 1 } })
  assert.equal(ctx.scheduled()!.ms, 120_000)
  ctx.work.observeSession('bot-a', {
    type: 'tool/call',
    data: { name: 'foundations_recall', arguments: { query: 'name' } },
  })
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 1 } })
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 3 } })
  assert.equal(ctx.work.gateStep('bot-a', { turn: 1, step: 4 }).kind, 'enter')
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 4 } })
  // step/end never cancels: the step that just ended may be the natural last one.
  assert.equal(ctx.world.cancels.length, 0)
  const refused = ctx.work.gateStep('bot-a', { turn: 1, step: 5 })
  assert.equal(refused.kind, 'reject')
  assert.equal(refused.kind === 'reject' && refused.trip.cause, 'main-budget:steps')
  assert.equal(ctx.world.cancels.length, 0)
  assert.equal(ctx.trips.length, 1)
  assert.equal(ctx.trips[0]!.sessionId, 'bot-a')
  assert.equal(ctx.trips[0]!.trip.notify, true)
  assert.equal(ctx.trips[0]!.trip.via, 'pre-step')
  assert.match(ctx.logs.at(-1)!.message, /main budget main-budget:steps session=bot-a turn=1 steps=4\/4/)
  assert.equal(ctx.logs.at(-1)!.level, 'warn')
  // A user steer claimed for the step still enters.
  assert.equal(ctx.work.gateStep('bot-a', { turn: 1, step: 5, claimed: 1 }).kind, 'enter')
  // Plain sessions are never gated.
  ctx.work.observeSession('plain-a', { type: 'turn/start', data: { turn: 1 } })
  ctx.work.observeSession('plain-a', { type: 'step/end', data: { turn: 1, step: 400 } })
  assert.equal(ctx.work.gateStep('plain-a', { turn: 1, step: 401 }).kind, 'enter')
  assert.equal(ctx.world.cancels.filter(item => item.sessionId === 'plain-a').length, 0)

  ctx.work.observeSession('bot-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 2 } })
  assert.equal(ctx.scheduled()!.ms, 120_000)
  ctx.clock.ms += 120_000
  ctx.scheduled()!.fn()
  assert.equal(present(ctx.world.cancels.at(-1)).keepInbox, true)
  assert.equal(present(ctx.world.cancels.at(-1)).reason, 'main-budget:wall')
  assert.equal(ctx.trips.at(-1)!.trip.via, 'timer')

  const job = await ctx.work.dispatch('bot-a', {
    briefing: 'a long task',
    idempotencyKey: 'long',
    ownerSessionId: 'plain-a',
    budget: { wallMs: DEFAULT_WORK_BUDGET.workerWallMs, maxTokens: DEFAULT_WORK_BUDGET.workerMaxTokens },
  })
  ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
  const cancels = ctx.world.cancels.length
  for (let step = 1; step <= 30; step += 1) {
    ctx.work.observeSession(job.childSessionId, { type: 'step/end', data: { turn: 1, step } })
  }
  assert.equal(ctx.world.cancels.length, cancels)
  assert.equal(ctx.work.gateStep(job.childSessionId, { turn: 1, step: 31 }).kind, 'enter')
  assert.notEqual(ctx.work.detail(job.ticketId)!.ticket.status, 'failed')
  assert.equal(ctx.scheduled()!.ms, 600_000)
  ctx.scheduled()!.fn()
  assert.equal(ctx.world.cancels.length, cancels)
  assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota.waiting, true)
  assert.equal(ctx.work.detail(job.ticketId)!.attempts.length, 1)
  ctx.close()
})

test('default budget lets the main bot use host tools for many steps and never cancels a finished turn', async () => {
  const ctx = boot()
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 1 } })
  assert.equal(ctx.scheduled()!.ms, 30 * 60_000)
  // The VPS repro: bash on step 1, a final answer on step 2.
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'bash', arguments: { command: 'date' } } })
  ctx.work.observeSession('bot-a', { type: 'tool/result', data: { name: 'bash', result: 'Wed' } })
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 1 } })
  assert.equal(ctx.work.gateStep('bot-a', { turn: 1, step: 2 }).kind, 'enter')
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 2 } })
  ctx.work.observeSession('bot-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(ctx.world.cancels.length, 0)
  assert.equal(ctx.trips.length, 0)
  // A long host-tool turn stays open until step 80.
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 2 } })
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'write', arguments: {} } })
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'foundations_dispatch', arguments: {} } })
  for (let step = 1; step < 80; step += 1) {
    ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 2, step } })
    assert.equal(ctx.work.gateStep('bot-a', { turn: 2, step: step + 1 }).kind, 'enter')
  }
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 2, step: 80 } })
  assert.equal(ctx.world.cancels.length, 0)
  assert.equal(ctx.work.gateStep('bot-a', { turn: 2, step: 81 }).kind, 'reject')
  assert.equal(ctx.world.cancels.length, 0)
  ctx.close()
})

test('a configured main cap still squeezes dispatch and host tools; a recall stays on the chat cap', async () => {
  const ctx = boot({ mainMaxSteps: 2, mainWallMs: 20_000, chatMaxSteps: 4, chatWallMs: 120_000 })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 1 } })
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'foundations_recall', arguments: {} } })
  assert.equal(ctx.scheduled()!.ms, 120_000)
  ctx.work.observeSession('bot-a', { type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls' } } })
  assert.equal(ctx.scheduled()!.ms, 20_000)
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 1 } })
  assert.equal(ctx.work.gateStep('bot-a', { turn: 1, step: 2 }).kind, 'enter')
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 1, step: 2 } })
  assert.equal(ctx.world.cancels.length, 0)
  assert.equal(ctx.work.gateStep('bot-a', { turn: 1, step: 3 }).kind, 'reject')

  // The notice turn that follows a trip does not post a second notice.
  ctx.work.observeSession('bot-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
  ctx.work.observeSession('bot-a', { type: 'turn/start', data: { turn: 2 } })
  ctx.work.observeSession('bot-a', {
    type: 'user/message',
    data: { id: 'foundations-budget:1:abc', message: { id: 'foundations-budget:1:abc' } },
  })
  ctx.work.observeSession('bot-a', {
    type: 'tool/result',
    data: { name: 'foundations_dispatch', result: { ok: true } },
  })
  assert.equal(ctx.scheduled()!.ms, 20_000)
  ctx.work.observeSession('bot-a', { type: 'step/end', data: { turn: 2, step: 2 } })
  const second = ctx.work.gateStep('bot-a', { turn: 2, step: 3 })
  assert.equal(second.kind, 'reject')
  assert.equal(second.kind === 'reject' && second.trip.notify, false)
  assert.equal(ctx.trips.length, 1)
  assert.equal(ctx.logs.filter(line => line.level === 'warn').length, 2)
  ctx.close()
})

test('an interrupt hold blocks ticket notices until the next user message or the hold expires', async () => {
  const ctx = boot()
  const job = await dispatched(ctx)
  const seen = ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  ctx.work.observeSession(job.childSessionId, seen)
  await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'halfway there' })
  const refused = ctx.work.holdNotices('plain-a')
  assert.equal(refused.ok, false)
  const held = ctx.work.holdNotices('bot-a')
  assert.equal(held.ok, true)
  const blocked = await ctx.work.admit('bot-a')
  assert.equal(blocked.reason, 'interrupt-hold')
  assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 0)
  ctx.work.observeSession('bot-a', { type: 'user/message', data: { id: 'user-next', message: { id: 'user-next' } } })
  const admitted = await ctx.work.admit('bot-a')
  assert.equal(admitted.admitted, true)
  assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1)
  const childCancels = ctx.world.cancels.filter(item => item.sessionId === job.childSessionId)
  assert.equal(childCancels.length, 0)

  const again = boot()
  const second = await dispatched(again)
  const seenSecond = again.world.seeUser(second.childSessionId, second.nativeMessageId, 1)
  again.work.observeSession(second.childSessionId, seenSecond)
  await again.work.report(second.childSessionId, { kind: 'progress', text: 'still waiting' })
  again.work.holdNotices('bot-a')
  again.clock.ms += DEFAULT_WORK_BUDGET.holdMs
  const expired = await again.work.admit('bot-a')
  assert.equal(expired.admitted, true)
  again.close()
  ctx.close()
})

test('worker budget follows the briefing estimate and clamps an explicit one', async () => {
  const ctx = boot()
  const omitted = await dispatched(ctx, 'take your time', 'estimate')
  const expected = estimateWorkerBudget('take your time', null)
  const stored = JSON.parse(ctx.work.detail(omitted.ticketId)!.ticket.budget_json)
  assert.equal(stored.wallMs, expected.wallMs)
  assert.equal(stored.maxTokens, expected.maxTokens)
  await ctx.work.cancelTicket('bot-a', { ticketId: omitted.ticketId })

  const tight = await ctx.work.dispatch('bot-a', {
    briefing: 'take your time',
    idempotencyKey: 'tight',
    budget: { wallMs: 90_000, maxTokens: 8_000 },
  })
  const clamped = JSON.parse(ctx.work.detail(tight.ticketId)!.ticket.budget_json)
  assert.equal(clamped.wallMs, 90_000)
  assert.equal(clamped.maxTokens, 8_000)
  await ctx.work.cancelTicket('bot-a', { ticketId: tight.ticketId })

  const high = await ctx.work.dispatch('bot-a', {
    briefing: 'take your time',
    idempotencyKey: 'high',
    budget: { wallMs: 9_999_999, maxTokens: 9_999_999 },
  })
  const capped = JSON.parse(ctx.work.detail(high.ticketId)!.ticket.budget_json)
  assert.equal(capped.wallMs, DEFAULT_WORK_BUDGET.workerWallMs)
  assert.equal(capped.maxTokens, DEFAULT_WORK_BUDGET.workerMaxTokens)
  ctx.close()
})

test('a granted limit asks the main bot for more instead of failing the ticket', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', {
    briefing: 'take your time',
    idempotencyKey: 'extend',
    ownerSessionId: 'plain-a',
    budget: { wallMs: 120_000, maxTokens: 5_000 },
  })
  const seen = ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1)
  ctx.work.observeSession(job.childSessionId, seen)
  ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
  ctx.work.observeSession(job.childSessionId, {
    type: 'assistant/message',
    seq: 4,
    data: { usage: { totalTokens: 1_000 } },
  })
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')

  ctx.work.observeSession(job.childSessionId, {
    type: 'assistant/message',
    seq: 4,
    data: { usage: { totalTokens: 9_000 } },
  })
  ctx.work.observeSession(job.childSessionId, {
    type: 'assistant/message',
    seq: 5,
    data: { usage: { totalTokens: 5_000 } },
  })
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  assert.equal(
    ctx.world.cancels.some(call => call.sessionId === job.childSessionId),
    false,
  )
  const asked = ctx.work.detail(job.ticketId)!.events.at(-1)
  assert.match(asked.text, /\[foundations:extension\]/)
  assert.match(asked.text, /foundations_grant/)

  ctx.work.observeSession(job.childSessionId, {
    type: 'assistant/message',
    seq: 6,
    data: { usage: { totalTokens: 9_000 } },
  })
  assert.equal(
    ctx.work.detail(job.ticketId)!.events.filter((event: any) => event!.text?.includes('[foundations:extension]'))
      .length,
    1,
  )

  const before = ctx.world.pushes.length
  await ctx.work.tick()
  assert.match(present(ctx.world.pushes.at(-1)).text, /foundations_grant/)
  assert.ok(ctx.world.pushes.length > before)

  const tools = Object.fromEntries(workToolDefinitions(ctx.work, ctx.engine).map(item => [item.name, item]))
  const forbidden = await tools.foundations_grant.execute(
    { ticketId: job.ticketId, wallMs: 1000 },
    { agent: { id: 'plain-a' } },
  )
  assert.equal(forbidden.code, 'FORBIDDEN')
  const granted = await tools.foundations_grant.execute(
    { ticketId: job.ticketId, wallMs: 60_000, maxTokens: 20_000 },
    { agent: { id: 'bot-a' } },
  )
  assert.equal(granted.wallMs, 180_000)
  assert.equal(granted.maxTokens, 25_000)
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).extension, null)

  const denied = await tools.foundations_grant.execute(
    { ticketId: job.ticketId, deny: true },
    { agent: { id: 'bot-a' } },
  )
  assert.equal(denied.denied, true)
  assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'failed')
  assert.equal(
    ctx.world.cancels.some(call => call.sessionId === job.childSessionId && call.keepInbox === false),
    true,
  )
  const failure = ctx.work.detail(job.ticketId)!.events.find((event: any) => event!.kind === 'failure')
  assert.match(failure.text, /refused more budget/)
  ctx.close()
})

test('token usage at the host ceiling pauses for an explicit decision', async () => {
  const ctx = boot()
  const job = await ctx.work.dispatch('bot-a', {
    briefing: 'take your time',
    idempotencyKey: 'ceiling-tokens',
    ownerSessionId: 'plain-a',
    budget: { wallMs: 120_000, maxTokens: DEFAULT_WORK_BUDGET.workerMaxTokens },
  })
  ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
  ctx.work.observeSession(job.childSessionId, {
    type: 'assistant/message',
    seq: 8,
    data: { usage: { totalTokens: DEFAULT_WORK_BUDGET.workerMaxTokens } },
  })
  const quota = JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota
  assert.equal(quota.waiting, true)
  assert.equal(quota.reason, 'host-ceiling')
  assert.equal(ctx.world.cancels.length, 0)
  assert.equal(
    ctx.work.detail(job.ticketId)!.events.filter((event: any) => event.text?.includes('[foundations:extension]'))
      .length,
    1,
  )
  ctx.close()
})

test('lease expiry and enqueue wall fail the attempt and do not start another', async () => {
  const ctx = boot()
  const result = await dispatched(ctx, 'will expire', 'lease')
  const seen = ctx.world.seeUser(result.childSessionId, result.nativeMessageId, 1)
  ctx.work.observeSession(result.childSessionId, seen)
  ctx.world.dropChild(result.childSessionId)
  ctx.store.db
    .prepare(`UPDATE work_attempts SET lease_until = ? WHERE id = ?`)
    .run('2026-11-07T00:00:00.000Z', result.attemptId)
  await ctx.work.tick()
  assert.equal(ctx.work.detail(result.ticketId)!.ticket.status, 'failed')
  assert.equal(ctx.work.detail(result.ticketId)!.attempts.length, 1)
  assert.equal(
    ctx.world.cancels.some(
      call =>
        call.sessionId === result.childSessionId && call.reason === 'worker-expire:lease' && call.keepInbox === false,
    ),
    true,
  )

  const other = boot()
  const queued = await dispatched(other, 'never started', 'wall')
  other.store.db
    .prepare(`UPDATE work_inputs SET updated_at = ? WHERE native_message_id = ?`)
    .run('2026-11-07T00:00:00.000Z', queued.nativeMessageId)
  await other.work.tick()
  assert.equal(other.work.detail(queued.ticketId)!.ticket.status, 'failed')
  assert.equal(other.world.calls.length, 1)
  other.close()
  ctx.close()
})

test('retry keeps the child id, bumps the fence, and a resident-less dispatch only records acceptance', async () => {
  const ctx = boot()
  const result = await dispatched(ctx, 'do it again', 'retry-me')
  ctx.store.db.prepare(`UPDATE work_tickets SET status = 'failed' WHERE id = ?`).run(result.ticketId)
  ctx.store.db.prepare(`UPDATE work_attempts SET status = 'failed' WHERE id = ?`).run(result.attemptId)
  const calls = ctx.world.calls.length
  const retried = field(await ctx.work.retry('bot-a', { ticketId: result.ticketId }), 'flush')
  assert.equal(retried.flush, 'accepted')
  assert.equal(retried.childSessionId, result.childSessionId)
  assert.equal(retried.fencingToken, 2)
  assert.equal(ctx.world.calls.length, calls)
  const fresh = boot()
  const quiet = createWorkRuntime(fresh.store, fresh.engine, { resident: false, push: async () => ({ ok: false }) })
  const intent = await quiet.dispatch('bot-a', { briefing: 'record it first' })
  assert.equal(intent.status, 'accepted')
  assert.equal(intent.flush, 'pending')
  assert.equal(intent.childSessionId, null)
  assert.match(intent.message, /Only a resident host continues/)
  assert.equal(
    fresh.store.db.prepare('SELECT child_session_id FROM work_tickets WHERE id = ?').get(intent.ticketId)
      .child_session_id,
    null,
  )
  fresh.close()
  ctx.close()
})

test('live frame is quiet until a ticket changes, then carries that card', async () => {
  const ctx = boot()
  const first = nextLiveFrame(ctx.work, '', null)
  assert.match(first.frame, /event: snapshot/)
  assert.match(first.frame, /"signals":\{\}/)
  const quiet = nextLiveFrame(ctx.work, '', first.stamp)
  assert.equal(quiet.frame, '')
  const result = await dispatched(ctx)
  const changed = nextLiveFrame(ctx.work, 'bot-a', quiet.stamp)
  const body = JSON.parse(changed.frame.slice(changed.frame.indexOf('data: ') + 6))
  assert.equal(body.ok, true)
  assert.deepEqual(body.signals['bot-a'], ['enqueued'])
  assert.equal(body.cards[0].ticket.id, result.ticketId)
  assert.match(body.cards[0].summary, /sort the attachments/)
  const same = nextLiveFrame(ctx.work, 'bot-a', changed.stamp)
  assert.equal(same.frame, '')
  const all = ctx.work.liveBoardAll() as {
    cards: Record<string, Array<{ ticket: { id: string } }>>
    signals: Record<string, string[]>
  }
  assert.equal(all.cards['bot-a'][0].ticket.id, result.ticketId)
  assert.deepEqual(all.signals['bot-a'], ['enqueued'])
  const chunks: any[] = []
  let close = () => {}
  let ended = false
  const pending = openWorkLive(
    {
      socket: { setTimeout() {} },
      on(event: any, fn: any) {
        if (event === 'close') close = fn
      },
    },
    {
      status: 0,
      headers: null,
      get writableEnded() {
        return ended
      },
      writeHead(status: any, headers: any) {
        this.status = status
        this.headers = headers
      },
      write(chunk: any) {
        chunks.push(String(chunk))
        return true
      },
      end() {
        ended = true
      },
      on() {},
    },
    'bot-a',
    ctx.work,
  )
  assert.match(chunks.join(''), new RegExp(result.ticketId))
  close()
  await pending
  ctx.close()
})

test('durable follow-up dies after five failed attempts', async () => {
  let attempts = 0
  let status = 'intent'
  const result = await durableFollowup({
    attempts: 4,
    markFlushing: () => {
      attempts = 5
      status = 'flushing'
    },
    push: async () => ({ ok: false, error: 'down' }),
    markAccepted: () => {
      status = 'accepted'
    },
    markAmbiguous: () => {
      status = 'ambiguous'
    },
    markDead: () => {
      status = 'dead'
    },
    markRetry: () => {
      status = 'intent'
    },
  })
  assert.equal(result.status, 'dead')
  assert.equal(status, 'dead')
  assert.equal(attempts, 5)
})

// Local t161u investigation: characterize the existing behavior before live logs
// establish which path was taken. These tests invoke only the in-process mock.
test('investigation: a full wall grant waits at the host ceiling without failing or restarting', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect budget behavior',
      idempotencyKey: 'wall-ceiling-investigation',
      budget: { wallMs: DEFAULT_WORK_BUDGET.workerWallMs, maxTokens: 10_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.clock.ms += DEFAULT_WORK_BUDGET.workerWallMs
    ctx.scheduled()!.fn()
    const detail = ctx.work.detail(job.ticketId)!
    assert.equal(detail.ticket.status, 'started')
    assert.equal(detail.attempts.length, 1)
    assert.equal(
      detail.events.some((e: any) => e.text?.includes('[foundations:extension]')),
      true,
    )
    assert.equal(JSON.parse(detail.ticket.budget_json).quota.reason, 'host-ceiling')
    assert.equal(ctx.world.cancels.length, 0)
    const granted = await ctx.work.grant('bot-a', { ticketId: job.ticketId, wallMs: 60_000 })
    assert.equal(granted.code, 'VALIDATION')
    for (let i = 0; i < 3; i++) await ctx.work.tick()
    assert.equal(ctx.work.detail(job.ticketId)!.attempts.length, 1)
    assert.equal(ctx.world.calls.length, 1)
    assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM work_tickets').get().n, 1)

    // A fresh dispatch, not budget failure/tick alone, can repeat the same work.
    const second = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect budget behavior',
      idempotencyKey: 'fresh-dispatch-investigation',
    })
    assert.notEqual(second.ticketId, job.ticketId)
    assert.equal(ctx.world.calls.length, 2)
  } finally {
    ctx.close()
  }
})

test('investigation: one usage overshoot pauses at the host ceiling rather than failing', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect token overshoot',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: DEFAULT_WORK_BUDGET.workerMaxTokens } },
    })
    const detail = ctx.work.detail(job.ticketId)!
    assert.equal(JSON.parse(detail.ticket.budget_json).quota.reason, 'host-ceiling')
    assert.equal(
      detail.events.some((e: any) => e.text?.includes('[foundations:extension]')),
      true,
    )
    assert.equal(ctx.world.cancels.length, 0)
  } finally {
    ctx.close()
  }
})

test('investigation: grant retains the same attempt and sums usage without resetting it', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect in-place grant',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    const usage = (seq: number, totalTokens: number) =>
      ctx.work.observeSession(job.childSessionId, {
        type: 'assistant/message',
        seq,
        data: { usage: { inputTokens: totalTokens - 100, outputTokens: 100, totalTokens } },
      })
    usage(10, 3_000)
    usage(11, 3_000)
    const before = ctx.work.detail(job.ticketId)!
    assert.match(before.events.at(-1).text, /tokens used: 6000/)
    const pushes = ctx.world.pushes.length
    const creates = ctx.world.calls.length
    const granted = await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10_000 })
    assert.equal(granted.maxTokens, 15_000)
    const after = ctx.work.detail(job.ticketId)!
    assert.equal(after.ticket.status, 'started')
    assert.equal(after.ticket.active_attempt_id, before.ticket.active_attempt_id)
    assert.equal(after.ticket.child_session_id, job.childSessionId)
    assert.equal(after.attempts.length, 1)
    assert.equal(ctx.world.calls.length, creates)
    assert.equal(ctx.world.pushes.length, pushes)
    assert.equal(ctx.world.cancels.length, 0)
    usage(12, 9_000)
    const asks = ctx.work.detail(job.ticketId)!.events.filter((e: any) => e.text?.includes('[foundations:extension]'))
    assert.equal(asks.length, 2)
    assert.match(asks.at(-1)!.text, /tokens used: 15000/)
  } finally {
    ctx.close()
  }
})

test('investigation: budget decisions bypass pending user input immediately', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect extension admission',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    ctx.world.postUser('bot-a', 'ordinary queued user input')
    const admitted = await ctx.work.admit('bot-a')
    assert.equal(admitted.admitted, true)
    assert.equal(admitted.reason, 'budget-decision')
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1)
    assert.match(present(ctx.world.pushes.at(-1)).text, /foundations_grant/)
    assert.doesNotMatch(present(ctx.world.pushes.at(-1)).text, /failed \(failed\)/)
    // A late in-flight usage overshoot must remain paused, not fail.
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 11,
      data: { usage: { totalTokens: DEFAULT_WORK_BUDGET.workerMaxTokens } },
    })
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  } finally {
    ctx.close()
  }
})

test('investigation: grant after worker turn end changes budget but does not wake the worker', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'inspect idle grant',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.world.claim(job.childSessionId)
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'completed'))
    const pushes = ctx.world.pushes.length
    const granted = await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10_000 })
    assert.equal(granted.ok, true)
    assert.equal(ctx.world.pushes.length, pushes)
    assert.deepEqual(ctx.world.pendingIds(job.childSessionId), [])
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(ctx.work.detail(job.ticketId)!.attempts.length, 1)
  } finally {
    ctx.close()
  }
})

test('an extension-only wake is admitted immediately even when a notice or user is pending', async () => {
  const ctx = boot()
  try {
    const prior = await ctx.work.dispatch('bot-a', {
      briefing: 'ordinary progress first',
      idempotencyKey: 'ordinary-progress',
    })
    ctx.work.observeSession(prior.childSessionId, ctx.world.seeUser(prior.childSessionId, prior.nativeMessageId, 1))
    await ctx.work.report(prior.childSessionId, { kind: 'progress', text: 'still working' })
    await ctx.work.tick()
    assert.equal(ctx.work.detail(prior.ticketId)!.notices.length, 1)
    assert.equal(ctx.world.pendingIds('bot-a').length, 1)

    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'needs a grant',
      idempotencyKey: 'extension-starve',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    ctx.world.postUser('bot-a', 'user is still talking')
    const admitted = await ctx.work.admit('bot-a')
    assert.equal(admitted.admitted, true)
    assert.equal(admitted.reason, 'budget-decision')
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1)
    assert.match(present(ctx.world.pushes.at(-1)).text, /\[foundations:extension\]/)
    assert.match(present(ctx.world.pushes.at(-1)).text, /foundations_grant/)
    assert.doesNotMatch(present(ctx.world.pushes.at(-1)).text, /failed \(failed\)/)
  } finally {
    ctx.close()
  }
})

test('ordinary progress does not starve-bypass a pending user message', async () => {
  const ctx = boot()
  try {
    const job = await dispatched(ctx, 'ordinary progress only', 'ordinary-starve')
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    await ctx.work.report(job.childSessionId, { kind: 'progress', text: 'halfway there' })
    ctx.world.postUser('bot-a', 'hear me first')
    ctx.clock.ms += DEFAULT_WORK_BUDGET.starveMs + 1
    const admitted = await ctx.work.admit('bot-a')
    assert.equal(admitted.admitted, false)
    assert.equal(admitted.reason, 'user-pending')
    assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 0)
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
  } finally {
    ctx.close()
  }
})

test('an extension and a later failure are not delivered as one contradictory grant notice', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'grant then fail',
      idempotencyKey: 'extension-then-fail',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    ctx.world.postUser('bot-a', 'hold the notice')
    ctx.clock.ms += DEFAULT_WORK_BUDGET.starveMs + 1
    const granted = await ctx.work.admit('bot-a')
    assert.equal(granted.admitted, true)
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.match(present(ctx.world.pushes.at(-1)).text, /foundations_grant/)
    assert.doesNotMatch(present(ctx.world.pushes.at(-1)).text, /failed \(failed\)/)

    const other = boot()
    const late = await other.work.dispatch('bot-a', {
      briefing: 'fail before the grant arrives',
      idempotencyKey: 'fail-before-grant',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    other.work.observeSession(late.childSessionId, other.world.seeUser(late.childSessionId, late.nativeMessageId, 1))
    other.work.observeSession(late.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    other.work.observeSession(late.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    other.world.postUser('bot-a', 'hold the notice')
    other.clock.ms += 60_000
    other.work.observeSession(late.childSessionId, {
      type: 'assistant/message',
      seq: 11,
      data: { usage: { totalTokens: DEFAULT_WORK_BUDGET.workerMaxTokens } },
    })
    await other.work.grant('bot-a', { ticketId: late.ticketId, deny: true })
    assert.equal(other.work.detail(late.ticketId)!.ticket.status, 'failed')
    other.clock.ms += DEFAULT_WORK_BUDGET.starveMs + 1
    const delivered = await other.work.admit('bot-a')
    assert.equal(delivered.admitted, true)
    const notice = present(other.world.pushes.at(-1)).text
    assert.match(notice, /failed \(failed\)/)
    assert.doesNotMatch(notice, /Do not mark the ticket failed/)
    assert.doesNotMatch(notice, /Call foundations_grant/)
    other.close()
  } finally {
    ctx.close()
  }
})

test('an open extension request is not lease-expired by expireQuiet', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'wait for a grant',
      idempotencyKey: 'extension-holds-lease',
      budget: { wallMs: 120_000, maxTokens: 5_000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 5_000 } },
    })
    assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).extension, 'open')
    // Drop the child so lease renewal cannot mask the expireQuiet guard.
    ctx.world.dropChild(job.childSessionId)
    ctx.store.db
      .prepare(`UPDATE work_attempts SET lease_until = ? WHERE id = ?`)
      .run('2026-11-07T00:00:00.000Z', job.attemptId)
    const cancels = ctx.world.cancels.length
    await ctx.work.tick()
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).extension, 'open')
    assert.equal(ctx.work.detail(job.ticketId)!.attempts.length, 1)
    assert.equal(ctx.world.cancels.length, cancels)
  } finally {
    ctx.close()
  }
})

test('a live child without turn/end renews its lease across a gap longer than leaseMs', async () => {
  const ctx = boot()
  try {
    const job = await dispatched(ctx, 'long silent turn', 'live-lease-renew')
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    const before = ctx.store.db.prepare('SELECT lease_until FROM work_attempts WHERE id = ?').get(job.attemptId)
    ctx.clock.ms += DEFAULT_WORK_BUDGET.leaseMs + 5_000
    await ctx.work.tick()
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    const after = ctx.store.db.prepare('SELECT lease_until FROM work_attempts WHERE id = ?').get(job.attemptId)
    assert.ok(Date.parse(after.lease_until) > Date.parse(before.lease_until))
    assert.ok(Date.parse(after.lease_until) > ctx.clock.ms)
    assert.equal(
      ctx.world.cancels.some(call => call.sessionId === job.childSessionId),
      false,
    )
  } finally {
    ctx.close()
  }
})

test('a dead child can still lease-expire and is cancelled', async () => {
  const ctx = boot()
  try {
    const job = await dispatched(ctx, 'child already gone', 'dead-lease')
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.world.dropChild(job.childSessionId)
    ctx.clock.ms += DEFAULT_WORK_BUDGET.leaseMs + 1
    await ctx.work.tick()
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'failed')
    assert.equal(ctx.work.detail(job.ticketId)!.attempts.length, 1)
    const stopped = ctx.world.cancels.find(call => call.sessionId === job.childSessionId)
    assert.equal(stopped?.reason, 'worker-expire:lease')
    assert.equal(stopped?.keepInbox, false)
  } finally {
    ctx.close()
  }
})

test('budget pre-step suspension makes no next dispatch across lease/host-wall time; sufficient grant resumes same identity', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'pause the loop',
      budget: { maxTokens: 5000, wallMs: 120000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.clock.ms += 3000
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 10000 } },
    })
    const before = ctx.work.detail(job.ticketId)!
    const identity = [before.ticket.active_attempt_id, before.ticket.child_session_id, before.attempts[0].fencing_token]
    const abort = new AbortController()
    let dispatches = 0
    const boundary = ctx.work.waitForBudget(job.childSessionId, abort.signal).then(allowed => {
      if (allowed) dispatches++
      return allowed
    })
    assert.equal(dispatches, 0)
    assert.equal(ctx.scheduled(), null, 'no expiry timer while waiting')
    for (let i = 0; i < 4; i++) {
      ctx.clock.ms += 600000
      await ctx.work.tick()
    }
    assert.equal(dispatches, 0)
    assert.equal(ctx.world.calls.length, 1)
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(ctx.world.cancels.length, 0)
    const insufficient = await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 1000 })
    assert.equal(insufficient.ok, true)
    assert.equal(insufficient.waitingBudget, true)
    assert.equal(insufficient.usedTokens, 10000)
    assert.equal(insufficient.requiredMaxTokens, 10001)
    assert.equal(insufficient.minimumAdditionalTokens, 4001)
    assert.equal(dispatches, 0)
    await ctx.work.tick()
    assert.equal(
      ctx.work.detail(job.ticketId)!.events.filter((e: any) => e.text.includes('[foundations:extension]')).length,
      1,
    )
    const granted = await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 5000 })
    assert.equal(granted.waitingBudget, false)
    assert.equal(granted.activeElapsedMs, 3000, 'paused time is excluded, usage is never reset')
    assert.equal(await boundary, true)
    assert.equal(dispatches, 1)
    assert.equal(ctx.scheduled()!.ms, 117000)
    const after = ctx.work.detail(job.ticketId)!
    assert.deepEqual(
      [after.ticket.active_attempt_id, after.ticket.child_session_id, after.attempts[0].fencing_token],
      identity,
    )
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 10000 } },
    })
    assert.equal(
      JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota.tokens,
      10000,
      'replay dedup survives pause',
    )
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 11,
      data: { usage: { totalTokens: 1200 } },
    })
    assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota.tokens, 11200)
    const second = ctx.work.waitForBudget(job.childSessionId, abort.signal)
    await ctx.work.cancelTicket('bot-a', { ticketId: job.ticketId })
    assert.equal(await second, false)
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'cancelled')
    assert.equal((await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 50000 })).code, 'VALIDATION')
  } finally {
    ctx.close()
  }
})

test('waiting at an unextendable ceiling survives clock advances and deny terminates the suspended loop', async () => {
  const ctx = boot({ workerWallMs: 1000 })
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'hard wall', budget: { wallMs: 1000 } })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.clock.ms += 1000
    ctx.scheduled()!.fn()
    const blocked = ctx.work.waitForBudget(job.childSessionId)
    const grant = await ctx.work.grant('bot-a', { ticketId: job.ticketId, wallMs: 500000 })
    assert.equal(grant.code, 'VALIDATION')
    assert.equal(grant.waitingBudget, true)
    assert.equal(grant.budgetReason, 'host-ceiling')
    assert.equal(grant.hostWallHeadroomMs, 0)
    ctx.clock.ms += 10000000
    await ctx.work.tick()
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'started')
    const deny = await ctx.work.grant('bot-a', { ticketId: job.ticketId, deny: true })
    assert.equal(deny.denied, true)
    assert.equal(await blocked, false)
    assert.equal(ctx.world.cancels.at(-1)?.reason, 'grant-denied')
    assert.equal(ctx.scheduled(), null)
  } finally {
    ctx.close()
  }
})

test('restored durable waits do not create children or dispatch models; grant alone cannot resurrect a disposed turn', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'restart while paused',
      budget: { maxTokens: 5000, wallMs: 120000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 6000 } },
    })
    const abort = new AbortController()
    const old = ctx.work.waitForBudget(job.childSessionId, abort.signal)
    abort.abort()
    assert.equal(await old, false)
    const restored = createWorkRuntime(ctx.store, ctx.engine, {
      now: () => new Date(ctx.clock.ms),
      schedule: () => () => {},
    })
    ctx.clock.ms += 10000000
    await restored.tick()
    assert.equal(restored.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(JSON.parse(restored.detail(job.ticketId)!.ticket.budget_json).quota.waiting, true)
    const granted = await restored.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10000 })
    assert.equal(granted.continuation, 'awaiting-host-turn')
    assert.equal(granted.waitingBudget, true)
    assert.equal(ctx.world.calls.length, 1, 'no restoration or grant inbox wake')
    // Only a real later host boundary can continue the original child with granted budget.
    assert.equal(await restored.waitForBudget(job.childSessionId), true)
    assert.equal(JSON.parse(restored.detail(job.ticketId)!.ticket.budget_json).quota.tokens, 6000)
    assert.equal(restored.detail(job.ticketId)!.attempts.length, 1)
  } finally {
    ctx.close()
  }
})

test('turn abort cleans the gate listener without approving budget, and claimed notice completion closes admission barrier', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'abort boundary', budget: { maxTokens: 1000 } })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    const abort = new AbortController()
    const wait = ctx.work.waitForBudget(job.childSessionId, abort.signal)
    abort.abort()
    assert.equal(await wait, false)
    await ctx.work.admit('bot-a')
    const notice = ctx.work.detail(job.ticketId)!.notices[0]
    ctx.work.observeClaimed('bot-a', notice.native_message_id, 42)
    ctx.work.observeSession('bot-a', { type: 'turn/end', data: { turn: 42 } })
    assert.equal(ctx.work.detail(job.ticketId)!.notices[0].observe_status, 'completed')
    assert.equal(ctx.work.book.openNotice('bot-a'), false)
    ctx.work.observeSession(job.childSessionId, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    assert.equal(ctx.work.detail(job.ticketId)!.ticket.status, 'cancelled')
  } finally {
    ctx.close()
  }
})

test('a finishing in-flight batch counts toward active host ceilings before the boundary freezes time', async () => {
  const ctx = boot({ workerWallMs: 2000 })
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'slow tools finishing',
      budget: { maxTokens: 1000, wallMs: 1000 },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    ctx.clock.ms += 3000 // This is in-flight tool time, not suspended-boundary waiting.
    const abort = new AbortController()
    const wait = ctx.work.waitForBudget(job.childSessionId, abort.signal)
    const grant = await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10000, wallMs: 10000 })
    assert.equal(grant.waitingBudget, true)
    assert.equal(grant.activeElapsedMs, 3000)
    assert.equal(grant.hostWallHeadroomMs, 0)
    assert.equal(grant.budgetReason, 'host-ceiling')
    abort.abort()
    assert.equal(await wait, false)
  } finally {
    ctx.close()
  }
})

test('waiting retains its worker slot but never gates the main bot; explicit cancellation promotes queued independent work', async () => {
  const ctx = boot({ perBot: 1, global: 1 })
  try {
    const first = await ctx.work.dispatch('bot-a', { briefing: 'paused worker', budget: { maxTokens: 1000 } })
    ctx.work.observeSession(first.childSessionId, ctx.world.seeUser(first.childSessionId, first.nativeMessageId, 1))
    ctx.work.observeSession(first.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(first.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    const second = await ctx.work.dispatch('bot-a', { briefing: 'independent queued task' })
    assert.equal(second.queued, true)
    assert.equal(await ctx.work.waitForBudget('bot-a'), true)
    await ctx.work.tick()
    assert.equal(ctx.world.calls.length, 1)
    await ctx.work.cancelTicket('bot-a', { ticketId: first.ticketId })
    await ctx.work.promoteQueued()
    assert.equal(ctx.world.calls.length, 2)
    assert.equal(ctx.work.detail(first.ticketId)!.attempts.length, 1)
  } finally {
    ctx.close()
  }
})

test('concurrent urgent admission is single-flight; an already sufficient grant suppresses an obsolete extension notice', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'urgent once', budget: { maxTokens: 1000 } })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    const before = ctx.world.pushes.length
    await Promise.all([ctx.work.admit('bot-a'), ctx.work.admit('bot-a'), ctx.work.admit('bot-a')])
    assert.equal(ctx.world.pushes.length - before, 1)
    assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1)
    await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 1000 })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 11,
      data: { usage: { totalTokens: 600 } },
    })
    await ctx.work.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10000 })
    ctx.clock.ms += DEFAULT_WORK_BUDGET.starveMs + 1
    await ctx.work.admit('bot-a')
    assert.equal(ctx.work.detail(job.ticketId)!.notices.length, 1, 'closed request is not pushed after its grant')
  } finally {
    ctx.close()
  }
})

test('an explicit detached grant durably re-enters the same child and fences old aborted turn replay from the result', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', {
      briefing: 'resume after restart',
      budget: { maxTokens: 1000, wallMs: 120000 },
    })
    ctx.world.claim(job.childSessionId)
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    ctx.work.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 1, 'aborted'))
    const restored = createWorkRuntime(ctx.store, ctx.engine, {
      resumePaused: true,
      now: () => new Date(ctx.clock.ms),
      schedule: () => () => {},
      push: (sessionId, messageId, text) => ctx.world.push(sessionId, messageId, text),
      snapshot: sessionId => ctx.world.snapshot(sessionId),
      pendingIds: sessionId => ctx.world.pendingIds(sessionId),
    })
    const before = restored.detail(job.ticketId)!
    const grant = await restored.grant('bot-a', { ticketId: job.ticketId, maxTokens: 10000 })
    assert.equal(grant.continuation, 'same-session-new-turn')
    const resumed = ctx.world.claim(job.childSessionId)!
    assert.notEqual(resumed.messageId, job.nativeMessageId)
    restored.observeClaimed(job.childSessionId, resumed.messageId, 2)
    restored.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, resumed.messageId, 2))
    restored.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 2 } })
    assert.equal(await restored.waitForBudget(job.childSessionId), true)
    await restored.report(job.childSessionId, { kind: 'result', text: 'continued original work' })
    await restored.tick()
    assert.equal(
      restored.detail(job.ticketId)!.ticket.status,
      'started',
      'old aborted turn/end must not finalize the new generation',
    )
    restored.observeSession(job.childSessionId, ctx.world.endTurn(job.childSessionId, 2, 'completed'))
    const final = restored.detail(job.ticketId)!
    assert.equal(final.ticket.status, 'ready')
    assert.equal(final.ticket.active_attempt_id, before.ticket.active_attempt_id)
    assert.equal(final.attempts[0].fencing_token, before.attempts[0].fencing_token)
    assert.equal(final.ticket.briefing_revision, before.ticket.briefing_revision + 1)
    assert.equal(ctx.world.calls.length, 1)
    assert.equal(JSON.parse(final.ticket.budget_json).quota.tokens, 1500)
  } finally {
    ctx.close()
  }
})

test('an explicit retry is a new fenced attempt and does not inherit the cancelled attempt quota', async () => {
  const ctx = boot()
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'manual retry', budget: { maxTokens: 1000 } })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 1500 } },
    })
    await ctx.work.cancelTicket('bot-a', { ticketId: job.ticketId })
    const retried = await ctx.work.retry('bot-a', { ticketId: job.ticketId })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, retried.nativeMessageId, 2))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 2 } })
    assert.equal(await ctx.work.waitForBudget(job.childSessionId), true)
    const detail = ctx.work.detail(job.ticketId)!
    assert.equal(detail.attempts.length, 2)
    assert.equal(JSON.parse(detail.ticket.budget_json).quota.tokens, 0)
    assert.equal(JSON.parse(detail.ticket.budget_json).quota.waiting, false)
  } finally {
    ctx.close()
  }
})

test('legacy open-extension metadata still schedules the granted wall boundary, not the host ceiling', async () => {
  const ctx = boot({ workerWallMs: 10000 })
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'legacy boundary', budget: { wallMs: 1000 } })
    const budget = JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json)
    budget.extension = 'open'
    ctx.store.db
      .prepare('UPDATE work_tickets SET budget_json = ? WHERE id = ?')
      .run(JSON.stringify(budget), job.ticketId)
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    assert.equal(ctx.scheduled()!.ms, 1000)
    ctx.clock.ms += 1000
    ctx.scheduled()!.fn()
    const blocked = ctx.work.waitForBudget(job.childSessionId)
    assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota.waiting, true)
    await ctx.work.cancelTicket('bot-a', { ticketId: job.ticketId })
    assert.equal(await blocked, false)
  } finally {
    ctx.close()
  }
})

test('a persisted sufficient grant retains durable expiry protection until actual loop admission', async () => {
  const ctx = boot()
  const abort = new AbortController()
  try {
    const job = await ctx.work.dispatch('bot-a', { briefing: 'grant crash boundary', budget: { maxTokens: 5000 } })
    ctx.work.observeSession(job.childSessionId, ctx.world.seeUser(job.childSessionId, job.nativeMessageId, 1))
    ctx.work.observeSession(job.childSessionId, { type: 'turn/start', data: { turn: 1 } })
    ctx.work.observeSession(job.childSessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { usage: { totalTokens: 6000 } },
    })
    const oldBoundary = ctx.work.waitForBudget(job.childSessionId, abort.signal)
    const book = createTicketBook(ctx.store.db, ctx.store.root, () => new Date(ctx.clock.ms))
    const granted = await ctx.store.write('work', () =>
      book.extendBudget(
        job.ticketId,
        { maxTokens: 10000 },
        {
          maxTokens: DEFAULT_WORK_BUDGET.workerMaxTokens,
          wallMs: DEFAULT_WORK_BUDGET.workerWallMs,
        },
      ),
    )
    assert.equal(granted.error, undefined)
    assert.equal(JSON.parse(ctx.work.detail(job.ticketId)!.ticket.budget_json).quota.waiting, true)
    // Simulate losing the resident callback immediately after the grant commit.
    abort.abort()
    assert.equal(await oldBoundary, false)
    const restored = createWorkRuntime(ctx.store, ctx.engine, {
      now: () => new Date(ctx.clock.ms),
      schedule: () => () => {},
    })
    ctx.clock.ms += 10000000
    await restored.tick()
    assert.equal(restored.detail(job.ticketId)!.ticket.status, 'started')
    assert.equal(ctx.world.calls.length, 1)
    assert.equal(await restored.waitForBudget(job.childSessionId), true)
    const quota = JSON.parse(restored.detail(job.ticketId)!.ticket.budget_json).quota
    assert.equal(quota.waiting, false)
    assert.equal(quota.tokens, 6000)
  } finally {
    abort.abort()
    ctx.close()
  }
})
