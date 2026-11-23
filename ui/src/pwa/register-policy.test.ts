import assert from 'node:assert/strict'
import test from 'node:test'
import { pwaDisabledByQuery } from './register-policy.ts'

test('the debug kill-switch turns the shell off', () => {
  assert.equal(pwaDisabledByQuery('?pwa=0'), true)
  assert.equal(pwaDisabledByQuery('?pwa=off'), true)
  assert.equal(pwaDisabledByQuery('?pwa=false'), true)
})

test('an ordinary or unrelated query keeps the shell on', () => {
  assert.equal(pwaDisabledByQuery(''), false)
  assert.equal(pwaDisabledByQuery('?pwa=1'), false)
  assert.equal(pwaDisabledByQuery('?pwa=yes'), false)
  assert.equal(pwaDisabledByQuery('?x=1&pwa=00'), false)
})
