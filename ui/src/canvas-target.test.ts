import { strict as assert } from 'node:assert'
import test from 'node:test'
import { formatCanvasTarget, mentionLabel, splitCanvasMessage } from './canvas-target.ts'

test('a canvas mention survives a round trip and leaves the typed text', () => {
  const block = formatCanvasTarget({
    canvasId: 'cnv_abcdefghijklmnop',
    revision: 4,
    path: '0:header/1:h1',
    tag: 'h1',
    label: 'h1 · Quiet reading',
  })
  const split = splitCanvasMessage(`Make the title larger\n\n${block}`)
  assert.equal(split.text, 'Make the title larger')
  assert.equal(split.chips.length, 1)
  assert.equal(split.chips[0]?.path, '0:header/1:h1')
  assert.equal(split.chips[0]?.label, 'h1 · Quiet reading')
  assert.equal(split.chips[0]?.revision, 4)
})

test('a mention names the canvas card and the revision inside it', () => {
  const label = mentionLabel('用户反馈：当前 canvas 产物的 padding', '版本 1', 'h1', '两套视觉语言，一套编辑方法。')
  assert.match(label, /^用户反馈：当前 canvas 产物的… · 版本 1 · h1 · /)
  assert.equal(label.includes('cnv_'), false)
  assert.ok(label.endsWith('…'))
})

test('the body path is encoded without looking like a missing field', () => {
  const block = formatCanvasTarget({
    canvasId: 'cnv_abcdefghijklmnop',
    revision: 1,
    path: '',
    tag: 'body',
    label: 'body',
  })
  assert.match(block, /path=\./)
  assert.equal(splitCanvasMessage(block).chips[0]?.path, '')
})
