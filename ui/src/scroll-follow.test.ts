import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOTTOM_SLOP,
  FOLLOW_GAP,
  createFollowScroll,
  leaveBottom,
  noteScroll,
  pauseFollow,
  smoothFollowTop,
  snapGrowingThread,
} from './scroll-follow.ts'

const view = { clientHeight: 100 }

test('stream growth keeps follow and does not count as scrolling away', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  const grown = noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 700 })
  assert.equal(grown.following, true)
  assert.equal(grown.detached, false)
})

test('an upward scroll releases follow, and returning to the end resumes it', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  const away = noteScroll(state, { ...view, scrollTop: 200, scrollHeight: 500 })
  assert.equal(away.following, false)
  assert.equal(away.detached, true)
  const back = noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  assert.equal(back.following, true)
  assert.equal(back.detached, false)
})

test('scrolling down resumes follow once the tail blank is visible', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  noteScroll(state, { ...view, scrollTop: 100, scrollHeight: 500 })
  const hidden = noteScroll(state, { ...view, scrollTop: 400 - FOLLOW_GAP - 20, scrollHeight: 500 })
  assert.equal(hidden.following, false)
  assert.equal(hidden.detached, true)
  const revealed = noteScroll(state, { ...view, scrollTop: 400 - FOLLOW_GAP, scrollHeight: 500 })
  assert.equal(revealed.following, true)
  assert.equal(revealed.detached, false)
})

test('a small upward nudge releases follow before the next token can pin again', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  const nudged = noteScroll(state, { ...view, scrollTop: 396, scrollHeight: 500 })
  assert.equal(nudged.following, false)
  assert.equal(nudged.detached, false)
})

test('our own stick to the end is not an escape', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 100, scrollHeight: 200 })
  state.programmaticTop = 300
  const landed = noteScroll(state, { ...view, scrollTop: 300, scrollHeight: 400 })
  assert.equal(landed.following, true)
  assert.equal(state.programmaticTop, null)
})

test('shrinking content is not the user scrolling up', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  const shrunk = noteScroll(state, { ...view, scrollTop: 300, scrollHeight: 400 })
  assert.equal(shrunk.following, true)
  assert.equal(shrunk.detached, false)
})

test('a paused reader stays put while later content arrives', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  pauseFollow(state)
  const grown = noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 700 })
  assert.equal(grown.following, false)
  assert.equal(grown.detached, true)
})

test('a short thread that just overflowed snaps to the end instead of easing from the top', () => {
  assert.equal(snapGrowingThread(0, 0), false)
  assert.equal(snapGrowingThread(0, BOTTOM_SLOP), false)
  assert.equal(snapGrowingThread(0, 400), true)
  assert.equal(snapGrowingThread(120, 400), false)
})

test('leaveBottom releases a tall thread and ignores one that cannot scroll', () => {
  const tall = createFollowScroll()
  assert.equal(leaveBottom(tall, { ...view, scrollTop: 400, scrollHeight: 500 }), true)
  assert.equal(tall.following, false)
  const short = createFollowScroll()
  assert.equal(leaveBottom(short, { ...view, scrollTop: 0, scrollHeight: 80 }), false)
  assert.equal(short.following, true)
})

test('follow eases toward the live edge without stepping past it', () => {
  let top = smoothFollowTop(0, 400)
  assert.ok(top > 0 && top < 400)
  let steps = 1
  while (top < 400 && steps < 40) {
    const next = smoothFollowTop(top, 400)
    assert.ok(next > top && next <= 400)
    top = next
    steps += 1
  }
  assert.equal(top, 400)
  assert.ok(steps < 24)
  assert.equal(smoothFollowTop(400, 400), 400)
  assert.equal(smoothFollowTop(420, 400), 400)
})

test('a cancelled smooth scroll arriving at the end does not resume follow', () => {
  const state = createFollowScroll()
  noteScroll(state, { ...view, scrollTop: 100, scrollHeight: 500 })
  state.following = false
  state.suppressRejoin = true
  const landed = noteScroll(state, { ...view, scrollTop: 400, scrollHeight: 500 })
  assert.equal(landed.following, false)
  assert.equal(landed.detached, false)
})
