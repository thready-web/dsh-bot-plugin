import assert from 'node:assert/strict'
import test from 'node:test'
import {
  planReveal,
  REVEAL_DRAIN_MS,
  REVEAL_IMMEDIATE_GRAPHEMES,
  REVEAL_QUICK_MS,
  type RevealState,
} from './smooth-text.ts'

const live = { active: true, reduced: false, frameMs: 16 }
const idle: RevealState = { shown: null, step: 0 }

function paint(state: RevealState, target: string, now: number) {
  return planReveal(state, target, { ...live, now })
}

test('the first observation, a settled string, and reduced motion snap to the target', () => {
  const target = 'a'.repeat(400)
  const first = planReveal(idle, target, { ...live, now: 0 })
  assert.deepEqual(first, { shown: target, step: 0, done: true })

  const settled = planReveal({ shown: 'partial', step: 4 }, target, {
    active: false,
    reduced: false,
    now: 0,
  })
  assert.deepEqual(settled, { shown: target, step: 0, done: true })

  const reduced = planReveal({ shown: '', step: 0 }, target, { active: true, reduced: true, now: 0 })
  assert.deepEqual(reduced, { shown: target, step: 0, done: true })
})

test('a rewrite that is not an extension snaps instead of revealing a suffix', () => {
  const next = planReveal({ shown: 'hello', step: 4 }, 'goodbye', { ...live, now: 40 })
  assert.deepEqual(next, { shown: 'goodbye', step: 0, done: true })
})

test('one new grapheme shows on this frame, and a short append glides', () => {
  const one = planReveal({ shown: 'a', step: 0 }, 'ab', { ...live, now: 0 })
  assert.deepEqual(one, { shown: 'ab', step: 0, done: true })

  const prefix = 'ready '
  const target = prefix + 'a'.repeat(REVEAL_IMMEDIATE_GRAPHEMES)
  const first = planReveal({ shown: prefix, step: 0 }, target, { ...live, now: 0 })
  assert.equal(first.done, false)
  assert.ok(first.shown.length > prefix.length && first.shown.length < target.length)

  let state: RevealState = { shown: first.shown, step: first.step }
  let finishedAt: number | null = null
  for (let now = 16; now <= REVEAL_QUICK_MS; now += 16) {
    const next = paint(state, target, now)
    assert.ok(target.startsWith(next.shown))
    state = { shown: next.shown, step: next.step }
    if (next.done) {
      finishedAt = now
      break
    }
  }
  assert.equal(state.shown, target)
  assert.ok(finishedAt != null && finishedAt <= REVEAL_QUICK_MS)
})

test('a replay-sized burst finishes inside one coarse tick instead of popping in', () => {
  const prefix = '已经交'
  const target = `${prefix}给 worker `
  const first = planReveal({ shown: prefix, step: 0 }, target, { ...live, now: 0 })
  assert.equal(first.done, false)
  assert.ok(first.shown.length < target.length)

  let state: RevealState = { shown: first.shown, step: first.step }
  let finishedAt: number | null = null
  for (let now = 16; now <= REVEAL_QUICK_MS; now += 16) {
    const next = paint(state, target, now)
    state = { shown: next.shown, step: next.step }
    if (next.done) {
      finishedAt = now
      break
    }
  }
  assert.equal(state.shown, target)
  assert.equal(state.step, 0)
  assert.ok(finishedAt != null && finishedAt <= REVEAL_QUICK_MS)
})

test('a burst finishes inside the drain window without passing the target', () => {
  const prefix = 'seen '
  const target = prefix + 'c'.repeat(1000)
  let state: RevealState = { shown: prefix, step: 0 }
  let finishedAt: number | null = null
  for (let now = 0; now <= REVEAL_DRAIN_MS + 16; now += 16) {
    const next = paint(state, target, now)
    assert.ok(target.startsWith(next.shown))
    assert.ok(next.shown.length >= (state.shown?.length ?? 0))
    state = { shown: next.shown, step: next.step }
    if (next.done) {
      finishedAt = now
      break
    }
  }
  assert.equal(state.shown, target)
  assert.ok(finishedAt != null && finishedAt <= REVEAL_DRAIN_MS)
  assert.equal(state.step, 0)
})

test('text that arrives during a catch-up speeds up without skipping to the end', () => {
  let target = 'd'.repeat(300)
  let state: RevealState = { shown: '', step: 0 }
  let grewAt: number | null = null
  let finishedAt: number | null = null
  for (let now = 0; now <= REVEAL_DRAIN_MS * 2; now += 16) {
    if (now === 48) target = 'd'.repeat(900)
    const before = state.step
    const next = paint(state, target, now)
    if (now === 48) {
      grewAt = now
      assert.equal(next.done, false)
      assert.ok(next.shown.length < target.length)
      assert.ok(next.step > before)
    }
    assert.ok(target.startsWith(next.shown))
    state = { shown: next.shown, step: next.step }
    if (next.done && next.shown === target) {
      finishedAt = now
      break
    }
  }
  assert.equal(state.shown, target)
  assert.ok(grewAt != null && finishedAt != null && finishedAt - grewAt <= REVEAL_DRAIN_MS)
})

test('slices stay on grapheme boundaries', () => {
  const emoji = '😀'
  const icons = emoji.repeat(REVEAL_IMMEDIATE_GRAPHEMES + 1)
  const first = planReveal({ shown: '', step: 0 }, icons, { ...live, now: 0 })
  assert.equal(first.done, false)
  assert.equal(first.shown, emoji.repeat(2))
  assert.equal(Array.from(first.shown).length, 2)

  const words = '你'.repeat(REVEAL_IMMEDIATE_GRAPHEMES + 1)
  const cjk = planReveal({ shown: '', step: 0 }, words, { ...live, now: 0 })
  assert.equal(cjk.shown, '你'.repeat(2))

  const family = '👨‍👩‍👧‍👦'
  const crowded = family.repeat(REVEAL_IMMEDIATE_GRAPHEMES + 1)
  const cluster = planReveal({ shown: '', step: 0 }, crowded, { ...live, now: 0 })
  assert.equal(cluster.shown, family.repeat(2))
})
