import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { applyLogEvent, applyEphemeralFrame, turnPieces } from '../ui/src/follow.ts'
import { emptyThread, type ThreadState } from '../ui/src/types.ts'

// SSR only: no browser automation. Bundle the UI with its own React installation.
const compiled = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { Transcript } from './ui/src/transcript.tsx'
      import { CurrentActivity } from './ui/src/CurrentActivity.tsx'
      import { ToolApprovalCard } from './ui/src/ToolApprovalCard.tsx'
      import { SettingsDrawer } from './ui/src/SettingsPanels.tsx'
      import { ToolCallRow, ToolCallRowView, ActivityGroup, ActivityDisclosure } from './ui/src/ProcessRow.tsx'
      import { Collapse } from './ui/src/Collapse.tsx'
      export const renderExpandedTool = props => renderToStaticMarkup(<ToolCallRowView open={true} argsOpen={true} onToggle={() => {}} onArgsToggle={() => {}} {...props} />)
      export const exerciseDisclosure = props => {
        const element = ActivityDisclosure(props)
        const [button, panel] = React.Children.toArray(element.props.children)
        let stopped = false
        if (props.click) button.props.onClick({ stopPropagation() { stopped = true } })
        return JSON.stringify({ stopped, usesCollapse: panel.props.children.type === Collapse, open: panel.props.children.props.open, expanded: button.props['aria-expanded'], controls: button.props['aria-controls'], panelId: panel.props.id })
      }
      export const renderTranscript = (props) => renderToStaticMarkup(<Transcript {...props} />)
      export const renderTool = (props) => renderToStaticMarkup(<ToolCallRow {...props} />)
      export const renderCurrent = (props) => renderToStaticMarkup(<CurrentActivity {...props} />)
      export const renderActivity = (props) => renderToStaticMarkup(<ActivityGroup {...props} />)
      export const renderApproval = (props) => renderToStaticMarkup(<ToolApprovalCard {...props} />)
      export const renderSettingsDrawer = (props = {}) => renderToStaticMarkup(
        <div className="shell">
          <div className="composer-wrap">
            <form className="column">
              <p className="stats">1 turns · 1 steps</p>
            </form>
          </div>
          <SettingsDrawer title={props.title || 'Permissions'} closeLabel={props.closeLabel || 'Close'} onClose={() => {}}>
            {props.children || <p>drawer body</p>}
          </SettingsDrawer>
        </div>
      )
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'tsx',
  },
  alias: {
    react: new URL('../ui/node_modules/react', import.meta.url).pathname,
    'react-dom': new URL('../ui/node_modules/react-dom', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
})
const mod = { exports: {} as Record<string, (props: unknown) => string> }
new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
)
const {
  renderTranscript,
  renderTool,
  renderActivity,
  renderCurrent,
  renderExpandedTool,
  exerciseDisclosure,
  renderApproval,
  renderSettingsDrawer,
} = mod.exports
const tool = (id: string, values = {}) => ({
  kind: 'tool',
  id,
  callId: id,
  name: 'bash',
  args: '{"command":"printf ok","description":"Print output"}',
  result: '',
  running: true,
  error: false,
  status: 'waiting',
  turn: 1,
  seq: 1,
  ...values,
})
const base = {
  completed: {},
  failures: {},
  retries: {},
  turnEnds: {},
  tickets: [],
  now: 0,
  canRetry: false,
  onRetry() {},
  onSupply() {},
  onOpenSession() {},
  onOpenFile() {},
  onOpenInbox() {},
  botLabel: (id: string) => id,
  drafting: true,
  currentTurn: 1,
}

test('SSR: tool/text interleaving preserves log order in Bot and normal modes', () => {
  for (const chat of [true, false]) {
    const html = renderTranscript!({
      ...base,
      chat,
      segments: [
        tool('c1', { args: '{"description":"FIRST_TOOL","command":"printf one"}' }),
        { kind: 'assistant', id: 'a1', text: 'FIRST_TEXT', seq: 2, turn: 1 },
        tool('c2', { seq: 3, args: '{"description":"SECOND_TOOL","command":"printf two"}' }),
        { kind: 'assistant', id: 'a2', text: 'SECOND_TEXT', seq: 4, turn: 1 },
      ],
    })
    const positions = ['FIRST_TOOL', 'FIRST_TEXT', 'SECOND_TOOL', 'SECOND_TEXT'].map(text => html.indexOf(text))
    assert.ok(positions.every(p => p >= 0))
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
      'a tool after text must not be hoisted before that text',
    )
    assert.equal((html.match(/aria-label="Activity"/g) ?? []).length, 2, 'text separates process groups')
    assert.ok(!html.includes('Thinking'))
  }
})

test('SSR: description and command coexist; full multiline args, cwd, result and safe copy content', () => {
  const html = renderExpandedTool!({
    segment: tool('c1', {
      args: JSON.stringify({
        command: 'printf a\nprintf b\nTOKEN=hiddenSecret',
        description: 'Scaffold tea project',
        workdir: '/tmp/tea',
      }),
      result: 'token=hiddenSecret',
      resultReceived: true,
      status: 'background',
    }),
  })
  for (const text of ['Scaffold tea project', 'printf a\nprintf b', '/tmp/tea', 'Full arguments', 'Tool result'])
    assert.ok(html.includes(text), text)
  assert.ok(!html.includes('hiddenSecret'))
  assert.ok(html.includes('REDACTED'))
})

test('SSR: todo rows show real items, not todo_write duplicated as its own summary', () => {
  const html = renderExpandedTool!({
    segment: tool('c1', {
      name: 'todo_write',
      args: JSON.stringify({
        todos: [
          { content: 'Scaffold tea', status: 'completed' },
          { content: 'Run tests', status: 'in_progress' },
        ],
      }),
    }),
  })
  assert.ok(html.includes('Update plan'))
  assert.ok(html.includes('Scaffold tea') && html.includes('Run tests'))
  assert.ok(html.includes('1/2'))
  assert.ok(!html.includes('todo_write · todo_write'))
})

test('SSR: sync uncertainty stays separate; empty turn only has one compact composer status', () => {
  const html = renderActivity!({ segments: [tool('c1')], connectionPhase: 'syncing', pending: true })
  assert.ok(html.includes('Resyncing · last known state'))
  assert.ok(renderExpandedTool!({ segment: tool('c1'), stale: true }).includes('Waiting for tool result'))
  assert.ok(!html.includes('Running commands'))
  const empty = renderTranscript!({ ...base, segments: [] })
  assert.equal((empty.match(/aria-label="Activity"/g) ?? []).length, 0)
  const current = renderCurrent!({ segments: [], drafting: true, currentTurn: 1, connectionPhase: 'live' })
  assert.equal((current.match(/role="status"/g) ?? []).length, 1)
  assert.ok(current.includes('Waiting for model response'))
  assert.ok(!current.includes('Activity') && !current.includes('Thinking'))
  assert.equal(renderCurrent!({ segments: [], drafting: false }), '')
})

test('SSR: parallel worker rows show each ticket and latest report, not generic Thinking', () => {
  const ticket = (id: string) => ({
    id,
    revision: 2,
    status: 'started',
    childSessionId: `worker-${id}`,
    startedAt: null,
    summary: `Task ${id}`,
    events: [{ eventId: `event-${id}`, kind: 'progress', applyStatus: 'applied', revision: 2, text: `Report ${id}` }],
  })
  const tickets = [ticket('t1'), ticket('t2')]
  const html = renderActivity!({
    segments: [
      tool('c1', {
        name: 'foundations_dispatch',
        result: '{"ticketId":"t1"}',
        resultReceived: true,
        status: 'succeeded',
      }),
      tool('c2', {
        name: 'foundations_dispatch',
        result: '{"ticketId":"t2"}',
        resultReceived: true,
        status: 'succeeded',
      }),
    ],
    tickets,
  })
  const expanded = ['t1', 't2']
    .map((id, index) =>
      renderExpandedTool!({
        segment: tool(`c${index + 1}`, {
          name: 'foundations_dispatch',
          result: JSON.stringify({ ticketId: id }),
          resultReceived: true,
          status: 'succeeded',
        }),
        tickets,
      }),
    )
    .join('')
  for (const text of ['worker-t1', 'worker-t2', 'Report t1', 'Report t2']) assert.ok(expanded.includes(text), text)
  assert.equal((html.match(/data-state="worker"/g) ?? []).length, 2)
})

function ordered(html: string, markers: string[]) {
  const positions = markers.map(marker => html.indexOf(marker))
  assert.ok(
    positions.every(position => position >= 0),
    `missing marker in ${markers.join(', ')}`,
  )
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `wrong SSR positions: ${markers.join(', ')}`,
  )
}
const think = (id: string, seq: number, turn = 1) => ({
  kind: 'think',
  id,
  text: `Reason ${id}`,
  running: true,
  seq,
  turn,
})
const text = (id: string, value: string, seq: number, turn = 1) => ({
  kind: 'assistant',
  id,
  text: value,
  streaming: false,
  seq,
  turn,
})

test('SSR: thinking/tool/text cycles remain interleaved across steps and turns in both modes', () => {
  for (const chat of [true, false]) {
    const html = renderTranscript!({
      ...base,
      chat,
      segments: [
        think('think-a', 1),
        tool('call-a', { seq: 2 }),
        text('text-a', 'FIRST_ANSWER', 3),
        think('think-b', 4),
        tool('call-b', { seq: 5 }),
        text('text-b', 'SECOND_ANSWER', 6),
        { kind: 'user', id: 'u2', text: 'Next task', turn: 2, seq: 7 },
        think('think-c', 8, 2),
        tool('call-c', { seq: 9, turn: 2 }),
        text('text-c', 'THIRD_ANSWER', 10, 2),
      ],
    })
    ordered(html, [
      'data-segment="think-a"',
      'data-segment="call-a"',
      'FIRST_ANSWER',
      'data-segment="think-b"',
      'data-segment="call-b"',
      'SECOND_ANSWER',
      'data-segment="think-c"',
      'data-segment="call-c"',
      'THIRD_ANSWER',
    ])
    assert.equal((html.match(/aria-label="Activity"/g) ?? []).length, 3)
  }
})

test('SSR: only contiguous process segments group; empty and consecutive text boundaries stay in place', () => {
  const html = renderTranscript!({
    ...base,
    segments: [
      think('a', 1),
      tool('b', { seq: 2 }),
      think('c', 3),
      tool('d', { seq: 4 }),
      text('empty', '', 5),
      tool('e', { seq: 6 }),
      text('reply1', 'ANSWER_ONE', 7),
      text('reply2', 'ANSWER_TWO', 8),
      tool('f', { seq: 9 }),
    ],
  })
  assert.equal((html.match(/aria-label="Activity"/g) ?? []).length, 3)
  ordered(html, [
    'data-segment="a"',
    'data-segment="b"',
    'data-segment="c"',
    'data-segment="d"',
    'data-segment="empty"',
    'data-segment="e"',
    'ANSWER_ONE',
    'ANSWER_TWO',
    'data-segment="f"',
  ])
})

const message = (seq: number, step: number, id: string) => ({
  type: 'assistant/message',
  seq,
  data: {
    turn: 1,
    step,
    message: {
      id: `msg-${id}`,
      content: [
        { type: 'reasoning', text: `Reason ${id}` },
        {
          type: 'tool-call',
          id,
          name: 'bash',
          arguments: JSON.stringify({ command: `printf ${id}`, description: `Task ${id}` }),
        },
        { type: 'text', text: `ANSWER_${id}` },
      ],
    },
  },
})
const callEvent = (seq: number, step: number, id: string) => ({
  type: 'tool/call',
  seq,
  data: {
    turn: 1,
    step,
    callId: id,
    name: 'bash',
    arguments: JSON.stringify({ command: `printf ${id}`, description: `Task ${id}` }),
  },
})
const resultEvent = (seq: number, step: number, id: string) => ({
  type: 'tool/result',
  seq,
  data: { turn: 1, step, message: { toolCallId: id, content: [] } },
})

function assertJournalPositions(state: ThreadState, chat: boolean) {
  assert.deepEqual(
    state.segments.map(s => s.kind),
    ['think', 'tool', 'assistant', 'think', 'tool', 'assistant'],
  )
  const html = renderTranscript!({ ...base, ...state, chat })
  ordered(html, ['data-activity-start="think:1:1:0"', 'ANSWER_A', 'data-activity-start="think:1:2:0"', 'ANSWER_B'])
  return turnPieces(state.segments).map(piece =>
    piece.type === 'text'
      ? piece.segment.text
      : piece.type === 'question'
        ? piece.segment.callId
        : piece.segments.map(s => (s.kind === 'tool' ? s.callId : s.text)),
  )
}

test('SSR: live → durable, replay, gap recovery and late results keep calls at their original positions', () => {
  const journal = [
    message(1, 1, 'A'),
    callEvent(2, 1, 'A'),
    message(3, 2, 'B'),
    callEvent(4, 2, 'B'),
    resultEvent(5, 2, 'B'),
    resultEvent(6, 1, 'A'),
  ]
  const replay = journal.reduce((state, event) => applyLogEvent(state, event), emptyThread())
  let live = emptyThread()
  let revision = 0
  for (const [step, id, seq] of [
    [1, 'A', 1],
    [2, 'B', 3],
  ] as const) {
    const attemptId = `attempt-${id}`
    live = applyEphemeralFrame(live, {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId, revision: ++revision, startedAfterSeq: seq - 1, turn: 1, step },
    })
    const chunks = [
      { type: 'reasoning-delta', index: 0, text: `Reason ${id}` },
      {
        type: 'tool-call-delta',
        index: 1,
        id,
        name: 'bash',
        argumentsDelta: JSON.stringify({ command: `printf ${id}`, description: `Task ${id}` }),
      },
      { type: 'text-delta', index: 2, text: `ANSWER_${id}` },
    ]
    chunks.forEach((chunk, index) => {
      live = applyEphemeralFrame(live, {
        type: 'assistant-stream',
        frame: { type: 'chunk', attemptId, revision: ++revision, index, time: 1, chunk },
      })
    })
    const streaming = renderTranscript!({ ...base, ...live })
    ordered(streaming, [`Task ${id}`, `ANSWER_${id}`])
    // Commit may be held until stream end; the call can arrive before that end frame.
    live = applyLogEvent(live, message(seq, step, id))
    live = applyLogEvent(live, callEvent(seq + 1, step, id))
    live = applyEphemeralFrame(live, {
      type: 'assistant-stream',
      frame: {
        type: 'end',
        attemptId,
        revision: ++revision,
        index: 3,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq },
      },
    })
  }
  const before = live.segments.map(s => [s.kind, s.seq])
  live = applyLogEvent(live, resultEvent(6, 1, 'A')) // Late result must update A, not append after B/text B.
  live = applyLogEvent(live, resultEvent(5, 2, 'B'))
  live = applyLogEvent(live, resultEvent(6, 1, 'A')) // Replay duplicate.
  assert.deepEqual(
    live.segments.map(s => [s.kind, s.seq]),
    before,
  )
  for (const chat of [true, false])
    assert.deepEqual(assertJournalPositions(live, chat), assertJournalPositions(replay, chat))
  let recovered = journal.slice(0, 2).reduce((state, event) => applyLogEvent(state, event), emptyThread())
  for (const event of journal.slice(2)) recovered = applyLogEvent(recovered, event)
  assert.deepEqual(assertJournalPositions(recovered, true), assertJournalPositions(replay, true))
})

test('SSR: composer has one sanitized compact status, with no animation for settled or disconnected activity', () => {
  const props = {
    segments: [tool('c1', { args: '{"description":"Fix UI token=secretValue","command":"printf ok"}' })],
    drafting: true,
    currentTurn: 1,
  }
  const html = renderCurrent!(props)
  assert.equal((html.match(/role="status"/g) ?? []).length, 1)
  assert.ok(html.includes('Waiting for tool result: Fix UI'))
  assert.ok(html.includes('data-moving="true"'))
  assert.ok(!html.includes('secretValue') && !html.includes('Activity') && !html.includes('Thinking'))
  const stale = renderCurrent!({ ...props, connectionPhase: 'error' })
  assert.ok(stale.includes('last known') && stale.includes('data-moving="false"'))
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown']) {
    assert.equal(renderCurrent!({ segments: [tool('c1', { status, running: false })], drafting: false }), '')
  }
  const thinking = renderCurrent!({ segments: [think('t', 1)], drafting: true })
  assert.equal((thinking.match(/>Thinking</g) ?? []).length, 1)
  const workers = renderCurrent!({
    segments: [],
    drafting: false,
    tickets: ['one', 'two'].map(id => ({ id, status: 'started', summary: `Task ${id}` })),
  })
  assert.ok(workers.includes('2 pending activities') && workers.includes('Waiting for Worker'))
  assert.ok(!workers.includes('Running'))
})

test('SSR/CSS: hidden documents pause the compact sweep and reduced motion disables animation', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'hidden' }, configurable: true })
  try {
    const html = renderCurrent!({ segments: [tool('c1')], drafting: true })
    assert.ok(html.includes('data-moving="false"'))
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.composer-activity[\s\S]*?animation: none/)
  assert.match(css, /\.composer-activity-text\s*\{[^}]*text-overflow: ellipsis/)
})

test('SSR: a result-first recovery takes the late call position, not the result arrival position', () => {
  let state = applyLogEvent(emptyThread(), {
    type: 'assistant/message',
    seq: 3,
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'AFTER_CALL' }] } },
  })
  state = applyLogEvent(state, resultEvent(5, 1, 'A'))
  state = applyLogEvent(state, callEvent(1, 1, 'A'))
  state = applyLogEvent(state, resultEvent(5, 1, 'A'))
  const html = renderTranscript!({ ...base, ...state })
  ordered(html, ['data-activity-start="tool:A"', 'AFTER_CALL'])
  assert.equal(state.segments.filter(s => s.kind === 'tool').length, 1)
})

test('SSR: every tool defaults closed with a title-only summary, including active calls', () => {
  for (const status of [
    'preparing',
    'waiting',
    'running',
    'worker',
    'background',
    'succeeded',
    'failed',
    'cancelled',
    'unknown',
  ]) {
    const html = renderTool!({
      segment: tool('title-only', {
        status,
        args: JSON.stringify({
          description: 'Build tea project after TS migration',
          command: 'npm run build\nTOKEN=privateValue',
          workdir: '/private/cwd',
        }),
        result: 'OUTPUT_MARKER',
      }),
    })
    assert.match(html, /^<div\b[^>]*class="official-row tool-activity"/)
    assert.match(html, /aria-expanded="false"/, `${status} must not open automatically`)
    assert.ok(!html.includes('activity-detail') && !html.includes('<details'))
    const summary = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? ''
    assert.ok(summary.includes('Build tea project after TS migration'))
    for (const detail of [
      'npm run build',
      '/private/cwd',
      'OUTPUT_MARKER',
      'Completed',
      'Waiting',
      'Background',
      'Full arguments',
    ])
      assert.ok(!summary.includes(detail), `${detail} must stay out of the collapsed summary`)
    assert.ok(!html.includes('activity-command-summary') && !html.includes('privateValue'))
  }
})

test('SSR: successful activity omits Completed; exceptions remain visible and fallbacks never use commands', () => {
  const complete = tool('done', { status: 'succeeded', running: false, resultReceived: true })
  assert.ok(!renderTool!({ segment: complete }).includes('Completed'))
  assert.ok(!renderActivity!({ segments: [complete] }).includes('Completed'))
  for (const [status, label] of [
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['unknown', 'Outcome unknown'],
  ]) {
    const html = renderTool!({ segment: tool('exception', { status, running: false }) })
    const summary = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? ''
    assert.ok(summary.includes(label!))
  }
  const noDescription = renderTool!({
    segment: tool('generic', { args: '{"command":"VERY_LONG_COMMAND --token=doNotShow"}' }),
  })
  const summary = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(noDescription)?.[1] ?? ''
  assert.ok(summary.includes('Run command') && !summary.includes('VERY_LONG_COMMAND') && !summary.includes('doNotShow'))
})

test('SSR/CSS: expanded-only command/args/output stay complete, redacted and wrapping without nested scrollbars', () => {
  const command = `printf one\nprintf ${'very-long-argument'.repeat(60)}\nTOKEN=hiddenValue`
  const output = `first line\n${'long-output'.repeat(100)}\nlast line`
  const html = renderExpandedTool!({
    segment: tool('wrapped', {
      args: JSON.stringify({ description: 'Build tea project', command, workdir: `/${'deep-directory/'.repeat(40)}` }),
      result: output,
      resultReceived: true,
      status: 'succeeded',
    }),
  })
  const summaryEnd = html.indexOf('</button>')
  const detailStart = html.indexOf('<div class="activity-detail">')
  assert.ok(summaryEnd < detailStart && detailStart < html.indexOf('printf one'))
  assert.ok(html.includes('printf one\nprintf very-long-argument'))
  assert.ok(html.includes(output) && html.includes('last line'))
  assert.ok(!html.includes('hiddenValue') && html.includes('REDACTED'))
  assert.ok(
    (html.match(/aria-label="Copy"/g) ?? []).length >= 3,
    'command, arguments and result keep safe copy controls inside details',
  )
  const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
  const pre = /\.activity-detail pre\s*\{([^}]+)\}/.exec(css)?.[1] ?? ''
  for (const rule of [
    'white-space: pre-wrap',
    'overflow-wrap: anywhere',
    'overflow: visible',
    'max-height: none',
    'min-width: 0',
  ])
    assert.ok(pre.includes(rule), rule)
  assert.ok(!pre.includes('overflow-x: auto') && !pre.includes('overflow: hidden'))
  assert.ok(
    !css.includes('.tool-activity:not([open])'),
    'no native-details hiding rule may bypass the shared animation',
  )
  assert.match(
    css,
    /\.tool-activity \.diff-body\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*overflow: visible/,
  )
  assert.match(
    css,
    /\.tool-activity \.official-label\s*\{[^}]*min-width: 0;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/,
  )
})

test('SSR: tool disclosures use the shared animated Collapse, not native details', () => {
  const html = renderTool!({ segment: tool('animated') })
  assert.ok(!html.includes('<details') && !html.includes('<summary'))
  assert.match(html, /<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/)
  assert.match(html, /class="coll-container"/)
  assert.ok(!html.includes('activity-command'))
})

test('controlled disclosures: tool and arguments toggle independently, stop bubbling and retain accessible controls', () => {
  let outerOpen = false
  let argsOpen = false
  const outer = () => ({
    className: 'official-row tool-activity',
    title: 'Audit',
    panelId: 'outer',
    open: outerOpen,
    onToggle: () => {
      outerOpen = !outerOpen
    },
  })
  const args = () => ({
    className: 'official-row activity-arguments',
    title: 'Arguments',
    panelId: 'args',
    open: argsOpen,
    onToggle: () => {
      argsOpen = !argsOpen
    },
  })
  for (const props of [outer(), args()]) {
    const result = JSON.parse(exerciseDisclosure!(props))
    assert.equal(result.usesCollapse, true, 'must use the actual imported Collapse component')
    assert.equal(result.open, false)
    assert.equal(result.expanded, false)
    assert.equal(result.controls, result.panelId)
  }
  assert.equal(JSON.parse(exerciseDisclosure!({ ...outer(), click: true })).stopped, true)
  assert.equal(outerOpen, true)
  assert.equal(argsOpen, false)
  assert.equal(JSON.parse(exerciseDisclosure!({ ...args(), click: true })).stopped, true)
  assert.equal(outerOpen, true)
  assert.equal(argsOpen, true)
  exerciseDisclosure!({ ...args(), click: true })
  assert.equal(outerOpen, true)
  assert.equal(argsOpen, false)
  exerciseDisclosure!({ ...outer(), click: true })
  assert.equal(outerOpen, false)
  assert.equal(argsOpen, false)
})

test('SSR: arguments have their own animated fold; streamed detail growth is unconstrained and never forces default rows open', () => {
  const segment = tool('independent', {
    args: '{"command":"printf ok","description":"Audit","extra":"ARGS_ONLY_MARKER"}',
  })
  const outerOnly = renderExpandedTool!({ segment, argsOpen: false })
  assert.ok(outerOnly.includes('printf ok') && outerOnly.includes('Full arguments'))
  assert.ok(!outerOnly.includes('ARGS_ONLY_MARKER'))
  assert.equal((outerOnly.match(/class="coll-container expand"/g) ?? []).length, 1)
  const both = renderExpandedTool!({ segment, argsOpen: true })
  assert.ok(both.includes('ARGS_ONLY_MARKER'))
  assert.equal((both.match(/class="coll-container expand"/g) ?? []).length, 2)
  assert.ok(!both.includes('<details') && !both.includes('<summary'))
  const longer = renderExpandedTool!({
    segment: { ...segment, resultReceived: true, result: 'LONG_OUTPUT'.repeat(500) },
  })
  assert.ok(longer.includes('LONG_OUTPUT'.repeat(500)), 'growing results must not be truncated')
  const source = readFileSync(new URL('../ui/src/ProcessRow.tsx', import.meta.url), 'utf8')
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/)
  assert.match(source, /const \[argsOpen, setArgsOpen\] = useState\(false\)/)
  const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
  assert.ok(!css.includes('.tool-activity[open]'), 'native-details state selectors must be removed')
  for (const match of css.matchAll(/\.activity-detail\s*\{([^}]+)\}/g))
    assert.ok(
      !match[1]?.includes('display: none'),
      'shared Collapse, not a stale hidden rule, controls detail visibility',
    )
  assert.match(css, /\.coll-container\.expand\s*\{[^}]*grid-template-rows: 1fr/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.coll-container\s*\{[^}]*transition: none/)
})

test('SSR: settled background jobs do not keep Activity or composer pending', () => {
  const jobs = [1, 2, 3].map(index =>
    tool(`bg${index}`, {
      status: 'background',
      running: false,
      resultReceived: true,
      result: `started background job job-${index}`,
      turn: index,
      args: JSON.stringify({ description: `Job ${index}`, command: 'sleep 1' }),
    }),
  )
  const html = renderActivity!({ segments: jobs })
  assert.equal(html.includes('Active'), false)
  assert.ok(!html.includes('data-state="running"'))
  assert.ok(!html.includes('pending'))
  const current = renderCurrent!({
    segments: jobs,
    drafting: false,
    currentTurn: 3,
    tickets: [
      {
        id: 'dead',
        status: 'failed',
        revision: 1,
        summary: 'Failed task',
        childSessionId: 'worker-dead',
        startedAt: null,
        events: [],
      },
    ],
  })
  assert.equal(current, '')
  const live = renderCurrent!({ segments: [jobs[2]], drafting: true, currentTurn: 3 })
  assert.ok(live.includes('Background job (last known): Job 3'))
  assert.ok(!live.includes('pending') && live.includes('data-moving="false"'))
})

test('SSR: ask_user_question renders a visible option card instead of a generic activity row', () => {
  const question = tool('call_10fxzqal', {
    name: 'ask_user_question',
    args: JSON.stringify({
      questions: [
        {
          id: 'confirm_delete',
          header: '确认删除',
          question: '确认删除 coffee-landing 和 tea-landing 这两个目录吗？',
          options: [
            { label: '直接彻底删除（推荐）', description: '立即删除这两个目录' },
            { label: '先打个压缩包备份再删' },
            { label: '先移到回收目录再删' },
            { label: '取消，先别删' },
          ],
        },
      ],
    }),
  })
  const html = renderTranscript!({
    ...base,
    sessionId: 'sess-bot',
    segments: [tool('c1', { args: '{"description":"Inspect dirs","command":"ls"}' }), question],
  })
  assert.ok(html.includes('user-question-card'))
  assert.ok(html.includes('data-session="sess-bot"'))
  assert.ok(html.includes('type="button"'))
  assert.ok(html.includes('确认删除'))
  assert.ok(html.includes('确认删除 coffee-landing 和 tea-landing 这两个目录吗？'))
  for (const label of ['直接彻底删除（推荐）', '先打个压缩包备份再删', '先移到回收目录再删', '取消，先别删']) {
    assert.ok(html.includes(label), label)
  }
  assert.ok(html.includes('立即删除这两个目录'))
  assert.equal(html.includes('aria-label="Activity"'), true, 'earlier tools stay in an activity group')
  const cardAt = html.indexOf('user-question-card')
  const inspectAt = html.indexOf('Inspect dirs')
  assert.ok(cardAt > inspectAt, 'the question card stays after the preceding tool')
  assert.ok(!html.includes('Waiting for tool result: ask_user_question'))
  const current = renderCurrent!({ segments: [question], drafting: true, currentTurn: 1 })
  assert.ok(current.includes('Waiting for your answer'))
  assert.ok(!current.includes('Waiting for tool result'))
})

test('SSR: an aborted ask_user_question card can be rebuilt from the tool result', () => {
  const html = renderTranscript!({
    ...base,
    segments: [
      tool('call_10fxzqal', {
        name: 'ask_user_question',
        running: false,
        resultReceived: true,
        error: true,
        errorCode: 'ASK_ABORTED',
        status: 'cancelled',
        result: 'Error: ask_user_question was aborted before the user answered',
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
      }),
    ],
  })
  assert.ok(html.includes('确认删除这两个目录吗？'))
  assert.ok(html.includes('取消，先别删'))
  assert.ok(html.includes('This question was cancelled before you answered.'))
  assert.ok(!html.includes('ask_user_question'))
})

test('SSR: plan-review and approval-intent cards stay interactive and are not generic tool rows', () => {
  const plan = tool('call_plan', {
    name: 'ask_user_question',
    args: JSON.stringify({
      questions: [
        {
          id: 'review',
          question: 'Approve this plan?',
          detail: '# Rollout\nShip the change.',
          intent: { kind: 'plan-review', approve: 'Approve' },
          options: [{ label: 'Approve' }, { label: 'Request changes' }],
        },
      ],
    }),
  })
  const approval = tool('call_app', {
    name: 'ask_user_question',
    args: JSON.stringify({
      questions: [
        {
          id: 'app',
          question: 'Allow Notes to control the computer?',
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
  })
  const html = renderTranscript!({
    ...base,
    sessionId: 'sess-bot',
    segments: [plan, approval],
  })
  assert.ok(html.includes('data-kind="plan-review"'))
  assert.ok(html.includes('data-kind="approval"'))
  assert.ok(html.includes('data-session="sess-bot"'))
  assert.ok(html.includes('type="button"'))
  assert.ok(html.includes('Approve this plan?'))
  assert.ok(html.includes('View full plan') || html.includes('查看完整计划'))
  assert.ok(html.includes('Request changes') || html.includes('请求修改'))
  assert.ok(html.includes('Allow Notes to control the computer?'))
  assert.ok(html.includes('Always allow') || html.includes('始终允许'))
  assert.ok(!html.includes('Waiting for tool result: ask_user_question'))
})

test('SSR: a timed pending ask_user_question result stays interactive', () => {
  const question = tool('call_timed', {
    name: 'ask_user_question',
    running: false,
    resultReceived: true,
    status: 'succeeded',
    args: JSON.stringify({
      timeout: 30,
      questions: [
        {
          id: 'confirm_delete',
          question: 'Delete the directories?',
          options: [{ label: 'Cancel, do not delete' }],
        },
      ],
    }),
    result: JSON.stringify({ pending: true, callId: 'call_timed' }),
  })
  const html = renderTranscript!({
    ...base,
    sessionId: 'sess-bot',
    segments: [question],
  })
  assert.ok(html.includes('user-question-card'))
  assert.ok(html.includes('type="button"'))
  assert.ok(html.includes('Delete the directories?'))
  assert.ok(!html.includes('Answered'))
  const current = renderCurrent!({ segments: [question], drafting: true, currentTurn: 1 })
  assert.ok(current.includes('Waiting for your answer'))
})

test('SSR: a tool-approval card renders interactive controls when a session is present', () => {
  const html = renderApproval!({
    sessionId: 'sess-bot',
    approval: {
      requestId: 'approval-1',
      sessionId: 'sess-bot',
      toolName: 'bash',
      callId: 'call_bash',
      reason: 'Write a file outside the workspace',
      state: 'open',
    },
  })
  assert.ok(html.includes('data-kind="tool-approval"'))
  assert.ok(html.includes('data-session="sess-bot"'))
  assert.ok(html.includes('type="button"'))
  assert.ok(html.includes('bash'))
  assert.ok(html.includes('Write a file outside the workspace'))
  assert.ok(html.includes('Allow once'))
  assert.ok(!html.includes('Always allow'))
  const current = renderCurrent!({
    segments: [],
    drafting: true,
    currentTurn: 1,
    pendingApprovals: [
      {
        requestId: 'approval-1',
        sessionId: 'sess-bot',
        toolName: 'bash',
        reason: 'Write a file',
        state: 'open',
      },
    ],
  })
  assert.ok(current.includes('Waiting for your answer'))
})

test('settings drawer is an overlay, not in-flow under the composer', () => {
  const html = renderSettingsDrawer!({})
  assert.ok(html.includes('settings-drawer-mask'))
  assert.ok(html.includes('role="dialog"'))
  assert.ok(html.includes('aria-modal="true"'))
  assert.ok(html.includes('Permissions'))
  assert.ok(html.includes('drawer body'))
  assert.ok(!html.includes('settings-panel'))
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>') + 7)
  assert.ok(form.includes('1 turns · 1 steps'))
  assert.ok(!form.includes('settings-drawer'))
  assert.ok(!form.includes('aria-modal'))
  assert.ok(!form.includes('role="dialog"'))
})
