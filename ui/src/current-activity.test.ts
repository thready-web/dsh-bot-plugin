import { strict as assert } from 'node:assert'
import test from 'node:test'
import { currentActivity } from './current-activity.ts'
import { translate } from './i18n/index.ts'
import { applyLogEvent } from './follow.ts'
import { emptyThread, type ToolSegment, type ThreadState } from './types.ts'
import { toolState } from './activity.ts'
import type { WorkTicket } from './work.ts'

const tool = (values: Partial<ToolSegment> = {}): ToolSegment => ({
  kind: 'tool',
  id: 'tool:a',
  callId: 'a',
  name: 'bash',
  args: '{"description":"Repair UI","command":"npm test"}',
  result: '',
  running: true,
  error: false,
  status: 'waiting',
  seq: 1,
  turn: 1,
  ...values,
})
const ticket = (id: string, status = 'started'): WorkTicket => ({
  id,
  status,
  revision: 1,
  summary: `Task ${id}`,
  childSessionId: `worker-${id}`,
  startedAt: null,
  events: [],
})

test('composer distinguishes proposed parameters, waiting calls and explicit running evidence', () => {
  const input = { segments: [tool({ status: 'preparing', args: '{"command":"npm' })], drafting: true, currentTurn: 1 }
  assert.equal(currentActivity(input)?.text, 'Preparing call: bash')
  assert.equal(currentActivity({ ...input, segments: [tool()] })?.text, 'Waiting for tool result: Repair UI')
  assert.equal(
    currentActivity({ ...input, segments: [tool({ status: 'running' })] })?.text,
    'Running (confirmed): Repair UI',
  )
  assert.equal(
    currentActivity({ ...input, segments: [tool({ args: '{"command":"npm test\\nnpm run build"}' })] })?.text,
    'Waiting for tool result: npm test npm run build',
  )
})

test('composer does not revive an old turn or turn model narration into an executed task', () => {
  assert.equal(currentActivity({ segments: [tool()], drafting: false }), null)
  assert.equal(
    currentActivity({ segments: [tool()], currentTurn: 2, drafting: true })?.text,
    'Waiting for model response',
  )
  assert.equal(
    currentActivity({
      segments: [{ kind: 'assistant', id: 't', text: 'I am running npm test', streaming: true, seq: 1, turn: 1 }],
      drafting: true,
      currentTurn: 1,
    })?.text,
    'Replying',
  )
  assert.equal(
    currentActivity({
      segments: [{ kind: 'think', id: 't', text: 'Plan', running: true, seq: 1 }],
      drafting: true,
      t: (key, vars) => translate('zh', key, vars),
    })?.text,
    '思考中',
  )
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown'] as const) {
    assert.equal(currentActivity({ segments: [tool({ status, running: false })], drafting: false }), null)
  }
})

test('composer deduplicates linked dispatch/tickets and accurately describes worker wait and review', () => {
  const dispatch = tool({
    name: 'foundations_dispatch',
    result: '{"ticketId":"one"}',
    status: 'succeeded',
    running: false,
  })
  const single = currentActivity({ segments: [dispatch], drafting: false, tickets: [ticket('one')] })
  assert.equal(single?.text, 'Waiting for Worker: Task one')
  const multi = currentActivity({ segments: [dispatch], drafting: false, tickets: [ticket('one'), ticket('two')] })
  assert.equal(multi?.text, '2 pending activities · Waiting for Worker: Task two')
  assert.ok(!multi?.text.includes('Running'))
  for (const [status, label] of [
    ['accepted', 'Waiting for Worker scheduling'],
    ['enqueued', 'Waiting for Worker scheduling'],
    ['needs_user', 'Waiting for you'],
    ['ready', 'Worker returned; awaiting review'],
  ]) {
    const summary = currentActivity({ segments: [dispatch], drafting: false, tickets: [ticket('one', status)] })
    assert.ok(summary)
    assert.ok(summary.text.startsWith(label!))
    assert.equal(summary.moving, ['accepted', 'enqueued'].includes(status!))
  }
  for (const status of ['delivered', 'failed', 'cancelled']) {
    assert.equal(currentActivity({ segments: [dispatch], drafting: false, tickets: [ticket('one', status)] }), null)
  }
})

test('background acknowledgements and disconnected states stay explicit last-known without shimmer', () => {
  assert.equal(currentActivity({ segments: [tool({ status: 'background', running: false })], drafting: false }), null)
  const background = currentActivity({
    segments: [tool({ status: 'background', running: false })],
    drafting: true,
    currentTurn: 1,
  })
  assert.equal(background?.text, 'Background job (last known): Repair UI')
  assert.equal(background?.moving, false)
  for (const connectionPhase of ['syncing', 'restoring', 'connecting', 'error', 'closed']) {
    const summary = currentActivity({ segments: [tool()], drafting: true, connectionPhase })
    assert.equal(summary?.moving, false)
    assert.ok(summary?.text.includes('last known'))
  }
})

test('composer masks command and worker secrets before display/title projection', () => {
  const summary = currentActivity({
    segments: [tool({ args: '{"command":"TOKEN=commandSecret npm test"}' })],
    drafting: true,
  })
  assert.ok(!summary?.text.includes('commandSecret') && summary?.text.includes('REDACTED'))
  const worker = currentActivity({
    segments: [],
    drafting: false,
    tickets: [{ ...ticket('one'), summary: 'Fix UI Authorization: Bearer workerSecret' }],
  })
  assert.ok(!worker?.text.includes('workerSecret') && worker?.text.includes('REDACTED'))
})

test('historical background jobs are not counted as pending after the turn has settled', () => {
  const jobs = [1, 2, 3].map(index =>
    tool({
      id: `tool:bg${index}`,
      callId: `bg${index}`,
      status: 'background',
      running: false,
      resultReceived: true,
      result: `started background job job-${index}`,
      turn: index,
    }),
  )
  const settled = currentActivity({
    segments: [...jobs, tool({ status: 'succeeded', running: false, resultReceived: true, turn: 3 })],
    drafting: false,
    currentTurn: 3,
    tickets: [ticket('dead', 'failed')],
  })
  assert.equal(settled, null, 'finished work and last-known jobs must not stay pending')
  const liveKnown = currentActivity({ segments: jobs, drafting: true, currentTurn: 3 })
  assert.equal(liveKnown?.text, 'Background job (last known): Repair UI')
  assert.equal(liveKnown?.moving, false)
  assert.ok(!liveKnown?.text.includes('pending'))
})

test('foreground completion, failed tickets, late results and replay clear pending counts', () => {
  const waiting = tool({ callId: 'fg', status: 'waiting', turn: 2 })
  const background = tool({
    callId: 'bg',
    status: 'background',
    running: false,
    resultReceived: true,
    result: 'started background job job-9',
    turn: 1,
  })
  assert.equal(
    currentActivity({ segments: [waiting], drafting: true, currentTurn: 2 })?.text,
    'Waiting for tool result: Repair UI',
  )
  assert.equal(
    currentActivity({
      segments: [waiting, background],
      drafting: true,
      currentTurn: 2,
    })?.text,
    'Waiting for tool result: Repair UI',
    'older last-known jobs must not inflate a live pending count',
  )
  const finished = tool({
    callId: 'fg',
    status: 'succeeded',
    running: false,
    resultReceived: true,
    result: 'ok',
    turn: 2,
  })
  assert.equal(
    currentActivity({
      segments: [finished, background],
      drafting: false,
      currentTurn: 2,
      tickets: [ticket('dead', 'failed')],
    }),
    null,
  )
  assert.equal(
    currentActivity({
      segments: [background],
      drafting: false,
      tickets: [ticket('one'), ticket('dead', 'failed')],
    })?.text,
    'Waiting for Worker: Task one',
  )
})

function call(state: ThreadState, seq: number, id: string, args: string) {
  return applyLogEvent(state, {
    type: 'tool/call',
    seq,
    data: { turn: 1, step: 1, callId: id, name: 'bash', arguments: args },
  })
}
function result(state: ThreadState, seq: number, id: string, text: string, isError = false) {
  return applyLogEvent(state, {
    type: 'tool/result',
    seq,
    data: { turn: 1, step: 1, message: { toolCallId: id, isError, content: text ? [{ type: 'text', text }] : [] } },
  })
}

test('late results and journal replay clear a pending composer line', () => {
  const args = '{"command":"printf ok","description":"Repair UI"}'
  let live = call(emptyThread(), 1, 'fg', args)
  assert.equal(
    currentActivity({ segments: live.segments, drafting: true, currentTurn: 1 })?.text,
    'Waiting for tool result: Repair UI',
  )
  live = result(live, 2, 'fg', 'ok')
  assert.equal(toolState(live.segments.find(item => item.kind === 'tool') as ToolSegment), 'succeeded')
  assert.equal(
    currentActivity({ segments: live.segments, drafting: true, currentTurn: 1 })?.text,
    'Waiting for model response',
  )
  live = applyLogEvent(live, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(currentActivity({ segments: live.segments, drafting: false, currentTurn: 1 }), null)

  const events = [
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'bg', name: 'bash', arguments: args } },
    {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: 'bg', content: [{ type: 'text', text: 'started background job job-1' }] },
      },
    },
    {
      type: 'tool/result',
      seq: 5,
      data: {
        turn: 1,
        step: 1,
        message: {
          toolCallId: 'bg',
          content: [{ type: 'text', text: 'started background job job-1\njob-ok\n[exit code: 0]' }],
        },
      },
    },
  ]
  let incremental = emptyThread()
  incremental = applyLogEvent(incremental, events[0]!)
  incremental = applyLogEvent(incremental, events[1]!)
  assert.equal(toolState(incremental.segments.find(item => item.kind === 'tool') as ToolSegment), 'background')
  assert.equal(
    currentActivity({ segments: incremental.segments, drafting: true, currentTurn: 1 })?.text,
    'Background job (last known): Repair UI',
  )
  incremental = applyLogEvent(incremental, events[2]!)
  assert.equal(toolState(incremental.segments.find(item => item.kind === 'tool') as ToolSegment), 'succeeded')
  assert.equal(currentActivity({ segments: incremental.segments, drafting: false, currentTurn: 1 }), null)
  let replay = emptyThread()
  for (const event of events) replay = applyLogEvent(replay, event)
  assert.equal(toolState(replay.segments.find(item => item.kind === 'tool') as ToolSegment), 'succeeded')
  assert.equal(currentActivity({ segments: replay.segments, drafting: false, currentTurn: 1 }), null)
})

test('composer uses a waiting-for-answer label for an open ask_user_question', () => {
  const question = tool({
    name: 'ask_user_question',
    args: JSON.stringify({
      questions: [
        {
          id: 'confirm_delete',
          header: '确认删除',
          question: '确认删除这两个目录吗？',
          options: [{ label: '取消，先别删' }],
        },
      ],
    }),
  })
  assert.equal(
    currentActivity({ segments: [question], drafting: true, currentTurn: 1 })?.text,
    'Waiting for your answer',
  )
  assert.equal(
    currentActivity({
      segments: [question],
      drafting: true,
      currentTurn: 1,
      t: (key, vars) => translate('zh', key, vars),
    })?.text,
    '等待你的回答',
  )
  assert.equal(
    currentActivity({
      segments: [question, tool({ id: 'tool:b', callId: 'b', status: 'waiting' })],
      drafting: true,
      currentTurn: 1,
    })?.text.includes('Waiting for your answer'),
    true,
  )
})
