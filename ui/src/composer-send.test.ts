import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifySend,
  draftAfterSend,
  enterInsertsNewline,
  isComposingKey,
  MESSAGE_LIMIT,
  nextSendSeq,
} from './composer-send.ts'

test('enter sends on a desktop keyboard and inserts a newline on a phone or a narrow viewport', () => {
  assert.equal(enterInsertsNewline({ coarse: false, narrow: false }), false)
  assert.equal(enterInsertsNewline({ coarse: true, narrow: false }), true)
  assert.equal(enterInsertsNewline({ coarse: false, narrow: true }), true)
})

test('an IME confirmation does not count as send', () => {
  assert.equal(isComposingKey({ isComposing: true, key: 'Enter', keyCode: 13 }), true)
  assert.equal(isComposingKey({ isComposing: false, key: 'Process', keyCode: 229 }), true)
  assert.equal(isComposingKey({ isComposing: false, key: 'Enter', keyCode: 229 }), true)
  assert.equal(isComposingKey({ isComposing: false, key: 'Enter', keyCode: 13 }), false)
})

test('the box clears only when it still holds the sent snapshot', () => {
  assert.equal(draftAfterSend('hello', 'hello'), '')
  assert.equal(draftAfterSend('hello next', 'hello'), 'hello next')
})

test('later sends sort after earlier ones', () => {
  assert.ok(nextSendSeq(4, 1) < nextSendSeq(4, 2))
  assert.equal(nextSendSeq(0, 1), 1)
})

test('a reused accepted key is success, a timeout stays unknown, and a rejection is a failure', () => {
  assert.equal(classifySend({ status: 202 }), 'accepted')
  assert.equal(classifySend({ status: 200, reused: true, taskStatus: 'accepted' }), 'accepted')
  assert.equal(classifySend({ status: 200, reused: true, taskStatus: 'cancelled' }), 'accepted')
  assert.equal(classifySend({ status: 200, reused: true, taskStatus: 'failed' }), 'failed')
  assert.equal(classifySend({ status: 409 }), 'failed')
  assert.equal(classifySend({ status: 502 }), 'failed')
  assert.equal(classifySend({ status: 0, aborted: true }), 'unknown')
  assert.equal(MESSAGE_LIMIT, 8000)
})
