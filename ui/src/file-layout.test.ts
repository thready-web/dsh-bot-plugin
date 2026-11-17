import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_MIN, DRAWER_PREF, SIDEBAR_MIN, SIDEBAR_PREF, clampDrawerWidth, filePush } from './file-layout.ts'

test('a drawer that fits in the right blank leaves the centered shell alone', () => {
  const layout = filePush(2000, 300)
  assert.equal(layout.overlap, false)
  assert.equal(layout.reserve, 0)
  assert.equal(layout.sidebar, SIDEBAR_PREF)
  assert.equal(layout.inset, 440)
  assert.equal(layout.insetRight, 440)
})

test('side blanks are consumed before the chat or session list shrink', () => {
  const layout = filePush(2000, 640)
  assert.equal(layout.overlap, false)
  assert.equal(layout.reserve, 640)
  assert.equal(layout.sidebar, SIDEBAR_PREF)
  assert.equal(layout.inset, 240)
  assert.equal(layout.insetRight, 0)
  assert.equal(2000 - layout.inset - layout.insetRight - layout.sidebar - layout.reserve, 1120 - SIDEBAR_PREF)
})

test('after the blanks are gone, chat and session list shrink but stay above their minimums', () => {
  const layout = filePush(1600, 640)
  const chat = 1600 - layout.inset - layout.insetRight - layout.sidebar - layout.reserve
  assert.equal(layout.overlap, false)
  assert.equal(layout.inset, 0)
  assert.equal(layout.reserve, 640)
  assert.ok(layout.sidebar < SIDEBAR_PREF)
  assert.ok(layout.sidebar >= SIDEBAR_MIN)
  assert.ok(chat >= CHAT_MIN)
  assert.ok(chat < 1120 - SIDEBAR_PREF)
})

test('a remembered drawer width stays inside the drag limits', () => {
  assert.equal(clampDrawerWidth(Number.NaN), DRAWER_PREF)
  assert.equal(clampDrawerWidth(100), 320)
  assert.equal(clampDrawerWidth(2000), 960)
  assert.equal(clampDrawerWidth(640.4), 640)
})

test('past the minimums the drawer overlaps instead of squeezing further', () => {
  const layout = filePush(1000, 640)
  const chat = 1000 - layout.sidebar - layout.reserve
  assert.equal(layout.overlap, true)
  assert.equal(layout.sidebar, SIDEBAR_MIN)
  assert.equal(chat, CHAT_MIN)
  assert.ok(layout.drawer > layout.reserve)
})
