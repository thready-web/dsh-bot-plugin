import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildShell, injectInstallLinks, shellEntryUrls } from '../ui/pwa/build-shell.mjs'

const INDEX = `<!doctype html>
<html>
  <head>
    <link rel="manifest" href="/dsh-bot/manifest.webmanifest" />
    <script type="module" crossorigin src="/dsh-bot/assets/index-aaa.js"></script>
    <link rel="stylesheet" crossorigin href="/dsh-bot/assets/index-aaa.css" />
  </head>
  <body><div id="root"></div></body>
</html>
`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-pwa-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), INDEX)
  writeFileSync(join(dir, 'assets/index-aaa.js'), 'console.log("shell")\n')
  writeFileSync(join(dir, 'assets/index-aaa.css'), 'body{color:#000}\n')
  return dir
}

function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

test('the built shell references exactly the entry assets and the icons', async () => {
  const dir = fixture()
  try {
    const plan = await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    assert.match(plan.releaseId, /^[0-9a-f]{16}$/)
    const urls = plan.entries.map(entry => entry.url)
    assert.deepEqual(urls, [
      '/dsh-bot/index.html',
      '/dsh-bot/assets/index-aaa.js',
      '/dsh-bot/assets/index-aaa.css',
      '/dsh-bot/icons/icon-192.png',
      '/dsh-bot/icons/icon-512.png',
      '/dsh-bot/icons/icon-maskable-512.png',
      '/dsh-bot/icons/apple-touch-icon-180.png',
      '/dsh-bot/favicon.svg',
    ])
    for (const entry of plan.entries) {
      assert.match(entry.hash, /^[0-9a-f]{16}$/)
      assert.ok(entry.bytes > 0)
    }
    for (const file of ['manifest.webmanifest', 'release.json', 'sw.js', 'favicon.svg']) {
      assert.ok(existsSync(join(dir, file)), `${file} exists`)
    }
    for (const icon of plan.entries.filter(entry => entry.url.includes('/icons/'))) {
      const png = readFileSync(join(dir, icon.url.slice('/dsh-bot/'.length)))
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the manifest starts at /dsh-bot/ and points at the generated icons', async () => {
  const dir = fixture()
  try {
    await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    const manifest = readJson(dir, 'manifest.webmanifest')
    assert.equal(manifest.start_url, '/dsh-bot/')
    assert.equal(manifest.scope, '/dsh-bot/')
    assert.equal(manifest.display, 'standalone')
    assert.equal(manifest.theme_color, '#e23d8a')
    assert.deepEqual(
      manifest.icons.map(icon => icon.src),
      ['/dsh-bot/icons/icon-192.png', '/dsh-bot/icons/icon-512.png', '/dsh-bot/icons/icon-maskable-512.png'],
    )
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the release manifest binds the shell to one atomic release id', async () => {
  const dir = fixture()
  try {
    const plan = await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    const release = readJson(dir, 'release.json')
    assert.equal(release.releaseId, plan.releaseId)
    assert.equal(release.shell, '/dsh-bot/index.html')
    assert.deepEqual(
      release.entries.map(entry => entry.url),
      plan.entries.map(entry => entry.url),
    )
    assert.equal(release.builtAt, '2026-01-02T03:04:05.000Z')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the worker carries its release id, hash list, and routing source', async () => {
  const dir = fixture()
  try {
    const plan = await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    const worker = readFileSync(join(dir, 'sw.js'), 'utf8')
    assert.ok(worker.includes(`const RELEASE_ID = '${plan.releaseId}'`))
    assert.ok(worker.includes('"url": "/dsh-bot/index.html"'))
    assert.ok(worker.includes('DshBotPwa'))
    assert.ok(worker.includes('skipWaiting'))
    assert.ok(!worker.includes('__RELEASE_ID__'))
    assert.ok(!worker.includes('__PRECACHE__'))
    assert.ok(!worker.includes('__ROUTES__'))
    assert.ok(!worker.includes('importScripts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the release id changes when any precached byte changes', async () => {
  const dir = fixture()
  try {
    const first = await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    const again = await buildShell(dir, { builtAt: '2026-01-03T00:00:00.000Z' })
    assert.equal(again.releaseId, first.releaseId, 'the build time is not part of the release id')

    writeFileSync(join(dir, 'assets/index-aaa.js'), 'console.log("changed")\n')
    const changed = await buildShell(dir, { builtAt: '2026-01-02T03:04:05.000Z' })
    assert.notEqual(changed.releaseId, first.releaseId)
    assert.notEqual(changed.entries[1].hash, first.entries[1].hash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install metadata is injected into the built document only once', () => {
  const bare = '<html><head><title>DSH Bot</title></head><body></body></html>'
  const wired = injectInstallLinks(bare)
  assert.ok(wired.includes('rel="manifest" href="/dsh-bot/manifest.webmanifest"'))
  assert.ok(wired.includes('rel="icon" href="/dsh-bot/favicon.svg"'))
  assert.ok(wired.includes('rel="apple-touch-icon" href="/dsh-bot/icons/apple-touch-icon-180.png"'))
  assert.equal(injectInstallLinks(wired), wired)
  assert.equal(shellEntryUrls(wired).includes('/dsh-bot/manifest.webmanifest'), false)
})

test('metadata links are not mistaken for precache entries', () => {
  assert.deepEqual(shellEntryUrls(INDEX), ['/dsh-bot/assets/index-aaa.js', '/dsh-bot/assets/index-aaa.css'])
  assert.deepEqual(shellEntryUrls('<link rel="manifest" href="/dsh-bot/manifest.webmanifest">'), [])
  assert.deepEqual(shellEntryUrls('<link rel="icon" href="/dsh-bot/favicon.svg">'), ['/dsh-bot/favicon.svg'])
})

test('a missing referenced asset fails the build instead of shipping a broken shell', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'index.html'), '<script src="/dsh-bot/assets/missing-zzz.js"></script>')
    await assert.rejects(buildShell(dir), /precache entry missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
