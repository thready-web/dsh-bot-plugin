import { strict as assert } from 'node:assert'
import test from 'node:test'
import { argsOf, redactText, safeArgs, resultStatus, toolPresentation, toolState } from './activity.ts'
import { applyLogEvent, applyEphemeralFrame } from './follow.ts'
import { emptyThread, type ToolSegment, type ThreadState } from './types.ts'
import type { WorkTicket } from './work.ts'

const tool = (values: Partial<ToolSegment> = {}): ToolSegment => ({
  kind: 'tool',
  id: 'tool:c1',
  callId: 'c1',
  name: 'bash',
  args: '{}',
  result: '',
  running: true,
  error: false,
  seq: 1,
  turn: 1,
  step: 1,
  ...values,
})
const tools = (state: ThreadState) => state.segments.filter((s): s is ToolSegment => s.kind === 'tool')
function call(
  state: ThreadState,
  seq = 2,
  id = 'c1',
  name = 'bash',
  args = '{"command":"printf ok","description":"Print","workdir":"/tmp"}',
) {
  return applyLogEvent(state, {
    type: 'tool/call',
    seq,
    time: seq * 1000,
    data: { turn: 1, step: 1, callId: id, name, arguments: args },
  })
}
function result(state: ThreadState, text = '', seq = 3, id = 'c1', isError = false, code?: string) {
  return applyLogEvent(state, {
    type: 'tool/result',
    seq,
    time: seq * 1000,
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: id, isError, content: text ? [{ type: 'text', text }] : [] },
      ...(code ? { error: { code, name: 'Error' } } : {}),
    },
  })
}
const start = (state: ThreadState, revision = 1) =>
  applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'a', revision, startedAfterSeq: 0, turn: 1, step: 1 },
  })
const chunk = (state: ThreadState, revision = 2, index = 0) =>
  applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'a',
      revision,
      index,
      time: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{"command":"printf ok"}' },
    },
  })

test('stream arguments → durable call → empty result is one settled call, never proof of running', () => {
  let state = chunk(start(emptyThread()))
  assert.equal(tools(state).length, 1)
  assert.equal(toolState(tools(state)[0]!), 'preparing')
  state = call(state)
  assert.equal(toolState(tools(state)[0]!), 'waiting')
  state = result(state)
  assert.equal(tools(state).length, 1)
  assert.equal(tools(state)[0]!.resultReceived, true)
  assert.equal(tools(state)[0]!.running, false)
  assert.equal(toolState(tools(state)[0]!), 'succeeded')
  assert.equal(tools(state)[0]!.requestedAt, 2000)
  assert.equal(tools(state)[0]!.settledAt, 3000)
})

test('result-first, repeated call/result, old result and assistant commit do not reopen or duplicate', () => {
  let state = result(emptyThread(), '', 5)
  state = call(state)
  state = result(state, '[exit code: 9]', 4, 'c1', true)
  state = call(state)
  state = applyLogEvent(state, {
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } },
  })
  assert.equal(tools(state).length, 1)
  assert.equal(tools(state)[0]!.resultSeq, 5)
  assert.equal(
    toolPresentation(tools(state)[0]!).command,
    'printf ok',
    'old assistant proposal cannot overwrite durable call args',
  )
  assert.equal(toolState(tools(state)[0]!), 'succeeded')
  assert.equal(tools(state)[0]!.running, false)
})

test('tool error, cancellation and restart unknown are distinct from success', () => {
  assert.equal(toolState(tools(result(call(emptyThread()), 'denied', 3, 'c1', true))[0]!), 'failed')
  assert.equal(
    toolState(tools(result(call(emptyThread()), 'cancelled', 3, 'c1', true, 'TOOL_ABORTED'))[0]!),
    'cancelled',
  )
  assert.equal(toolState(tools(result(call(emptyThread()), '', 3, 'c1', true, 'TOOL_OUTCOME_UNKNOWN'))[0]!), 'unknown')
  let state = call(emptyThread())
  state = applyLogEvent(state, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(toolState(tools(state)[0]!), 'unknown', 'turn abort does not prove child process cancelled')
})

test('a cancelled argument proposal has not executed; late stream cannot reopen a settled turn', () => {
  let state = chunk(start(emptyThread()))
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: { type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'abandoned' } },
  })
  assert.equal(toolState(tools(state)[0]!), 'cancelled')
  state = applyLogEvent(state, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  state = start(state, 10)
  state = chunk(state, 11)
  assert.equal(tools(state).length, 1)
  assert.equal(toolState(tools(state)[0]!), 'cancelled')
  assert.equal(state.drafting, false)
})

test('late old stream frames do not roll back revisions or completed calls', () => {
  let state = result(call(chunk(start(emptyThread()))))
  const revision = state.streamRevision
  state = chunk(state, 2)
  state = start(state, 1)
  assert.equal(state.streamRevision, revision)
  assert.equal(toolState(tools(state)[0]!), 'succeeded')
  assert.equal(tools(state).length, 1)
})

test('reconnect baseline replay replaces stream prefix rather than appending it twice', () => {
  const snapshot = {
    type: 'snapshot',
    projections: { values: {} },
    assistantStream: {
      revision: 5,
      activeAttempt: {
        attemptId: 'a',
        startedAfterSeq: 0,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['hello'] }],
      },
    },
  }
  let state = applyEphemeralFrame(emptyThread(), snapshot)
  state = applyEphemeralFrame(state, snapshot)
  assert.deepEqual(
    state.segments.filter(s => s.kind === 'assistant').map(s => s.text),
    ['hello'],
  )
})

test('replay after refresh and incremental gap fill have the same final tool states', () => {
  const run = (state: ThreadState) => result(call(state), '[exit code: 2]')
  const expected = run(emptyThread())
  let reconnect = run(emptyThread())
  reconnect = run(reconnect)
  assert.deepEqual(tools(reconnect), tools(expected))
})

test('shell markers are tool-specific; background ack and timeout promotion are not completion', () => {
  assert.equal(resultStatus('bash', 'started background job job-1', false), 'background')
  assert.equal(resultStatus('bash', '[still running after 20ms; moved to background job job-2]', false), 'background')
  assert.equal(resultStatus('bash', '[exit code: 7]', false), 'failed')
  assert.equal(resultStatus('bash', '[killed by signal: SIGTERM]', false), 'failed')
  assert.equal(resultStatus('bash', '[stopped: cancelled]', false), 'cancelled')
  assert.equal(resultStatus('read', '[exit code: 7]', false), 'succeeded', 'file content is not a shell status')
  assert.equal(resultStatus('bash', 'my test said failed', false), 'succeeded')
  assert.equal(
    resultStatus('bash', 'started background job job-1\njob-ok\n[exit code: 0]', false),
    'succeeded',
    'a later exit in the same result is completion evidence, not an open job',
  )
  assert.equal(resultStatus('bash', 'started background job job-1\n[exit code: 7]', false), 'failed')
  assert.equal(
    resultStatus('bash', '[still running after 20ms; moved to background job job-2]\n[stopped: cancelled]', false),
    'cancelled',
  )
})

test('multiple workers keep separate ticket/revision/report associations without claiming delivery', () => {
  const tickets: WorkTicket[] = [
    {
      id: 't1',
      revision: 2,
      status: 'started',
      childSessionId: 'worker-a',
      startedAt: null,
      summary: 'Build',
      events: [{ eventId: 'e1', kind: 'progress', applyStatus: 'applied', revision: 2, text: 'Building' }],
    },
    {
      id: 't2',
      revision: 1,
      status: 'ready',
      childSessionId: 'worker-b',
      startedAt: null,
      summary: 'Test',
      events: [],
    },
  ]
  const a = toolPresentation(
    tool({ name: 'foundations_dispatch', resultReceived: true, status: 'succeeded', result: '{"ticketId":"t1"}' }),
    '/tmp',
    tickets,
  )
  const b = toolPresentation(
    tool({
      callId: 'c2',
      name: 'foundations_dispatch',
      resultReceived: true,
      status: 'succeeded',
      result: '{"ticketId":"t2"}',
    }),
    '/tmp',
    tickets,
  )
  assert.equal(a.status, 'worker')
  assert.equal(b.status, 'worker')
  assert.equal(a.ticket?.childSessionId, 'worker-a')
  assert.equal(b.ticket?.childSessionId, 'worker-b')
  assert.equal(a.ticket?.revision, 2)
  tickets[0]!.status = 'delivered'
  assert.equal(
    toolPresentation(
      tool({ name: 'foundations_dispatch', resultReceived: true, result: '{"ticketId":"t1"}' }),
      '/tmp',
      tickets,
    ).status,
    'succeeded',
  )
})

test('command, description, multiline args, cwd and explicit exit status remain separate', () => {
  const view = toolPresentation(
    tool({
      args: JSON.stringify({ command: 'printf a\nprintf b', description: 'Print two lines', workdir: 'child' }),
      result: '[exit code: 5]',
      resultReceived: true,
      meta: { cwd: '/actual/child' },
    }),
    '/session',
  )
  assert.equal(view.command, 'printf a\nprintf b')
  assert.equal(view.description, 'Print two lines')
  assert.equal(view.cwd, '/actual/child')
  assert.equal(view.exitCode, 5)
  assert.equal(
    toolPresentation(tool({ resultReceived: true, result: '(no output)' })).exitCode,
    null,
    'never invent exit code 0',
  )
})

test('todo_write renders actual content and statuses, not guessed completion', () => {
  const view = toolPresentation(
    tool({
      name: 'todo_write',
      args: JSON.stringify({
        todos: [
          { content: 'Scaffold', status: 'completed' },
          { content: 'Test', status: 'in_progress' },
        ],
      }),
    }),
  )
  assert.deepEqual(view.todos, [
    { content: 'Scaffold', status: 'completed' },
    { content: 'Test', status: 'in_progress' },
  ])
  assert.deepEqual(argsOf('broken'), {})
})

test('mask credentials in args, nested structures, command, output and copy projections', () => {
  const secrets = ['alphaSecret', 'betaSecret', 'gammaSecret', 'deltaSecret', 'epsilonSecret']
  const raw = JSON.stringify({
    apiKey: secrets[0],
    nested: { password: secrets[1] },
    command: `API_TOKEN=${secrets[2]} curl -H 'Authorization: Bearer ${secrets[3]}' https://user:${secrets[4]}@example.com`,
  })
  const view = toolPresentation(tool({ args: raw, result: 'token=alphaSecret\n{"password":"betaSecret"}' }))
  for (const secret of secrets) {
    assert.ok(!view.args.includes(secret), secret)
    assert.ok(!view.command.includes(secret), secret)
    assert.ok(!view.output.includes(secret), secret)
  }
  assert.ok(!safeArgs('{"token":"partialSecret').includes('partialSecret'))
  assert.ok(!redactText('--password "multi\nlineSecret"').includes('lineSecret'))
  assert.equal(redactText('printf hello'), 'printf hello')
})

test('a quiet task stays waiting without a fixed timeout; model narration is not execution evidence', () => {
  let state = call(emptyThread())
  state = applyLogEvent(state, {
    type: 'assistant/message',
    seq: 9,
    time: 99999999,
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'The build has completed successfully' }] } },
  })
  assert.equal(toolState(tools(state)[0]!), 'waiting')
  assert.equal(resultStatus('bash', 'TOOL_OUTCOME_UNKNOWN printed by my program', false), 'succeeded')
})

test('reasoning stream becomes a single persisted row, not both live and durable thinking', () => {
  let state = start(emptyThread())
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'a',
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'Plan' },
    },
  })
  state = applyLogEvent(state, {
    type: 'assistant/message',
    seq: 5,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: 'Plan' },
          { type: 'text', text: 'Done' },
        ],
      },
    },
  })
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: {
      type: 'end',
      attemptId: 'a',
      revision: 3,
      index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 },
    },
  })
  assert.equal(state.segments.filter(s => s.kind === 'think').length, 1)
  assert.ok(!state.segments.some(s => s.id.startsWith('live:')))
})

test('old-revision/stale worker reports are not selected as the latest current task report', () => {
  const ticket: WorkTicket = {
    id: 't',
    revision: 2,
    status: 'started',
    childSessionId: 'worker-a',
    startedAt: null,
    summary: 'Current task',
    events: [
      { eventId: 'new', revision: 2, kind: 'progress', applyStatus: 'applied', text: 'Current report' },
      { eventId: 'old', revision: 1, kind: 'progress', applyStatus: 'applied', text: 'Old revision report' },
      { eventId: 'stale', revision: 2, kind: 'progress', applyStatus: 'stale', text: 'Late stale report' },
    ],
  }
  const view = toolPresentation(
    tool({ name: 'foundations_dispatch', resultReceived: true, result: '{"ticketId":"t"}' }),
    undefined,
    [ticket],
  )
  assert.equal(view.latestReport, 'Current report')
})

test('result-first cancellation/recovery codes settle without requiring a subsequent call', () => {
  assert.equal(toolState(tools(result(emptyThread(), '', 3, 'c1', true, 'TOOL_ABORTED'))[0]!), 'cancelled')
  assert.equal(toolState(tools(result(emptyThread(), '', 3, 'c1', true, 'TOOL_OUTCOME_UNKNOWN'))[0]!), 'unknown')
})

test('a failed model attempt does not block a fresh retry on the same turn and step', () => {
  let state = start(emptyThread())
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'a',
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'Partial failed attempt' },
    },
  })
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: {
      type: 'end',
      attemptId: 'a',
      revision: 3,
      index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 5 },
    },
  })
  state = applyEphemeralFrame(state, {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'b', revision: 4, startedAfterSeq: 5, turn: 1, step: 1 },
  })
  assert.equal(state.streamAttempt?.attemptId, 'b')
  assert.ok(!state.segments.some(s => s.kind === 'think' && s.text === 'Partial failed attempt'))
})
