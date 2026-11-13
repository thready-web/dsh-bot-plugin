import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  abortedQuestion,
  callIdOf,
  createQuestionAnswerer,
  officialAnswerFrom,
  sessionIdOf,
  type OfficialAnswer,
  type OfficialQuestionItem,
  type OfficialQuestionRequest,
} from '../src/questions.ts'

const questions: OfficialQuestionItem[] = [
  {
    id: 'confirm_delete',
    header: 'Confirm',
    question: 'Delete the two directories?',
    options: [
      { label: 'Delete them now (Recommended)', description: 'Removes both directories.' },
      { label: 'Cancel, do not delete' },
    ],
  },
]

/** Minimal host mock of official UserQuestionService.ask() waterfall dispatch. */
class OfficialAskHost {
  listeners: Array<
    (request: OfficialQuestionRequest, next: () => Promise<OfficialAnswer>) => Promise<OfficialAnswer> | OfficialAnswer
  > = []

  on(
    _event: string,
    listener: (
      request: OfficialQuestionRequest,
      next: () => Promise<OfficialAnswer>,
    ) => Promise<OfficialAnswer> | OfficialAnswer,
    options?: boolean | { prepend?: boolean },
  ) {
    const prepend = options === true || (typeof options === 'object' && options.prepend === true)
    if (prepend) this.listeners.unshift(listener)
    else this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(entry => entry !== listener)
    }
  }

  waterfall(...args: unknown[]) {
    const request = (typeof args[0] === 'string' ? args[1] : args[2]) as OfficialQuestionRequest
    const fallback = (typeof args[0] === 'string' ? args[2] : args[3]) as () => Promise<OfficialAnswer>
    const chain = [...this.listeners]
    const run = (index: number): Promise<OfficialAnswer> => {
      const listener = chain[index]
      if (!listener) return fallback()
      return Promise.resolve(listener(request, () => run(index + 1)))
    }
    return run(0)
  }
}

function officialAsk(ctx: OfficialAskHost, request: OfficialQuestionRequest): Promise<OfficialAnswer> {
  if (request.signal?.aborted) return Promise.reject(abortedQuestion())
  if (request.questions.length === 0) {
    const error = new Error('ask_user_question requires at least one question')
    ;(error as Error & { code: string }).code = 'EMPTY_QUESTIONS'
    return Promise.reject(error)
  }
  const noAnswerer = () => {
    const error = new Error('no user-questions answerer accepted the request')
    ;(error as Error & { code: string }).code = 'NO_PROVIDER'
    return Promise.reject(error)
  }
  const agent = request.agent
  return agent === undefined
    ? ctx.waterfall('user-questions/request', request, noAnswerer)
    : ctx.waterfall({ agent }, 'user-questions/request', { ...request, agent }, noAnswerer)
}

test('officialAnswerFrom preserves exact ids and option labels and rejects invented values', () => {
  const built = officialAnswerFrom(questions, [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }])
  assert.equal(built.ok, true)
  if (built.ok) {
    assert.deepEqual(built.answer, { answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }] })
  }
  const secret = officialAnswerFrom(
    [{ id: 'token', question: 'Which key?', options: [{ label: 'sk-live-1234567890' }] }],
    [{ id: 'token', selected: ['sk-live-1234567890'] }],
  )
  assert.equal(secret.ok, true)
  if (secret.ok) assert.equal(secret.answer.answers[0]?.selected[0], 'sk-live-1234567890')
  const wrong = officialAnswerFrom(questions, [{ id: 'confirm_delete', selected: ['invented-yes'] }])
  assert.equal(wrong.ok, false)
  const missing = officialAnswerFrom(questions, [])
  assert.equal(missing.ok, false)
})

test('an already-aborted official request rejects instead of hanging', async () => {
  const answerer = createQuestionAnswerer()
  const signal = AbortSignal.abort(abortedQuestion())
  const request: OfficialQuestionRequest = { questions, agent: { id: 'sess-bot' }, signal }
  const started = Date.now()
  await assert.rejects(
    () => answerer.handle(request, () => Promise.reject(new Error('next should not run'))),
    error => {
      assert.equal((error as { code?: string }).code, 'ASK_ABORTED')
      return true
    },
  )
  assert.ok(Date.now() - started < 1000)
  assert.equal(answerer.pendingCount(), 0)
})

test('the prepended answerer returns the official open-request payload and blocks a later typpert-like listener', async () => {
  const ctx = new OfficialAskHost()
  const answerer = createQuestionAnswerer()
  const typpert: string[] = []
  ctx.on('user-questions/request', (_request, next) => {
    typpert.push('later')
    return next()
  })
  const stop = answerer.listen(ctx)
  const agent = { id: 'sess-bot' }
  const asked = officialAsk(ctx, { questions, agent, wait: { callId: 'call_timed' } })
  assert.equal(callIdOf({ questions, wait: { callId: 'call_timed' } }), 'call_timed')
  const result = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_timed',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.path, 'open')
  assert.deepEqual(await asked, { answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }] })
  assert.deepEqual(typpert, [])
  const again = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_timed',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'NOT_FOUND')
  stop()
})

test('legacy requests without wait.callId still submit and cannot be answered across sessions', async () => {
  const ctx = new OfficialAskHost()
  const answerer = createQuestionAnswerer()
  answerer.listen(ctx)
  const asked = officialAsk(ctx, { questions, agent: { id: 'sess-bot' } })
  const cross = answerer.submit({
    sessionId: 'other-session',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(cross.ok, false)
  assert.equal(cross.code, 'NOT_FOUND')
  assert.equal(answerer.pendingCount(), 1)
  const result = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_10fxzqal',
    answers: [{ id: 'confirm_delete', selected: ['Delete them now (Recommended)'] }],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(await asked, {
    answers: [{ id: 'confirm_delete', selected: ['Delete them now (Recommended)'] }],
  })
})

test('multi-select, custom, and skip payloads stay official', async () => {
  const ctx = new OfficialAskHost()
  const answerer = createQuestionAnswerer()
  answerer.listen(ctx)
  const batch: OfficialQuestionItem[] = [
    {
      id: 'keep',
      question: 'Which files?',
      multiSelect: true,
      options: [{ label: 'alpha' }, { label: 'beta' }],
    },
    { id: 'note', question: 'Any other note?' },
    {
      id: 'skip_me',
      question: 'Optional extra?',
      options: [{ label: 'Yes' }],
    },
  ]
  const asked = officialAsk(ctx, { questions: batch, agent: { id: 'sess-bot' } })
  const customOnly = officialAnswerFrom(batch, [
    { id: 'keep', selected: ['alpha', 'beta'], custom: 'also gamma' },
    { id: 'note', selected: [], custom: 'leave the rest' },
    { id: 'skip_me', selected: [] },
  ])
  assert.equal(customOnly.ok, true)
  const result = answerer.submit({
    sessionId: 'sess-bot',
    answers: customOnly.ok ? customOnly.answer.answers : [],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(await asked, {
    answers: [
      { id: 'keep', selected: ['alpha', 'beta'], custom: 'also gamma' },
      { id: 'note', selected: [], custom: 'leave the rest' },
      { id: 'skip_me', selected: [] },
    ],
  })
})

test('continued questions use userQuestions.answer and never resolve an open request', () => {
  const answerer = createQuestionAnswerer()
  const answered: unknown[] = []
  const ctx = {
    on() {
      return () => {}
    },
    agents: {
      get(id: string) {
        return id === 'sess-bot' ? { id: 'sess-bot' } : undefined
      },
    },
    userQuestions: {
      answer(agent: { id: string }, callId: string, answer: OfficialAnswer) {
        const accepted = callId === 'call_continued'
        if (accepted) answered.push({ sessionId: sessionIdOf(agent), callId, answer })
        return accepted
      },
    },
  }
  answerer.listen(ctx)
  const missing = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_missing',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
  const result = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_continued',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.path, 'continued')
  assert.deepEqual(answered, [
    {
      sessionId: 'sess-bot',
      callId: 'call_continued',
      answer: { answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }] },
    },
  ])
})

test('duplicate open submissions fail after the first official answer', async () => {
  const ctx = new OfficialAskHost()
  const answerer = createQuestionAnswerer()
  answerer.listen(ctx)
  const asked = officialAsk(ctx, { questions, agent: { id: 'sess-bot' } })
  const first = answerer.submit({
    sessionId: 'sess-bot',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  const second = answerer.submit({
    sessionId: 'sess-bot',
    answers: [{ id: 'confirm_delete', selected: ['Delete them now (Recommended)'] }],
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.deepEqual(await asked, { answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }] })
})

test('requesting changes rejects an open plan-review wait as ASK_CANCELLED', async () => {
  const ctx = new OfficialAskHost()
  const answerer = createQuestionAnswerer()
  answerer.listen(ctx)
  const asked = officialAsk(ctx, {
    questions: [
      {
        id: 'review',
        question: 'Approve this plan?',
        detail: '# Plan\nDo the work.',
        intent: { kind: 'plan-review', approve: 'Approve' },
        options: [{ label: 'Approve' }, { label: 'Request changes' }],
      },
    ],
    agent: { id: 'sess-bot' },
  })
  const result = answerer.cancel({ sessionId: 'sess-bot' })
  assert.equal(result.ok, true)
  assert.equal(result.path, 'cancelled')
  await assert.rejects(asked, error => {
    assert.equal((error as { code?: string }).code, 'ASK_CANCELLED')
    return true
  })
})

test('a timed question can take more time, time out, then accept a continued answer', async () => {
  const ctx = new OfficialAskHost()
  const answered: unknown[] = []
  const answerer = createQuestionAnswerer()
  answerer.listen({
    on: ctx.on.bind(ctx),
    agents: { get: (id: string) => (id === 'sess-bot' ? { id: 'sess-bot' } : undefined) },
    userQuestions: {
      answer(_agent: unknown, callId: string, answer: OfficialAnswer) {
        answered.push({ callId, answer })
        return callId === 'call_timed'
      },
    },
  })
  const asked = officialAsk(ctx, {
    questions,
    agent: { id: 'sess-bot' },
    wait: { callId: 'call_timed', timed: true },
  })
  const held = answerer.takeTime({ sessionId: 'sess-bot', callId: 'call_timed' })
  assert.equal(held.ok, true)
  assert.equal(answerer.snapshot('sess-bot')[0]?.waitState, 'waiting')
  const timed = answerer.timeout({ sessionId: 'sess-bot', callId: 'call_timed' })
  assert.equal(timed.ok, true)
  await assert.rejects(asked, error => {
    assert.equal((error as { code?: string }).code, 'ASK_TIMED_OUT')
    return true
  })
  const late = answerer.submit({
    sessionId: 'sess-bot',
    callId: 'call_timed',
    answers: [{ id: 'confirm_delete', selected: ['Cancel, do not delete'] }],
  })
  assert.equal(late.ok, true)
  assert.equal(late.path, 'continued')
  assert.equal((answered[0] as { callId: string }).callId, 'call_timed')
})
