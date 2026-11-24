import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInThisContext } from 'node:vm'

/**
 * These rules are the shell's security boundary: they decide what may enter Cache
 * Storage. The test runs the exact file that build-shell.mjs inlines into sw.js.
 */
type Routes = {
  classify: (request: Record<string, unknown>) => string
  navigationAction: (probe: { redirected?: boolean } | null) => string
}

const source = readFileSync(new URL('../../pwa/routes.js', import.meta.url), 'utf8')
runInThisContext(source, { filename: 'routes.js' })
const routes = (globalThis as typeof globalThis & { DshBotPwa: Routes }).DshBotPwa
const ORIGIN = 'https://bot.example'

function classify(url: string, overrides: Record<string, unknown> = {}): string {
  return routes.classify({ url, origin: ORIGIN, method: 'GET', ...overrides })
}

test('the workbench document is the shell and nothing else is', () => {
  assert.equal(classify('/dsh-bot/'), 'shell')
  assert.equal(classify('/dsh-bot/index.html'), 'shell')
  assert.equal(classify('/dsh-bot/?x=1'), 'shell')
  assert.equal(classify('/dsh-bot/some/path'), 'network')
  assert.equal(classify('/dsh-bot'), 'network')
})

test('entry assets, icons, and the favicon are precacheable', () => {
  assert.equal(classify('/dsh-bot/assets/index-DGY78ArV.js'), 'asset')
  assert.equal(classify('/dsh-bot/assets/SourceEditor-0MNxssuQ.js'), 'asset')
  assert.equal(classify('/dsh-bot/icons/icon-512.png'), 'asset')
  assert.equal(classify('/dsh-bot/favicon.svg'), 'asset')
  assert.equal(classify('/dsh-bot/assets/nested/thing.js'), 'network')
})

test('API, live streams, and host routes are never cached', () => {
  assert.equal(classify('/dsh-bot/api/sessions'), 'bypass')
  assert.equal(classify('/dsh-bot/api/live'), 'bypass')
  assert.equal(classify('/dsh-bot/api/live', { accept: 'text/event-stream' }), 'bypass')
  assert.equal(classify('/api/session/events'), 'bypass')
  assert.equal(classify('/api/dsh-bot/log/tail'), 'bypass')
  assert.equal(classify('/apiary'), 'network')
})

test('capability and workspace resources are never cached', () => {
  assert.equal(classify('/dsh-bot/canvas-media/tok/art.png'), 'bypass')
  assert.equal(classify('/dsh-bot/canvas-inspect/tok'), 'bypass')
  assert.equal(classify('/dsh-bot/canvas-view/tok'), 'bypass')
  assert.equal(classify('/dsh-bot/canvas-inspector.js'), 'bypass')
  assert.equal(classify('/dsh-bot/workspace/artifacts/preview.png'), 'network')
})

test('shell update files are fetched, never served from the shell bucket', () => {
  assert.equal(classify('/dsh-bot/sw.js'), 'bypass')
  assert.equal(classify('/dsh-bot/manifest.webmanifest'), 'bypass')
  assert.equal(classify('/dsh-bot/release.json'), 'bypass')
})

test('non-GET and cross-origin requests are untouched', () => {
  assert.equal(classify('/dsh-bot/', { method: 'POST' }), 'bypass')
  assert.equal(classify('https://elsewhere.example/dsh-bot/'), 'bypass')
  assert.equal(classify('/dsh-bot/', { origin: '' }), 'shell')
})

test('a navigation only falls back to cache when the network did not answer', () => {
  assert.equal(routes.navigationAction(null), 'cache')
})

test('a network redirect is handed to the browser, whatever it is for', () => {
  assert.equal(routes.navigationAction({ redirected: true }), 'handoff')
})

test('every other network answer is returned unchanged', () => {
  assert.equal(routes.navigationAction({ redirected: false }), 'network')
})

test('the worker carries no notion of a sign-in response', () => {
  const api = routes as unknown as Record<string, unknown>
  assert.equal('BOUNCE_PATH' in api, false)
  assert.equal('LOGIN_PATH' in api, false)
  assert.equal(JSON.stringify(Object.keys(api)).includes('login'), false)
})

test('the exported constants match the generated worker files', () => {
  const api = routes as Routes & { SHELL_INDEX: string; SHELL_CACHE_PREFIX: string }
  assert.equal(api.SHELL_INDEX, '/dsh-bot/index.html')
  assert.equal(api.SHELL_CACHE_PREFIX, 'dsh-bot-shell-')
})
