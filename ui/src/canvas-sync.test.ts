import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  applyCanvasRevision,
  emptyCanvasCache,
  nextFrameSrc,
  sha256Prefixed,
  transferPlan,
  type CanvasRevisionDocument,
} from './canvas-sync.ts'

const html = new TextEncoder().encode('<p>one</p>')
const css = new TextEncoder().encode('body{}')
const cssNext = new TextEncoder().encode('body{color:#111}')

async function item(path: string, type: string, bytes: Uint8Array) {
  return { path, hash: await sha256Prefixed(bytes), bytes: bytes.byteLength, type }
}

async function document(
  kind: 'snapshot' | 'delta',
  revision: number,
  baseRevision: number | null,
  cssBytes: Uint8Array,
): Promise<CanvasRevisionDocument> {
  return {
    kind,
    revision,
    baseRevision,
    entry: 'index.html',
    manifest: [await item('index.html', 'text/html', html), await item('styles.css', 'text/css', cssBytes)],
  }
}

test('canvas hash prefix matches the server digest', async () => {
  const bytes = new TextEncoder().encode('hello')
  const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  assert.equal(await sha256Prefixed(bytes), expected)
})

test('a gap or missing base fetches the whole snapshot and a failed file keeps the old revision', async () => {
  const cache = emptyCanvasCache()
  const first = await document('snapshot', 1, null, css)
  assert.deepEqual(transferPlan(cache, first), { mode: 'snapshot', paths: ['index.html', 'styles.css'] })
  let calls = 0
  const failed = await applyCanvasRevision(cache, first, async () => {
    calls += 1
    if (calls === 2) throw new Error('dropped')
    return html
  })
  assert.equal(failed.ok, false)
  if (failed.ok !== false) return
  assert.equal(failed.cache, cache)
  assert.equal(cache.revision, null)
  assert.equal(nextFrameSrc('/old', { ok: false }), '/old')

  const loaded = await applyCanvasRevision(cache, first, async path => (path === 'styles.css' ? css : html))
  assert.equal(loaded.ok, true)
  if (loaded.ok !== true) return
  assert.equal(loaded.cache.revision, 1)
  const mismatch = await document('delta', 2, 1, cssNext)
  mismatch.manifest[1]!.hash = 'sha256:' + 'ab'.repeat(32)
  const rejected = await applyCanvasRevision(loaded.cache, mismatch, async path =>
    path === 'styles.css' ? cssNext : html,
  )
  assert.equal(rejected.ok, false)
  if (rejected.ok !== false) return
  assert.equal(rejected.cache, loaded.cache)
  assert.equal(loaded.cache.revision, 1)
  assert.equal(nextFrameSrc('/rev/1/index.html', { ok: false }), '/rev/1/index.html')

  const gap = await document('delta', 4, 2, cssNext)
  assert.equal(transferPlan(loaded.cache, gap).mode, 'snapshot')
  assert.deepEqual(transferPlan(loaded.cache, gap).paths, ['index.html', 'styles.css'])
  const next = await document('delta', 2, 1, cssNext)
  assert.deepEqual(transferPlan(loaded.cache, next), { mode: 'delta', paths: ['styles.css'] })
  const applied = await applyCanvasRevision(loaded.cache, next, async () => cssNext)
  assert.equal(applied.ok, true)
  if (applied.ok !== true) return
  assert.equal(applied.cache.revision, 2)
  assert.equal(applied.cache.files.get('index.html')?.hash, loaded.cache.files.get('index.html')?.hash)
  assert.equal(nextFrameSrc('/rev/1/index.html', { ok: true, src: '/rev/2/index.html' }), '/rev/2/index.html')
})
