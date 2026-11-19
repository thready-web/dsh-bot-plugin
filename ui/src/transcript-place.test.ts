import { strict as assert } from 'node:assert'
import test from 'node:test'
import { resolveApprovals, resolveFloatingWorks, resolveLooseCanvases } from './transcript-place.ts'

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

test('a canvas with a visible ticket stays on that ticket', () => {
  const pins = new Map<string, string>()
  const placed = resolveLooseCanvases([{ id: 'c1', ticketId: 't1' }], new Set(['t1']), pins, 'user:new')
  assert.equal(placed.has('c1'), false)
  assert.equal(pins.size, 0)
})

test('a canvas without a home stays on the block where it appeared', () => {
  const pins = new Map<string, string>()
  const first = resolveLooseCanvases([{ id: 'c1', ticketId: null }], new Set(), pins, 'turn:2')
  assert.equal(first.get('c1'), 'turn:2')
  const coveredLater = resolveLooseCanvases([{ id: 'c1', ticketId: 't1' }], new Set(['t1']), pins, 'user:new')
  assert.equal(coveredLater.get('c1'), 'turn:2')
})

test('an approval stays on the turn where it first appeared', () => {
  const pins = new Map()
  resolveApprovals([{ requestId: 'a1' }], new Map(), pins, 3)
  const later = resolveApprovals([{ requestId: 'a1', callId: 'c1' }], new Map([['c1', 1]]), pins, 4)
  assert.equal(later.get('a1')?.turn, 3)
  assert.equal(later.get('a1')?.callId, undefined)
})

test('an approval whose call is already visible stays on that call', () => {
  const pins = new Map()
  const placed = resolveApprovals([{ requestId: 'a1', callId: 'c1' }], new Map([['c1', 2]]), pins, 4)
  assert.deepEqual(placed.get('a1'), { turn: 2, callId: 'c1' })
})
