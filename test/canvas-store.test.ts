import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CANVAS_MAX_FILE_BYTES,
  CANVAS_MAX_PACKAGE_BYTES,
  openCanvasStore,
  type CanvasFileInput,
} from '../src/canvas-store.ts'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'
import { toolDefinitions } from '../src/tools.ts'

const html = '<!doctype html><link rel="stylesheet" href="styles.css"><img src="hero.png" alt=""></html>'
const css = 'body{color:#111}'
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')

function files(cssText = css): CanvasFileInput[] {
  return [
    { path: 'index.html', type: 'text/html', bytes: Buffer.from(html) },
    { path: 'styles.css', type: 'text/css', bytes: Buffer.from(cssText) },
    { path: 'hero.png', type: 'image/png', bytes: png },
  ]
}

test('canvas revisions keep a full manifest, fence writes, and retain the stable copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-canvas-store-'))
  const store = openCanvasStore(join(dir, 'canvas.sqlite'))
  try {
    const created = store.create({ sessionId: 'session-canvas', title: 'Poster' })
    assert.equal(created.ok, true)
    if (created.ok !== true) return
    const id = created.canvas.id
    const denied = await store.publish({
      canvasId: id,
      kind: 'snapshot',
      entry: 'index.html',
      expectedFence: 0,
      files: [{ path: 'index.html', type: 'text/html', bytes: Buffer.from('<script>bad</script>') }],
    })
    assert.equal(denied.ok, false)
    if (denied.ok !== false) return
    assert.equal(denied.code, 'VALIDATION')
    assert.equal(
      (
        await store.publish({
          canvasId: id,
          kind: 'snapshot',
          entry: '../index.html',
          expectedFence: 0,
          files: files(),
        })
      ).ok,
      false,
    )
    assert.equal(
      (
        await store.publish({
          canvasId: id,
          kind: 'delta',
          baseRevision: 1,
          entry: 'index.html',
          expectedFence: 0,
          files: files(),
        })
      ).ok,
      false,
    )
    const first = await store.publish({
      canvasId: id,
      kind: 'snapshot',
      entry: 'index.html',
      expectedFence: 0,
      files: files(),
    })
    assert.equal(first.ok, true)
    if (first.ok !== true) return
    assert.equal(first.revision, 1)
    assert.equal(first.kind, 'snapshot')
    assert.equal(
      first.manifest?.some((item: { path: string }) => item.path === 'hero.png'),
      true,
    )
    const raced = await Promise.all([
      store.publish({
        canvasId: id,
        kind: 'delta',
        baseRevision: 1,
        entry: 'index.html',
        expectedFence: 1,
        files: files('body{color:#222}'),
      }),
      store.publish({
        canvasId: id,
        kind: 'delta',
        baseRevision: 1,
        entry: 'index.html',
        expectedFence: 1,
        files: files('body{color:#333}'),
      }),
    ])
    assert.equal(raced.filter(result => result.ok === true).length, 1)
    assert.equal(raced.filter(result => result.ok === false && result.code === 'CAS_CONFLICT').length, 1)
    const gap = await store.publish({
      canvasId: id,
      kind: 'delta',
      baseRevision: 1,
      entry: 'index.html',
      expectedFence: 2,
      files: files('body{color:#444}'),
    })
    assert.equal(gap.ok, false)
    const failed = await store.fail({ canvasId: id, expectedFence: 2, message: 'worker stopped' })
    assert.equal(failed.ok, true)
    const view = store.get(id)
    assert.equal(view.ok, true)
    if (view.ok !== true) return
    assert.equal(view.canvas.previewRevision, 2)
    assert.equal(view.canvas.stableRevision, null)
    const broken = store.manifest(id, 3)
    assert.equal(broken.ok, false)
    const adopted = await store.adopt({ canvasId: id, revision: 1 })
    assert.equal(adopted.ok, true)
    if (adopted.ok !== true) return
    assert.equal(adopted.stableRevision, 1)
    for (let index = 0; index < 24; index += 1) {
      const current = store.get(id)
      if (current.ok !== true) assert.fail('canvas missing')
      const published = await store.publish({
        canvasId: id,
        kind: 'snapshot',
        entry: 'index.html',
        expectedFence: current.canvas.fence,
        files: files(`body{color:#${index.toString(16).padStart(3, '0')}}`),
      })
      assert.equal(published.ok, true)
    }
    assert.equal(store.manifest(id, 1).ok, true)
    assert.equal(store.manifest(id, 2).ok, false)
    const token = store.mint({ canvasId: id, minRevision: 1, maxRevision: 1 })
    assert.equal(token.ok, true)
    if (token.ok !== true) return
    const media = store.readMedia({ token: token.token, revision: 1, path: 'index.html' })
    assert.equal(media.ok, true)
    if (media.ok !== true) return
    assert.equal(media.bytes.toString('utf8'), html)
    assert.equal(store.readMedia({ token: token.token, revision: 2, path: 'index.html' }).ok, false)
    assert.equal(store.readMedia({ token: 'cookie', revision: 1, path: 'index.html' }).code, 'VALIDATION')
    assert.equal(store.readMedia({ token: 'a'.repeat(24), revision: 1, path: 'index.html' }).code, 'FORBIDDEN')
    assert.equal(store.revoke({ canvasId: id, tokenId: token.tokenId }).ok, true)
    assert.equal(store.readMedia({ token: token.token, revision: 1, path: 'index.html' }).code, 'FORBIDDEN')
    const notices = store.live('session-canvas')
    assert.equal(notices.events.length, 1)
    assert.equal(notices.events[0]?.type, 'canvas.revision')
    assert.equal(JSON.stringify(notices).includes('<!doctype'), false)
    assert.equal(JSON.stringify(notices).includes(css), false)
    store.close()
    const reopened = openCanvasStore(join(dir, 'canvas.sqlite'))
    assert.equal(reopened.live('session-canvas').events[0]?.canvasId, id)
    reopened.close()
    const persona = openStore(join(dir, 'persona'))
    const names = toolDefinitions(createEngine(persona)).map(tool => tool.name)
    persona.close()
    assert.equal(
      names.some(name => name.includes('canvas')),
      false,
    )
    const workerTools = readFileSync(new URL('../src/work-tools.ts', import.meta.url), 'utf8')
    assert.equal(workerTools.includes('canvas_write') || workerTools.includes('canvas_publish'), false)
  } finally {
    try {
      store.close()
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('canvas packages reject oversized files and active image types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-canvas-limits-'))
  const store = openCanvasStore(join(dir, 'canvas.sqlite'))
  try {
    const created = store.create({ sessionId: 'session-limits' })
    assert.equal(created.ok, true)
    if (created.ok !== true) return
    const oversized = await store.publish({
      canvasId: created.canvas.id,
      kind: 'snapshot',
      entry: 'index.html',
      expectedFence: 0,
      files: [
        { path: 'index.html', type: 'text/html', bytes: Buffer.from('<p>ok</p></html>') },
        { path: 'big.css', type: 'text/css', bytes: Buffer.alloc(CANVAS_MAX_FILE_BYTES + 1, 0x61) },
      ],
    })
    assert.equal(oversized.ok, false)
    const heavy: CanvasFileInput[] = [{ path: 'index.html', type: 'text/html', bytes: Buffer.from('<p>ok</p></html>') }]
    const each = Math.floor(CANVAS_MAX_PACKAGE_BYTES / 6)
    for (let index = 0; index < 6; index += 1) {
      heavy.push({ path: `part-${index}.css`, type: 'text/css', bytes: Buffer.alloc(each, 0x62) })
    }
    const packed = await store.publish({
      canvasId: created.canvas.id,
      kind: 'snapshot',
      entry: 'index.html',
      expectedFence: 0,
      files: heavy,
    })
    assert.equal(packed.ok, false)
    const svg = await store.publish({
      canvasId: created.canvas.id,
      kind: 'snapshot',
      entry: 'index.html',
      expectedFence: 0,
      files: [
        { path: 'index.html', type: 'text/html', bytes: Buffer.from('<p>ok</p></html>') },
        {
          path: 'mark.svg',
          type: 'image/svg+xml',
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        },
      ],
    })
    assert.equal(svg.ok, false)
    const fresh = store.get(created.canvas.id)
    assert.equal(fresh.ok, true)
    if (fresh.ok !== true) return
    assert.equal(fresh.canvas.previewRevision, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
