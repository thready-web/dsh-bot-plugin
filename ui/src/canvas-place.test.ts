import { strict as assert } from 'node:assert'
import test from 'node:test'
import { placeCanvases, type CanvasPlaceItem } from './canvas-place.ts'

const canvas = (patch: Partial<CanvasPlaceItem> & Pick<CanvasPlaceItem, 'id'>): CanvasPlaceItem => ({
  title: patch.id,
  ticketId: null,
  previewRevision: 1,
  stableRevision: null,
  ...patch,
})

test('an unfinished canvas stays hidden and a delivered one stays on its ticket', () => {
  const older = canvas({ id: 'old', ticketId: 't-old', previewRevision: 2 })
  const running = canvas({ id: 'new', ticketId: 't-new', previewRevision: 1 })
  const placed = placeCanvases(
    [older, running],
    [
      { id: 't-new', status: 'started' },
      { id: 't-old', status: 'delivered' },
    ],
  )
  assert.equal(placed.byTicket.get('t-old')?.id, 'old')
  assert.equal(placed.byTicket.has('t-new'), false)
  assert.equal(placed.loose.length, 0)
})

test('the newest delivery stays on its own ticket instead of leaving the transcript tail', () => {
  const older = canvas({ id: 'old', ticketId: 't-old' })
  const newer = canvas({ id: 'new', ticketId: 't-new', previewRevision: 3, stableRevision: 3 })
  const placed = placeCanvases(
    [older, newer],
    [
      { id: 't-new', status: 'delivered' },
      { id: 't-old', status: 'delivered' },
    ],
  )
  assert.equal(placed.byTicket.get('t-new')?.id, 'new')
  assert.equal(placed.byTicket.get('t-old')?.id, 'old')
  assert.equal(placed.loose.length, 0)
})

test('a published canvas with no loaded ticket still counts as delivered', () => {
  const placed = placeCanvases([canvas({ id: 'kept', ticketId: 'gone' })], [])
  assert.equal(placed.byTicket.get('gone')?.id, 'kept')
})

test('a delivered canvas with no ticket is loose instead of floating after later messages', () => {
  const placed = placeCanvases([canvas({ id: 'bare', ticketId: null })], [])
  assert.equal(placed.byTicket.size, 0)
  assert.equal(placed.loose[0]?.id, 'bare')
})
