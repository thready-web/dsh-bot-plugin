import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { ToolSegment } from './types.ts'
import { isUserQuestionTool, optionPresentation, userQuestionView } from './user-question.ts'

const questions = [
  {
    id: 'confirm_delete',
    header: '确认删除',
    question: '确认删除 coffee-landing 和 tea-landing 这两个目录吗？大约 365MB，而且不是 git 仓库。',
    options: [
      { label: '直接彻底删除（推荐）', description: '立即删除这两个目录' },
      { label: '先打个压缩包备份再删' },
      { label: '先移到回收目录再删' },
      { label: '取消，先别删' },
    ],
  },
]

const tool = (values: Partial<ToolSegment> = {}): ToolSegment => ({
  kind: 'tool',
  id: 'tool:call_10fxzqal',
  callId: 'call_10fxzqal',
  name: 'ask_user_question',
  args: JSON.stringify({ questions }),
  result: '',
  running: true,
  error: false,
  status: 'waiting',
  seq: 1,
  turn: 3,
  ...values,
})

test('isUserQuestionTool accepts official and hyphenated names', () => {
  assert.equal(isUserQuestionTool('ask_user_question'), true)
  assert.equal(isUserQuestionTool('ask-user-question'), true)
  assert.equal(isUserQuestionTool('bash'), false)
})

test('userQuestionView reads header, question, options and multi_select from tool arguments', () => {
  const view = userQuestionView(
    tool({
      args: JSON.stringify({
        questions: [{ ...questions[0], multi_select: true }],
      }),
    }),
  )
  assert.ok(view)
  assert.equal(view.state, 'open')
  assert.equal(view.title, '确认删除')
  assert.equal(view.questions[0]?.question, questions[0]?.question)
  assert.equal(view.questions[0]?.multiSelect, true)
  assert.deepEqual(
    view.questions[0]?.options.map(option => option.label),
    questions[0]?.options.map(option => option.label),
  )
  assert.equal(view.questions[0]?.options[0]?.description, '立即删除这两个目录')
})

test('userQuestionView marks an official abort as aborted even when userQuestions is empty', () => {
  const view = userQuestionView(
    tool({
      running: false,
      resultReceived: true,
      error: true,
      errorCode: 'ASK_ABORTED',
      status: 'cancelled',
      result: 'Error: ask_user_question was aborted before the user answered',
    }),
  )
  assert.equal(view?.state, 'aborted')
  assert.equal(view?.questions[0]?.skipped, false)
  assert.equal(view?.title, '确认删除')
})

test('userQuestionView records selected answers and skipped questions', () => {
  const answered = userQuestionView(
    tool({
      running: false,
      resultReceived: true,
      status: 'succeeded',
      result: JSON.stringify({
        answers: [{ id: 'confirm_delete', selected: ['取消，先别删'] }],
      }),
    }),
  )
  assert.equal(answered?.state, 'answered')
  assert.deepEqual(answered?.questions[0]?.selected, ['取消，先别删'])
  assert.equal(answered?.questions[0]?.skipped, false)

  const skipped = userQuestionView(
    tool({
      running: false,
      resultReceived: true,
      status: 'succeeded',
      result: JSON.stringify({
        answers: [{ id: 'confirm_delete', selected: [] }],
      }),
    }),
  )
  assert.equal(skipped?.questions[0]?.skipped, true)
  assert.equal(skipped?.state, 'answered')
})

test('userQuestionView returns null for other tools and keeps an incomplete stream as a named card', () => {
  assert.equal(userQuestionView(tool({ name: 'bash', args: '{"command":"ls"}' })), null)
  const streaming = userQuestionView(tool({ args: '{"questions":[{"id":"q1","ques' }))
  assert.equal(streaming?.state, 'open')
  assert.equal(streaming?.title, 'ask_user_question')
  assert.equal(streaming?.questions.length, 0)
})

test('userQuestionView keeps official option labels and ids unredacted for submission', () => {
  const view = userQuestionView(
    tool({
      args: JSON.stringify({
        questions: [
          {
            id: 'api_key',
            question: 'Which credential should we use?',
            options: [{ label: 'sk-live-1234567890abcdef', description: 'token=secret' }],
          },
        ],
      }),
      result: JSON.stringify({
        answers: [{ id: 'api_key', selected: ['sk-live-1234567890abcdef'] }],
      }),
      running: false,
      resultReceived: true,
      status: 'succeeded',
    }),
  )
  assert.equal(view?.questions[0]?.id, 'api_key')
  assert.equal(view?.questions[0]?.options[0]?.label, 'sk-live-1234567890abcdef')
  assert.deepEqual(view?.questions[0]?.selected, ['sk-live-1234567890abcdef'])
})

test('userQuestionView keeps a timed pending result answerable instead of settled', () => {
  const view = userQuestionView(
    tool({
      running: false,
      resultReceived: true,
      status: 'succeeded',
      args: JSON.stringify({ questions, timeout: 120 }),
      result: JSON.stringify({ pending: true, callId: 'call_10fxzqal' }),
    }),
  )
  assert.equal(view?.state, 'continued')
  assert.equal(view?.wait, 'continued')
  assert.equal(view?.timeoutMs, 120000)
})

test('userQuestionView narrows plan-review and approval intents', () => {
  const plan = userQuestionView(
    tool({
      args: JSON.stringify({
        questions: [
          {
            id: 'review',
            question: 'Approve the plan?',
            detail: '# Ship it',
            intent: { kind: 'plan-review', approve: 'Approve' },
            options: [{ label: 'Approve' }, { label: 'Request changes' }],
          },
        ],
      }),
    }),
  )
  assert.equal(plan?.presentation, 'plan-review')
  const approval = userQuestionView(
    tool({
      args: JSON.stringify({
        questions: [
          {
            id: 'app',
            question: 'Allow Notes?',
            intent: {
              kind: 'approval',
              approve: 'Allow',
              reject: 'Reject',
              always: 'Always allow',
              subject: { name: 'Notes' },
            },
            options: [{ label: 'Allow' }, { label: 'Reject' }, { label: 'Always allow' }],
          },
        ],
      }),
    }),
  )
  assert.equal(approval?.presentation, 'approval')
})

test('optionPresentation extracts a recommended badge without changing the official label', () => {
  const presented = optionPresentation('Delete them now (Recommended)')
  assert.equal(presented.label, 'Delete them now (Recommended)')
  assert.equal(presented.displayLabel, 'Delete them now')
  assert.equal(presented.recommended, true)
  const chinese = optionPresentation('直接彻底删除（推荐）')
  assert.equal(chinese.recommended, true)
  assert.equal(chinese.displayLabel, '直接彻底删除')
})
