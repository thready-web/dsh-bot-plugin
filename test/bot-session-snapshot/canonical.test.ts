import { strict as assert } from 'node:assert'
import test from 'node:test'
import { eventNdjson, stableStringify } from '../../src/bot-session-snapshot/canonical.ts'
import { event } from './helpers.ts'

test('canonical JSON sorts keys and writes one event per line', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  const { bytes, lines } = eventNdjson([event(0), event(1)])
  const text = bytes.toString('utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.split('\n').filter(Boolean).length, 2)
  assert.equal(lines[0]?.seq, 0)
  assert.equal(lines[1]?.seq, 1)
  assert.equal(text.includes('\n{'), true)
  assert.doesNotThrow(() => JSON.parse(text.split('\n')[0]!))
})
