import { strict as assert } from 'node:assert'
import test from 'node:test'
import { canvasFrameBox } from './canvas-fit.ts'

const desktop = { width: 1280, height: 860 }
const phone = { width: 390, height: 844 }

test('fit shrinks a desktop canvas to the phone stage without changing its layout width', () => {
  const box = canvasFrameBox({ width: 366, height: 600 }, desktop, true, 16)
  assert.equal(box.frameWidth, 1280)
  assert.equal(box.frameHeight, 860)
  assert.equal(box.scale, 350 / 1280)
  assert.equal(box.boxWidth, 350)
  assert.equal(box.boxHeight, 860 * (350 / 1280))
})

test('a phone viewport on a phone stage stays close to 1:1', () => {
  const box = canvasFrameBox({ width: 390, height: 844 }, phone, true, 8)
  assert.equal(box.scale, 382 / 390)
  assert.equal(box.frameHeight, 844)
})

test('fit never grows a canvas past its device size', () => {
  const box = canvasFrameBox({ width: 1600, height: 1200 }, desktop, true, 16)
  assert.equal(box.scale, 1)
  assert.equal(box.boxWidth, 1280)
  assert.equal(box.boxHeight, 860)
})

test('actual size fills the stage height and keeps the device width for panning', () => {
  const box = canvasFrameBox({ width: 366, height: 600 }, desktop, false, 16)
  assert.equal(box.scale, 1)
  assert.equal(box.frameWidth, 1280)
  assert.equal(box.frameHeight, 600)
  assert.equal(box.boxWidth, 1280)
  assert.equal(box.boxHeight, 600)
})

test('an unmeasured stage keeps the device box instead of collapsing', () => {
  const box = canvasFrameBox({ width: 0, height: 0 }, desktop, false, 16)
  assert.equal(box.scale, 1)
  assert.equal(box.frameHeight, 860)
})
