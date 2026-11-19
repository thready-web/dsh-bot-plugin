import assert from 'node:assert/strict'
import test from 'node:test'
import { chrome } from './i18n/chrome.ts'
import {
  CHAT_MIN,
  DRAWER_PREF,
  SIDEBAR_MIN,
  SIDEBAR_PREF,
  clampDrawerWidth,
  filePush,
  initialFileLocation,
} from './file-layout.ts'

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

test('the drawer opens the workspace and does not select a closed home', () => {
  assert.deepEqual(
    initialFileLocation({
      workspace: '/opt/dsh-bot/data/workspace',
      home: null,
      workspaceReason: '',
    }),
    { kind: 'path', root: 'workspace', path: '/opt/dsh-bot/data/workspace' },
  )
  assert.deepEqual(initialFileLocation({ workspace: null, home: '/opt/dsh-bot/files', workspaceReason: 'missing' }), {
    kind: 'path',
    root: 'home',
    path: '/opt/dsh-bot/files',
  })
  assert.deepEqual(initialFileLocation({ workspace: null, home: '/opt/dsh-bot/files', workspaceReason: 'overlap' }), {
    kind: 'path',
    root: 'home',
    path: '/opt/dsh-bot/files',
  })
  assert.deepEqual(initialFileLocation({ workspace: null, home: null, workspaceReason: 'overlap' }), {
    kind: 'unavailable',
    notice: 'files.overlap',
  })
  const closed = initialFileLocation({ workspace: null, home: null, workspaceReason: 'forbidden' })
  assert.deepEqual(closed, { kind: 'unavailable', notice: 'files.denied' })
  assert.equal(chrome.en['files.denied'], 'This location is not available.')
  assert.equal(initialFileLocation({ workspace: null, home: null, workspaceReason: 'missing' }).kind, 'unavailable')
})

test('past the minimums the drawer overlaps instead of squeezing further', () => {
  const layout = filePush(1000, 640)
  const chat = 1000 - layout.sidebar - layout.reserve
  assert.equal(layout.overlap, true)
  assert.equal(layout.sidebar, SIDEBAR_MIN)
  assert.equal(chat, CHAT_MIN)
  assert.ok(layout.drawer > layout.reserve)
})
