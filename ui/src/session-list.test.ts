import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySessionListFailure } from './session-list.ts'

test('a real envelope is not a failure', () => {
  assert.equal(classifySessionListFailure(200, true), 'none')
})

test('an unauthenticated list asks for a sign-in', () => {
  assert.equal(classifySessionListFailure(401, false), 'signin')
  assert.equal(classifySessionListFailure(403, false), 'signin')
})

test('a 200 sign-in page is a sign-in problem, not an empty account', () => {
  assert.equal(classifySessionListFailure(200, false), 'signin')
})

test('server and transport failures stay generic', () => {
  assert.equal(classifySessionListFailure(500, false), 'unavailable')
  assert.equal(classifySessionListFailure(502, false), 'unavailable')
  assert.equal(classifySessionListFailure(0, false), 'unavailable')
})
