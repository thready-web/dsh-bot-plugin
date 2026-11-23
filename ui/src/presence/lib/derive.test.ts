import assert from 'node:assert/strict'
import test from 'node:test'
import { avatarIdFor } from './catalog.ts'
import { completionActive, derivePresence, nextSettledAt } from './derive.ts'
import { DONE_WINDOW_MS, type PresenceSource, type PresenceThread } from './types.ts'

function source(patch: Partial<PresenceSource> = {}): PresenceSource {
  return { sessionId: 's1', ...patch }
}

function thread(patch: Partial<PresenceThread> = {}): PresenceThread {
  return {
    drafting: false,
    turn: 1,
    failures: {},
    turnEnds: {},
    segments: [],
    ...patch,
  }
}

test('priority stops at the first matching fact', () => {
  const now = 10_000
  const blocked = source({
    thread: thread({
      drafting: true,
      failures: { 1: { message: 'nope', code: 'E' } },
      segments: [{ kind: 'tool', name: 'bash', running: true }],
    }),
    approvals: [{ state: 'open' }],
    ticket: { status: 'started' },
  })
  assert.equal(derivePresence(blocked, now).state, 'blocked')

  const waiting = source({
    approvals: [{ state: 'open' }],
    thread: thread({ drafting: true, segments: [{ kind: 'tool', name: 'bash', running: true }] }),
    ticket: { status: 'started' },
  })
  assert.equal(derivePresence(waiting, now).state, 'waiting')

  const working = source({
    ticket: { status: 'started' },
    thread: thread({ drafting: true }),
  })
  assert.equal(derivePresence(working, now).state, 'working')

  const thinking = source({ thread: thread({ drafting: true }) })
  assert.equal(derivePresence(thinking, now).state, 'thinking')
})

test('a bare abort is idle, and grant or hook aborts are blocked', () => {
  assert.equal(derivePresence(source({ thread: thread({ turnEnds: { 1: 'aborted' } }) })).state, 'idle')
  assert.equal(
    derivePresence(source({ thread: thread({ turnEnds: { 1: 'aborted' }, abortCause: 'grant-denied' }) })).state,
    'blocked',
  )
  assert.equal(
    derivePresence(source({ thread: thread({ turnEnds: { 1: 'aborted' }, abortCause: 'hook' }) })).state,
    'blocked',
  )
})

test('ticket failure blocks, and a waiting question does not become working', () => {
  assert.equal(derivePresence(source({ ticket: { status: 'failed' } })).state, 'blocked')
  assert.equal(
    derivePresence(
      source({
        thread: thread({
          segments: [{ kind: 'tool', name: 'ask_user_question', running: true, status: 'waiting' }],
        }),
      }),
    ).state,
    'waiting',
  )
  assert.equal(
    derivePresence(
      source({
        thread: thread({
          segments: [{ kind: 'tool', name: 'ask_user_question', running: false, result: 'ok', status: 'succeeded' }],
        }),
      }),
    ).state,
    'idle',
  )
})

test('streaming text is thinking, and a running tool is working', () => {
  assert.equal(
    derivePresence(source({ thread: thread({ segments: [{ kind: 'assistant', streaming: true }] }) })).state,
    'thinking',
  )
  assert.equal(
    derivePresence(source({ thread: thread({ segments: [{ kind: 'think', running: true }] }) })).state,
    'thinking',
  )
  assert.equal(
    derivePresence(source({ thread: thread({ segments: [{ kind: 'tool', name: 'bash', running: true }] }) })).state,
    'working',
  )
})

test('done lasts four seconds after a recorded completion and then idles', () => {
  const completed = source({
    thread: thread({ turnEnds: { 1: 'completed' } }),
    settledAt: 1_000,
  })
  assert.equal(derivePresence(completed, 1_000).state, 'done')
  assert.equal(derivePresence(completed, 1_000 + DONE_WINDOW_MS - 1).state, 'done')
  assert.equal(derivePresence(completed, 1_000 + DONE_WINDOW_MS).state, 'idle')
  assert.equal(derivePresence(source({ thread: thread({ turnEnds: { 1: 'completed' } }) }), 5_000).state, 'idle')
  assert.equal(completionActive(source({ thread: thread({ turnEnds: { 1: 'completed' } }) })), true)
  assert.equal(completionActive(source({ thread: thread({ drafting: true, turnEnds: { 1: 'completed' } }) })), false)
})

test('mood stays neutral and the definition id is stable', () => {
  const view = derivePresence(source())
  assert.equal(view.mood, 'neutral')
  assert.equal(view.label, '')
  assert.equal(view.definitionId, avatarIdFor('s1'))
  assert.equal(avatarIdFor('s1'), avatarIdFor('s1'))
})

test('the completion stamp starts once and clears when the fact ends', () => {
  const started = nextSettledAt(null, 's1', true, 50)
  assert.equal(started.at, 50)
  const held = nextSettledAt(started, 's1', true, 80)
  assert.equal(held.at, 50)
  const cleared = nextSettledAt(held, 's1', false, 90)
  assert.equal(cleared.at, undefined)
  const switched = nextSettledAt(held, 's2', true, 100)
  assert.equal(switched.at, 100)
})
