import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  canvasMessageId,
  placeOrphanTurns,
  resolveApprovals,
  resolveFloatingWorks,
  turnAnchorSeq,
} from './transcript-place.ts'

test('a floating work card stays on the block where it first appeared', () => {
  const pins = new Map<string, string>()
  const first = resolveFloatingWorks([{ id: 't1' }], new Set(), pins, 'turn:1')
  assert.equal(first.get('t1'), 'turn:1')
  const later = resolveFloatingWorks([{ id: 't1' }], new Set(), pins, 'user:new')
  assert.equal(later.get('t1'), 'turn:1')
})

test('a work card that already has a dispatch is not parked on the latest block', () => {
  const pins = new Map<string, string>()
  const placed = resolveFloatingWorks([{ id: 't1' }], new Set(['t1']), pins, 'user:new')
  assert.equal(placed.has('t1'), false)
  assert.equal(pins.size, 0)
})

test('a floating work card does not move onto its dispatch after a later message exists', () => {
  const pins = new Map<string, string>()
  resolveFloatingWorks([{ id: 't1' }], new Set(), pins, 'turn:1')
  const later = resolveFloatingWorks([{ id: 't1' }], new Set(['t1']), pins, 'user:new')
  assert.equal(later.get('t1'), 'turn:1')
})

test('a canvas stays hidden until its dispatch message is loaded', () => {
  assert.equal(canvasMessageId('t1', new Map()), null)
  assert.equal(canvasMessageId(null, new Map([['t1', 'tool:1']])), null)
  assert.equal(canvasMessageId('t1', new Map([['t1', 'tool:1']])), 'tool:1')
})

test('an approval stays on the turn where it first appeared', () => {
  const pins = new Map()
  resolveApprovals([{ requestId: 'a1' }], new Map(), pins, 3)
  const later = resolveApprovals([{ requestId: 'a1', callId: 'c1' }], new Map([['c1', 1]]), pins, 4)
  assert.equal(later.get('a1')?.turn, 3)
  assert.equal(later.get('a1')?.callId, undefined)
})

type ChatBlock =
  | { type: 'user'; segment: { id: string; seq: number } }
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
    placed.map(block => (block.type === 'user' ? block.segment.id : block.turn)),
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
    placed.map(block => (block.type === 'user' ? block.segment.id : block.turn)),
    ['q', 7, 'later'],
  )
})

test('a failure with no session seq stays at the end', () => {
  const blocks: ChatBlock[] = [{ type: 'user', segment: { id: 'q', seq: 10 } }]
  const placed = placeOrphanTurns(blocks, [{ block: { type: 'turn', turn: 2, segments: [] } }])
  assert.deepEqual(
    placed.map(block => (block.type === 'user' ? block.segment.id : block.turn)),
    ['q', 2],
  )
})

test('an approval whose call is already visible stays on that call', () => {
  const pins = new Map()
  const placed = resolveApprovals([{ requestId: 'a1', callId: 'c1' }], new Map([['c1', 2]]), pins, 4)
  assert.deepEqual(placed.get('a1'), { turn: 2, callId: 'c1' })
})
