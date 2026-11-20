import { strict as assert } from 'node:assert'
import test from 'node:test'
import { placeOrphanTurns, turnAnchorSeq } from './transcript-place.ts'

type ChatBlock =
  | { type: 'user'; segment: { id: string; seq: number } }
  | { type: 'card'; segment: { id: string; seq: number } }
  | { type: 'turn'; turn: number; segments: { seq?: number }[] }

test('a timed-out turn sits after its user line and before the next chat line', () => {
  const user = (id: string, seq: number): ChatBlock => ({ type: 'user', segment: { id, seq } })
  const turn = (n: number, seq: number): ChatBlock => ({ type: 'turn', turn: n, segments: [{ seq }] })
  const blocks = [user('q1', 112), user('q2', 146), turn(10, 176), user('q3', 183)]
  const placed = placeOrphanTurns(blocks, [
    { seq: turnAnchorSeq({ seq: 165 }, [{ seq: 149 }]), block: { type: 'turn', turn: 9, segments: [] } },
    { seq: turnAnchorSeq({ seq: 131 }, [{ seq: 114 }]), block: { type: 'turn', turn: 7, segments: [] } },
  ])
  assert.deepEqual(
    placed.map(block => (block.type === 'turn' ? block.turn : block.segment.id)),
    ['q1', 7, 'q2', 9, 10, 'q3'],
  )
})

test('a retry that has not failed yet stays with its user line', () => {
  const blocks: ChatBlock[] = [
    { type: 'user', segment: { id: 'q', seq: 112 } },
    { type: 'user', segment: { id: 'later', seq: 170 } },
  ]
  const placed = placeOrphanTurns(blocks, [
    { seq: turnAnchorSeq(undefined, [{ seq: 114 }, { seq: 127 }]), block: { type: 'turn', turn: 7, segments: [] } },
  ])
  assert.deepEqual(
    placed.map(block => (block.type === 'turn' ? block.turn : block.segment.id)),
    ['q', 7, 'later'],
  )
})

test('a failure with no session seq stays at the end', () => {
  const blocks: ChatBlock[] = [{ type: 'user', segment: { id: 'q', seq: 10 } }]
  const placed = placeOrphanTurns(blocks, [{ block: { type: 'turn', turn: 2, segments: [] } }])
  assert.deepEqual(
    placed.map(block => (block.type === 'turn' ? block.turn : block.segment.id)),
    ['q', 2],
  )
})

test('a card event keeps a failed turn on its own seq', () => {
  const blocks: ChatBlock[] = [
    { type: 'user', segment: { id: 'q', seq: 10 } },
    { type: 'card', segment: { id: 'card', seq: 14 } },
    { type: 'user', segment: { id: 'later', seq: 20 } },
  ]
  const placed = placeOrphanTurns(blocks, [{ seq: 12, block: { type: 'turn', turn: 3, segments: [] } }])
  assert.deepEqual(
    placed.map(block => (block.type === 'user' || block.type === 'card' ? block.segment.id : block.turn)),
    ['q', 3, 'card', 'later'],
  )
})
