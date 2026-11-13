import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createImageFailures } from './image-failures.ts'

test('failed-image memory is bounded and stores are isolated to their view', () => {
  const one = createImageFailures(2)
  const other = createImageFailures(2)
  one.fail('a.jpg')
  one.fail('b.jpg')
  one.fail('c.jpg')
  assert.equal(one.has('a.jpg'), false)
  assert.equal(one.has('b.jpg'), true)
  assert.equal(one.has('c.jpg'), true)
  assert.equal(other.has('c.jpg'), false)
  one.fail('x'.repeat(4097))
  assert.equal(one.has('x'.repeat(4097)), false)
})

test('failed-image memory only clears a URL on an explicit retry', () => {
  const cache = createImageFailures()
  let updates = 0
  const unsubscribe = cache.subscribe(() => updates++)
  cache.fail('a.jpg')
  cache.fail('a.jpg')
  assert.equal(updates, 1)
  assert.equal(cache.has('a.jpg'), true)
  cache.retry('a.jpg')
  assert.equal(cache.has('a.jpg'), false)
  assert.equal(updates, 2)
  unsubscribe()
  cache.fail('b.jpg')
  assert.equal(updates, 2)
})
