import assert from 'node:assert/strict'
import test from 'node:test'
import { ingestFrame, isOpeningSnapshot, openingHistoryCut, processHeading, turnPieces } from './follow.ts'
import { emptyThread, type Segment, type ThreadState, type ToolSegment } from './types.ts'

function reduce(frames: unknown[]): ThreadState {
  const seen = new Set<number>()
  return frames.reduce<ThreadState>((state, frame) => ingestFrame(state, frame, seen), emptyThread())
}

function item(value: unknown): unknown {
  return { type: 'item', streamId: 'follow', value }
}

function assistantText(state: ThreadState): string {
  return state.segments
    .filter(segment => segment.kind === 'assistant')
    .map(segment => segment.text)
    .join('')
}

test('the opening snapshot is the completed history page', () => {
  assert.equal(isOpeningSnapshot(item({ type: 'snapshot', records: [], hasMore: false })), true)
  assert.equal(isOpeningSnapshot(item({ type: 'event', event: { type: 'turn/end', seq: 1, data: {} } })), false)
})

test('the opening page cut is the first seq that page carries', () => {
  const frame = item({
    type: 'snapshot',
    hasMore: true,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 40, data: {} } },
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 41,
          data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
        },
      },
    ],
  })
  assert.equal(openingHistoryCut(frame), 40)
  assert.equal(openingHistoryCut(item({ type: 'snapshot', records: [], hasMore: false })), 0)
  assert.equal(openingHistoryCut(item({ type: 'event', event: { type: 'turn/end', seq: 1, data: {} } })), null)
})

test('text deltas grow one step before the durable message replaces them', () => {
  const started = reduce([
    item({ type: 'snapshot', projections: { values: {} }, assistantStream: { revision: 4 } }),
    item({
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'a', revision: 5, startedAfterSeq: 3, turn: 1, step: 1 },
    }),
  ])
  const first = ingestFrame(
    started,
    item({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'a',
        revision: 6,
        index: 0,
        time: 10,
        chunk: { type: 'text-delta', index: 0, text: 'Hel' },
      },
    }),
    new Set(),
  )
  assert.equal(assistantText(first), 'Hel')
  assert.equal(
    first.segments.some(segment => segment.kind === 'assistant' && segment.streaming),
    true,
  )

  const second = ingestFrame(
    first,
    item({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'a',
        revision: 7,
        index: 1,
        time: 11,
        chunk: { type: 'text-delta', index: 0, text: 'lo' },
      },
    }),
    new Set(),
  )
  assert.equal(assistantText(second), 'Hello')

  const held = ingestFrame(
    second,
    item({
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 8,
        time: 12,
        surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello!' }] } },
      },
    }),
    new Set(),
  )
  assert.equal(assistantText(held), 'Hello')
  assert.equal(
    held.segments.some(segment => segment.kind === 'assistant' && segment.streaming),
    true,
  )

  const done = ingestFrame(
    held,
    item({
      type: 'assistant-stream',
      frame: {
        type: 'end',
        attemptId: 'a',
        revision: 8,
        index: 2,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 8 },
      },
    }),
    new Set([8]),
  )
  assert.equal(assistantText(done), 'Hello!')
  assert.equal(
    done.segments.some(segment => segment.kind === 'assistant' && segment.streaming),
    false,
  )
})

test('a reconnect baseline keeps the prefix and continues from the next chunk', () => {
  const state = reduce([
    item({
      type: 'snapshot',
      projections: { values: {} },
      assistantStream: {
        revision: 9,
        activeAttempt: {
          attemptId: 'a',
          startedAfterSeq: 2,
          turn: 2,
          step: 1,
          nextIndex: 2,
          stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['ab', 'c'] }],
        },
      },
    }),
  ])
  assert.equal(assistantText(state), 'abc')
  const more = ingestFrame(
    state,
    item({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'a',
        revision: 10,
        index: 2,
        time: 3,
        chunk: { type: 'text-delta', index: 0, text: 'd' },
      },
    }),
    new Set(),
  )
  assert.equal(assistantText(more), 'abcd')
})

test('reasoning deltas stay on the open step instead of waiting for the message', () => {
  const state = reduce([
    item({
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
    }),
    item({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'a',
        revision: 2,
        index: 0,
        time: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'First' },
      },
    }),
    item({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'a',
        revision: 3,
        index: 1,
        time: 2,
        chunk: { type: 'reasoning-delta', index: 0, text: ' thought' },
      },
    }),
  ])
  const think = state.segments.find(segment => segment.kind === 'think')
  assert.equal(think?.kind === 'think' ? think.text : '', 'First thought')
  assert.equal(think?.kind === 'think' ? think.running : false, true)
})

test('a timed-out turn keeps the retry chain and the terminal failure', () => {
  const state = reduce([
    item({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 3 } } }),
    item({
      type: 'event',
      event: {
        type: 'user/message',
        seq: 2,
        time: 1_100,
        data: {
          turn: 3,
          message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'write a startup note' }] },
        },
      },
    }),
    item({
      type: 'event',
      event: {
        type: 'llm/retry',
        seq: 3,
        time: 2_000,
        data: {
          turn: 3,
          step: 12,
          retryId: 'r1',
          retry: 5,
          maxRetries: 5,
          delayMs: 8483,
          failure: { message: 'Request timed out.', code: 'TIMEOUT' },
        },
      },
    }),
    item({
      type: 'event',
      event: { type: 'llm/retry-started', seq: 4, time: 10_500, data: { turn: 3, step: 12, retryId: 'r1', retry: 5 } },
    }),
    item({
      type: 'event',
      event: {
        type: 'turn/end',
        seq: 5,
        time: 194_000,
        data: { turn: 3, reason: { kind: 'error', error: { message: 'Request timed out.', code: 'TIMEOUT' } } },
      },
    }),
  ])
  assert.equal(state.completed[3], 193)
  assert.deepEqual(state.failures[3], { message: 'Request timed out.', code: 'TIMEOUT' })
  assert.equal(state.retries[3]?.length, 1)
  assert.equal(state.retries[3]?.[0]?.state, 'started')
  assert.equal(state.retries[3]?.[0]?.delayMs, 8483)
  assert.equal(state.drafting, false)
})

test('ordered events keep a finished turn closed after later turns complete', () => {
  // The Sequencer delivers strictly increasing seqs, so the reducer no longer
  // has to defend against a late CDC prefix reopening a turn.
  const state = reduce([
    item({ type: 'event', event: { type: 'turn/start', seq: 259, time: 1_000, data: { turn: 18 } } }),
    item({
      type: 'event',
      event: { type: 'tool/call', seq: 264, data: { turn: 18, step: 1, callId: 'c1', name: 'edit', arguments: '{}' } },
    }),
    item({
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 265,
        data: {
          turn: 18,
          step: 1,
          callId: 'c1',
          message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
        },
      },
    }),
    item({
      type: 'event',
      event: { type: 'turn/end', seq: 272, time: 2_000, data: { turn: 18, reason: { kind: 'completed' } } },
    }),
    item({ type: 'event', event: { type: 'turn/start', seq: 274, time: 3_000, data: { turn: 19 } } }),
    item({
      type: 'event',
      event: { type: 'turn/end', seq: 287, time: 4_000, data: { turn: 19, reason: { kind: 'completed' } } },
    }),
  ])
  assert.equal(state.drafting, false)
  assert.equal(state.activity, '')
  assert.equal(state.turn, 19)
  const tool = state.segments.find(segment => segment.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.running : true, false)
})

test('a completed turn does not record a failure', () => {
  const state = reduce([
    item({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } } }),
    item({
      type: 'event',
      event: { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } },
    }),
  ])
  assert.equal(state.failures[1], undefined)
  assert.equal(state.completed[1], 1)
})

function text(seq: number, value: string): Segment {
  return { kind: 'assistant', id: `t${seq}`, text: value, streaming: false, seq, turn: 1, step: seq }
}

function tool(seq: number, name: string, args = ''): ToolSegment {
  return {
    kind: 'tool',
    id: `c${seq}`,
    callId: `c${seq}`,
    name,
    args,
    result: '',
    error: false,
    running: false,
    seq,
    turn: 1,
    step: seq,
  }
}

function think(seq: number, value: string): Segment {
  return { kind: 'think', id: `k${seq}`, text: value, running: false, seq, turn: 1, step: seq }
}

test('assistant text stays between the tool batches around it', () => {
  const pieces = turnPieces([
    tool(1, 'read'),
    think(2, 'check the sibling'),
    tool(3, 'read'),
    text(4, "I'll start by inspecting the workspace."),
    tool(5, 'write'),
    tool(6, 'read'),
    text(7, 'Skeleton is on disk.'),
    tool(8, 'edit'),
    think(9, 'ports'),
    tool(10, 'read'),
    text(11, 'the one-page site is up'),
  ])
  assert.deepEqual(
    pieces.map(piece =>
      piece.type === 'activity'
        ? processHeading(piece.segments)
        : piece.type === 'question'
          ? piece.segment.name
          : piece.segment.text,
    ),
    [
      'Read files',
      "I'll start by inspecting the workspace.",
      'Wrote files and read files',
      'Skeleton is on disk.',
      'Edited files and read files',
      'the one-page site is up',
    ],
  )
})

test('a running batch uses the present-tense heading', () => {
  const heading = processHeading([tool(1, 'write'), tool(2, 'read'), tool(3, 'foundations_report')], true)
  assert.equal(heading, 'Writing files, reading files, calling tools')
})

test('ask_user_question stays a first-class piece between surrounding activity', () => {
  const question = tool(
    4,
    'ask_user_question',
    JSON.stringify({
      questions: [{ id: 'confirm_delete', header: '确认删除', question: '删除这两个目录吗？' }],
    }),
  )
  const pieces = turnPieces([tool(1, 'bash'), think(2, 'check size'), question, tool(5, 'bash')])
  assert.deepEqual(
    pieces.map(piece =>
      piece.type === 'text'
        ? piece.segment.text
        : piece.type === 'question'
          ? piece.segment.name
          : piece.segments.map(s => s.kind),
    ),
    [['tool', 'think'], 'ask_user_question', ['tool']],
  )
})
