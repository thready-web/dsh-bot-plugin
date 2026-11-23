import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deskCacheControl,
  deskContentType,
  deskHeaders,
  deskPwaEnabled,
  deskPwaFileBlocked,
} from '../src/desk-static.ts'

test('the shell document is never stored by HTTP caches', () => {
  assert.equal(deskCacheControl('index.html'), 'no-store')
  assert.equal(deskCacheControl('deeper/index.html'), 'no-store')
})

test('the worker and the two manifests always revalidate', () => {
  assert.equal(deskCacheControl('sw.js'), 'no-cache')
  assert.equal(deskCacheControl('manifest.webmanifest'), 'no-cache')
  assert.equal(deskCacheControl('release.json'), 'no-cache')
})

test('content-hashed assets keep the long immutable policy', () => {
  assert.equal(deskCacheControl('assets/index-DGY78ArV.js'), 'public, max-age=31536000, immutable')
  assert.equal(deskCacheControl('icons/icon-192.png'), 'public, max-age=31536000, immutable')
})

test('the manifest gets a manifest MIME type', () => {
  assert.equal(deskContentType('manifest.webmanifest'), 'application/manifest+json; charset=utf-8')
  assert.equal(deskContentType('sw.js'), 'text/javascript; charset=utf-8')
})

test('only the worker script claims the /dsh-bot/ scope', () => {
  const worker = deskHeaders('sw.js')
  assert.equal(worker['service-worker-allowed'], '/dsh-bot/')
  assert.equal(deskHeaders('assets/index-abc.js')['service-worker-allowed'], undefined)
})

test('the kill-switch hides the shell files, not the built assets', () => {
  assert.equal(deskPwaFileBlocked('sw.js', false), true)
  assert.equal(deskPwaFileBlocked('manifest.webmanifest', false), true)
  assert.equal(deskPwaFileBlocked('release.json', false), true)
  assert.equal(deskPwaFileBlocked('assets/index-abc.js', false), false)
  assert.equal(deskPwaFileBlocked('index.html', false), false)
  assert.equal(deskPwaFileBlocked('sw.js', true), false)
})

test('DSH_BOT_PWA is on unless it is explicitly off', () => {
  assert.equal(deskPwaEnabled({}), true)
  assert.equal(deskPwaEnabled({ DSH_BOT_PWA: '1' }), true)
  assert.equal(deskPwaEnabled({ DSH_BOT_PWA: '0' }), false)
  assert.equal(deskPwaEnabled({ DSH_BOT_PWA: 'false' }), false)
  assert.equal(deskPwaEnabled({ DSH_BOT_PWA: ' OFF ' }), false)
})
