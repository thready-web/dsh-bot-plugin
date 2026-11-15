import { strict as assert } from 'node:assert'
import test from 'node:test'

/**
 * Simulated main-bot loop. A user message that arrives while a step is still
 * producing its reply is steered into the next step of the same turn.
 * The in-flight step runs to completion and keeps its assistant message.
 * This follows the host inbox: `steer` appends to next-step and does not abort.
 */

type UserInput = { id: string; text: string }

type Admitted =
  | { kind: 'user'; id: string; text: string; turn: number; step: number }
  | { kind: 'assistant'; text: string; turn: number; step: number }
  | { kind: 'tool'; name: string; text: string; turn: number; step: number }

type LoopEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'turn/end'; turn: number; reason: 'completed' }
  | { type: 'step/start'; turn: number; step: number }
  | { type: 'step/end'; turn: number; step: number }
  | { type: 'agent/inbox/claimed'; id: string; turn: number; step: number }

type StepReply = { kind: 'text'; text: string } | { kind: 'tool'; name: string; result: string }

type StepView = {
  turn: number
  step: number
  /** Surface already admitted, including this step's claimed user messages. */
  history: readonly Admitted[]
  /** User messages claimed for this step only. Later arrivals are not here. */
  claimed: readonly UserInput[]
  steer: (input: UserInput) => void
}

type Model = (view: StepView) => StepReply | Promise<StepReply>

type EndReason = { kind: 'completed' } | null

function createMainLoop(model: Model) {
  const nextStep: UserInput[] = []
  const nextTurn: UserInput[] = []
  const history: Admitted[] = []
  const events: LoopEvent[] = []
  let phase: 'idle' | 'running' = 'idle'
  let lastTurn = 0
  let activity: Promise<void> = Promise.resolve()

  function steer(input: UserInput) {
    nextStep.push(input)
    if (phase === 'idle') wake()
  }

  function followup(input: UserInput) {
    nextTurn.push(input)
    if (phase === 'idle') wake()
  }

  function wake() {
    if (phase !== 'idle') return
    phase = 'running'
    activity = kick().finally(() => {
      phase = 'idle'
    })
  }

  async function kick() {
    while (await turn()) {
      /* another queued turn in the same driver */
    }
  }

  function claim(target: 'next-turn' | 'next-step', turn: number, step: number) {
    const claimed = nextStep.splice(0)
    if (target === 'next-turn') {
      const queued = nextTurn.shift()
      if (queued) claimed.push(queued)
    }
    for (const message of claimed) events.push({ type: 'agent/inbox/claimed', id: message.id, turn, step })
    return claimed
  }

  async function runStep(claimed: UserInput[], turn: number, step: number): Promise<EndReason> {
    for (const message of claimed) history.push({ kind: 'user', id: message.id, text: message.text, turn, step })
    const reply = await model({
      turn,
      step,
      history: history.slice(),
      claimed: claimed.slice(),
      steer,
    })
    if (reply.kind === 'tool') {
      history.push({ kind: 'assistant', text: reply.name, turn, step })
      history.push({ kind: 'tool', name: reply.name, text: reply.result, turn, step })
      return null
    }
    history.push({ kind: 'assistant', text: reply.text, turn, step })
    return { kind: 'completed' }
  }

  async function turn() {
    const turnNumber = lastTurn + 1
    events.push({ type: 'turn/start', turn: turnNumber })
    let stepNumber = 0
    let turnEnds: EndReason = null
    let target: 'next-turn' | 'next-step' = 'next-turn'
    try {
      while (true) {
        const step = stepNumber + 1
        const claimed = claim(target, turnNumber, step)
        if (turnEnds && claimed.length === 0) break
        if (stepNumber === 0 && claimed.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        events.push({ type: 'step/start', turn: turnNumber, step })
        stepNumber = step
        const stepEnd = await runStep(claimed, turnNumber, step)
        events.push({ type: 'step/end', turn: turnNumber, step })
        turnEnds = stepEnd
        if (turnEnds && nextStep.length === 0) break
        target = 'next-step'
      }
    } finally {
      events.push({ type: 'turn/end', turn: turnNumber, reason: 'completed' })
      lastTurn = turnNumber
    }
    return nextStep.length > 0 || nextTurn.length > 0
  }

  return {
    events,
    history,
    followup,
    steer,
    whenIdle: () => activity,
  }
}

function surface(history: readonly Admitted[]) {
  return history.map(item => {
    if (item.kind === 'tool') return `tool:${item.name}:${item.text}`
    if (item.kind === 'assistant') return `assistant:${item.text}`
    return `user:${item.text}`
  })
}

test('a message sent during a reply is inserted on the next step of the same turn', async () => {
  const seen: Array<{ step: number; claimed: string[] }> = []
  const loop = createMainLoop(view => {
    seen.push({ step: view.step, claimed: view.claimed.map(message => message.text) })
    if (view.step === 1) {
      view.steer({ id: 'B', text: 'message B' })
      return { kind: 'text', text: 'reply to A' }
    }
    const users = view.history.filter(item => item.kind === 'user').map(item => item.text)
    assert.deepEqual(users, ['message A', 'message B'])
    assert.equal(
      view.history.some(item => item.kind === 'assistant' && item.text === 'reply to A' && item.step === 1),
      true,
    )
    assert.equal(view.turn, 1)
    return { kind: 'text', text: 'reply to A and B' }
  })

  loop.followup({ id: 'A', text: 'message A' })
  await loop.whenIdle()

  assert.deepEqual(seen, [
    { step: 1, claimed: ['message A'] },
    { step: 2, claimed: ['message B'] },
  ])
  assert.deepEqual(
    loop.events.filter(event => event.type === 'turn/start').map(event => event.turn),
    [1],
  )
  assert.deepEqual(
    loop.events.filter(event => event.type === 'turn/end'),
    [{ type: 'turn/end', turn: 1, reason: 'completed' }],
  )
  const claimedB = loop.events.find(event => event.type === 'agent/inbox/claimed' && event.id === 'B')
  assert.deepEqual(claimedB, { type: 'agent/inbox/claimed', id: 'B', turn: 1, step: 2 })
  assert.deepEqual(surface(loop.history), [
    'user:message A',
    'assistant:reply to A',
    'user:message B',
    'assistant:reply to A and B',
  ])
  const replyA = loop.history.findIndex(item => item.kind === 'assistant' && item.text === 'reply to A')
  const messageB = loop.history.findIndex(item => item.kind === 'user' && item.id === 'B')
  assert.equal(replyA < messageB, true)
})

test('two messages that arrive during one step are claimed together on the next step', async () => {
  const loop = createMainLoop(view => {
    if (view.step === 1) {
      view.steer({ id: 'B', text: 'message B' })
      view.steer({ id: 'C', text: 'message C' })
      return { kind: 'text', text: 'reply to A' }
    }
    assert.deepEqual(
      view.claimed.map(message => message.text),
      ['message B', 'message C'],
    )
    assert.equal(view.turn, 1)
    return { kind: 'text', text: 'reply to A, B, and C' }
  })

  loop.followup({ id: 'A', text: 'message A' })
  await loop.whenIdle()

  assert.deepEqual(
    loop.events.filter(event => event.type === 'agent/inbox/claimed').map(event => event.id),
    ['A', 'B', 'C'],
  )
  assert.equal(loop.events.filter(event => event.type === 'turn/end').length, 1)
})

test('a tool step keeps its result when the next topic arrives, and the same turn continues', async () => {
  const loop = createMainLoop(view => {
    if (view.step === 1) {
      view.steer({ id: 'B', text: 'message B' })
      return { kind: 'tool', name: 'lookup', result: 'fact about A' }
    }
    assert.equal(
      view.history.some(item => item.kind === 'tool' && item.name === 'lookup' && item.text === 'fact about A'),
      true,
    )
    assert.deepEqual(
      view.claimed.map(message => message.text),
      ['message B'],
    )
    assert.equal(view.turn, 1)
    return { kind: 'text', text: 'A is done, and here is B' }
  })

  loop.followup({ id: 'A', text: 'message A' })
  await loop.whenIdle()

  assert.deepEqual(surface(loop.history), [
    'user:message A',
    'assistant:lookup',
    'tool:lookup:fact about A',
    'user:message B',
    'assistant:A is done, and here is B',
  ])
  assert.deepEqual(
    loop.events.filter(event => event.type === 'step/start').map(event => [event.turn, event.step]),
    [
      [1, 1],
      [1, 2],
    ],
  )
})
