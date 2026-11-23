import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('the host mock advertises reasoning effort off', () => {
  const source = readFileSync(new URL('../fixtures/mock-llm.mjs', import.meta.url), 'utf8')
  assert.match(source, /export const mockReasoning = \{[\s\S]*id: 'off'[\s\S]*defaultEffort: 'off'/)
  assert.equal((source.match(/reasoning: mockReasoning/g) ?? []).length, 2)
})
