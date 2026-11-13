import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botSignal,
  budgetRefusalText,
  bookkeepingOnly,
  chatStatus,
  composerLocked,
  cardsToShow,
  dispatchTicketId,
  isBudgetRefusal,
  isTicketNotice,
  parseBriefing,
  isWorkerSession,
  questionView,
  readLiveBoard,
  readLiveCards,
  readLiveSignals,
  readTicket,
  workPlaceholder,
  workPreview,
  type WorkTicket,
} from './work.ts'

const ticket = (patch: Partial<WorkTicket>): WorkTicket => ({
  id: 't1',
  status: 'started',
  revision: 1,
  summary: "last week's meeting notes",
  childSessionId: 'worker-t1',
  startedAt: '2026-11-09T06:00:00.000Z',
  events: [],
  ...patch,
})

test('ticket notices are not user speech', () => {
  assert.equal(isTicketNotice('[foundations:ticket]\nenqueued'), true)
  assert.equal(isTicketNotice('tidy the notes'), false)
})

test('a briefing envelope separates the task from the protocol lines', () => {
  const briefing = parseBriefing(`[foundations:briefing]
briefing_revision: 1
budget_wall_ms: 600000
There is no step cap.
material_sha256: e66ceed1bf9a9aab
When no separate read-only material is attached, the material hash equals the task-text hash.
---
Task: move the coffee project
State: the root already has files`)
  assert.equal(briefing?.revision, 1)
  assert.equal(briefing?.wallMs, 600000)
  assert.equal(briefing?.maxTokens, null)
  assert.equal(briefing?.cancel, false)
  assert.equal(briefing?.body, 'Task: move the coffee project\nState: the root already has files')
  assert.equal(
    briefing?.notes.some(note => note.startsWith('There is no step cap')),
    true,
  )
  assert.equal(parseBriefing('tidy the notes'), null)
  const cancel = parseBriefing(`[foundations:briefing]
briefing_revision: 2
This is a cancellation note. Stop new outward actions. Do not treat the result as publishable.
---
Stop editing the page`)
  assert.equal(cancel?.cancel, true)
  assert.equal(cancel?.body, 'Stop editing the page')
})

test('a worker session is recognized by its id and is not a normal chat', () => {
  assert.equal(isWorkerSession('worker-36ab96a2-0173-47bb-8840-4b35e068023c'), true)
  assert.equal(isWorkerSession('session-36ab96a2-0173-47bb-8840-4b35e068023c'), false)
  assert.equal(isWorkerSession('worker-'), false)
})

test('a ticket detail keeps the question text and the start time', () => {
  const read = readTicket(
    {
      ok: true,
      ticket: {
        id: 't1',
        status: 'needs_user',
        briefing_revision: 1,
        active_attempt_id: 'a1',
        child_session_id: 'worker-t1',
      },
      attempts: [{ id: 'a1', started_at: '2026-11-09T06:00:00.000Z' }],
      events: [
        {
          event_id: 'e1',
          kind: 'question',
          apply_status: 'applied',
          briefing_revision: 1,
          text: 'by topic or by time?',
        },
      ],
    },
    'tidy the notes',
  )
  assert.ok(read)
  assert.equal(read.summary, 'tidy the notes')
  assert.equal(read.startedAt, '2026-11-09T06:00:00.000Z')
  assert.equal(read.childSessionId, 'worker-t1')
  assert.equal(questionView(read)?.text, 'by topic or by time?')
  assert.equal(questionView(read)?.stale, false)
})

test('after a reply the old question is stale and the ticket is queued again', () => {
  const next = ticket({
    status: 'enqueued',
    revision: 2,
    events: [{ eventId: 'e1', kind: 'question', applyStatus: 'stale', revision: 1, text: 'by topic or by time?' }],
  })
  const view = questionView(next)
  assert.equal(view?.stale, true)
  assert.equal(workPreview([next]), 'Enqueued')
  assert.equal(workPlaceholder([next]), null)
})

test('a ready ticket waits for the assistant reply instead of carrying the result body', () => {
  const ready = ticket({
    status: 'ready',
    events: [{ eventId: 'e1', kind: 'result', applyStatus: 'applied', revision: 1, text: 'split into three topics' }],
  })
  assert.equal(workPreview([ready]), '')
  assert.equal(
    workPlaceholder([ready]),
    'Send a message. The result becomes delivered only after the assistant writes it into the chat.',
  )
  assert.equal(botSignal([ready]), null)
  assert.equal(botSignal([{ status: 'started' }]), 'run')
  assert.equal(botSignal([{ status: 'enqueued' }, { status: 'needs_user' }]), 'wait')
  assert.equal(botSignal([{ status: 'needs_user' }], true), 'run')
  const delivered = ticket({ id: 't2', status: 'delivered' })
  assert.deepEqual(
    cardsToShow([ready, delivered]).map(item => item.status),
    ['ready', 'delivered'],
  )
})

test('two running tickets share one preview, and a second dispatch can be refused', () => {
  const first = ticket({ id: 'a' })
  const second = ticket({ id: 'b', summary: 'check the list' })
  assert.equal(workPreview([first, second], Date.parse('2026-11-09T06:00:42.000Z')), 'Started · 2')
  assert.equal(workPlaceholder([first]), 'Background work has started. You can say something else.')
  const refused = {
    name: 'foundations_dispatch',
    result: JSON.stringify({
      ok: false,
      code: 'BUDGET',
      message: 'Unfinished tickets already hit the host concurrency limit, so no row was created.',
    }),
  }
  assert.equal(isBudgetRefusal(refused), true)
  assert.match(budgetRefusalText(refused.result), /concurrency limit/)
  assert.equal(
    dispatchTicketId({ name: 'foundations_dispatch', result: JSON.stringify({ ok: true, ticketId: 't1' }) }),
    't1',
  )
  assert.equal(dispatchTicketId(refused), null)
})

test('a background ticket leaves the composer free to send another instruction', () => {
  const started = ticket({})
  assert.equal(composerLocked(true, []), true)
  assert.equal(composerLocked(true, [started]), false)
  assert.equal(composerLocked(false, [started]), false)
  assert.equal(composerLocked(true, [ticket({ status: 'delivered' })]), true)
  assert.equal(composerLocked(true, [ticket({ status: 'needs_user' })]), false)
  assert.equal(composerLocked(true, [], true), false)
  assert.equal(chatStatus('Replying'), 'Replying')
  assert.equal(chatStatus('Thinking'), 'Thinking')
  assert.equal(chatStatus(''), 'Thinking')
  assert.equal(bookkeepingOnly([{ kind: 'think' }, { kind: 'tool', name: 'foundations_dispatch' }]), true)
  assert.equal(bookkeepingOnly([{ kind: 'tool', name: 'bash' }]), false)
})

test('a live snapshot becomes sidebar statuses and cards', () => {
  const signals = readLiveSignals({ signals: { 'bot-a': ['started', 1], 'bot-b': 'nope' } })
  assert.deepEqual(signals['bot-a'], ['started'])
  assert.deepEqual(signals['bot-b'], [])
  const cards = readLiveCards({
    cards: [
      {
        summary: 'sort the attachments',
        ticket: {
          id: 't1',
          status: 'started',
          briefing_revision: 2,
          child_session_id: 'worker-t1',
          active_attempt_id: 'a1',
        },
        attempts: [{ id: 'a1', started_at: '2026-11-09T06:00:00.000Z' }],
        events: [
          { event_id: 'e1', kind: 'progress', apply_status: 'applied', briefing_revision: 2, text: 'halfway there' },
        ],
      },
    ],
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.summary, 'sort the attachments')
  assert.equal(cards[0]?.revision, 2)
  assert.equal(cards[0]?.startedAt, '2026-11-09T06:00:00.000Z')
  assert.equal(cards[0]?.events[0]?.text, 'halfway there')
  const board = readLiveBoard({
    ok: true,
    work: {
      signals: { 'bot-a': ['ready'] },
      cards: {
        'bot-a': [
          {
            summary: 'sort the attachments',
            ticket: { id: 't1', status: 'ready', briefing_revision: 1, active_attempt_id: '' },
            attempts: [],
            events: [],
          },
        ],
      },
    },
  })
  assert.deepEqual(board?.signals['bot-a'], ['ready'])
  assert.equal(board?.cards['bot-a']?.[0]?.summary, 'sort the attachments')
})

test('a started preview counts from when the worker saw the task', () => {
  assert.equal(workPreview([ticket({})], Date.parse('2026-11-09T06:01:05.000Z')), 'Started · 1:05')
})

test('budget-wait cards are localized waiting signals, not running timers or completed tasks', () => {
  for (const metadata of [{ waiting_budget: true }, { budget_json: JSON.stringify({ quota: { waiting: true } }) }]) {
    const paused = readTicket({ ticket: { id: 'quota', status: 'started', ...metadata } })!
    assert.equal(paused.status, 'waiting_budget')
    assert.equal(botSignal([paused]), 'wait')
    assert.equal(workPreview([paused]), 'Waiting for budget')
    assert.match(workPlaceholder([paused])!, /paused.*budget/)
  }
  assert.equal(readTicket({ ticket: { id: 'done', status: 'failed', waiting_budget: true } })!.status, 'failed')
})
