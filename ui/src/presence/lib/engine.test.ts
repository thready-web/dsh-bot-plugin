import assert from 'node:assert/strict'
import test from 'node:test'
import { AVATAR_IDS } from './catalog.ts'
import { renderStill } from './engine.ts'

test('each built-in example renders a static svg', async () => {
  for (const id of AVATAR_IDS) {
    const svg = await renderStill({ sessionId: id, state: 'idle', definitionId: id, color: '#e23d8a' })
    assert.equal(svg?.startsWith('<svg'), true, id)
    assert.equal(svg?.includes('<script'), false, id)
    assert.equal(svg?.includes('fill="#ffffff"'), true, id)
  }
})

test('an unknown definition does not return markup', async () => {
  assert.equal(await renderStill({ sessionId: 'x', state: 'idle', definitionId: 'not-a-real-avatar' }), null)
})
