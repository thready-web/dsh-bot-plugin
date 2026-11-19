import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseCanvasMedia } from '../src/canvas-http.ts'
import { createEngine } from '../src/engine.ts'
import { registerHttp } from '../src/http.ts'
import { openStore } from '../src/store.ts'
import { openPageLive } from '../src/work-http.ts'
import { openCanvasStore } from '../src/canvas-store.ts'

const html = '<!doctype html><link rel="stylesheet" href="styles.css"><img src="hero.png" alt=""></html>'
const css = 'body{color:#111}'
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')

function pack(cssText = css) {
  return [
    { path: 'index.html', type: 'text/html', body: Buffer.from(html).toString('base64') },
    { path: 'styles.css', type: 'text/css', body: Buffer.from(cssText).toString('base64') },
    { path: 'hero.png', type: 'image/png', body: png.toString('base64') },
  ]
}

test('canvas media trusts the capability token and ignores the login gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-canvas-http-'))
  const store = openStore(dir)
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  let dispose = () => {}
  const ctx = {
    effect: (fn: () => unknown) => {
      const done = fn()
      if (typeof done === 'function') dispose = done as () => void
    },
    get: () => ({ requestRejection: (req: IncomingMessage) => (req.headers.authorization === 'test-owner' ? 0 : 401) }),
    webServer: {
      register: (route: (typeof routes)[number]) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  registerHttp(
    ctx as any,
    createEngine(store),
    () => null,
    () =>
      ({
        liveStamp: () => 'stamp',
        liveBoardAll: () => ({ tickets: [] }),
      }) as any,
    dir,
  )
  const handler = routes.find(route => route.path === '/dsh-bot')!.handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { authorization: 'test-owner', 'content-type': 'application/json' }
  try {
    const anonymous = await fetch(`${origin}/dsh-bot/api/canvas?sessionId=session-canvas`)
    assert.equal(anonymous.status, 401)
    assert.equal((await anonymous.json()).code, 'FORBIDDEN')
    const alias = await fetch(`${origin}/session-foundations/api/canvas?sessionId=session-canvas`, { headers })
    assert.equal(alias.status, 200)
    assert.deepEqual((await alias.json()).canvases, [])
    const created = await (
      await fetch(`${origin}/dsh-bot/api/canvas`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'session-canvas', title: 'Poster' }),
      })
    ).json()
    const id = created.canvas.id as string
    const published = await (
      await fetch(`${origin}/dsh-bot/api/canvas/${id}/snapshot`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedFence: 0, entry: 'index.html', files: pack() }),
      })
    ).json()
    assert.equal(published.revision, 1)
    assert.equal(JSON.stringify(published).includes(html), false)
    const token = await (
      await fetch(`${origin}/dsh-bot/api/canvas/${id}/token`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: 1 }),
      })
    ).json()
    const media = `/dsh-bot/canvas-media/${token.token}/1/index.html`
    const cookied = await fetch(origin + media, { headers: { cookie: 'dsh=owner-session' } })
    assert.equal(cookied.status, 200)
    assert.equal(cookied.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(cookied.headers.get('x-content-type-options'), 'nosniff')
    const policy = cookied.headers.get('content-security-policy') ?? ''
    assert.equal(policy.includes("'self'"), false)
    assert.match(
      policy,
      new RegExp(`img-src http://127\\.0\\.0\\.1:${address.port}/dsh-bot/canvas-media/${token.token}/1/`),
    )
    assert.match(
      policy,
      new RegExp(
        `style-src http://127\\.0\\.0\\.1:${address.port}/dsh-bot/canvas-media/${token.token}/1/ 'unsafe-inline'`,
      ),
    )
    assert.match(
      policy,
      new RegExp(`font-src http://127\\.0\\.0\\.1:${address.port}/dsh-bot/canvas-media/${token.token}/1/`),
    )
    assert.match(policy, new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${address.port}`))
    assert.match(policy, /sandbox/)
    assert.doesNotMatch(policy, /allow-scripts/)
    assert.doesNotMatch(policy, /allow-same-origin/)
    const inspect = await fetch(`${origin}/dsh-bot/canvas-inspect/${token.token}/1?nonce=abc123abc123abc123`)
    assert.equal(inspect.status, 200)
    const inspectPolicy = inspect.headers.get('content-security-policy') ?? ''
    assert.match(inspectPolicy, /sandbox allow-scripts/)
    assert.doesNotMatch(inspectPolicy, /allow-same-origin/)
    assert.match(inspectPolicy, /script-src http:\/\/127\.0\.0\.1:\d+\/dsh-bot\/canvas-inspector\.js/)
    const inspectHtml = await inspect.text()
    assert.match(inspectHtml, /<script src="\/dsh-bot\/canvas-inspector\.js"><\/script>/)
    assert.match(inspectHtml, /name="dsh-inspect-page" content="index\.html"/)
    const named = await fetch(`${origin}/dsh-bot/canvas-inspect/${token.token}/1/index.html?nonce=abc123abc123abc123`)
    assert.equal(named.status, 200)
    const notHtml = await fetch(`${origin}/dsh-bot/canvas-inspect/${token.token}/1/styles.css?nonce=abc123abc123abc123`)
    assert.equal(notHtml.status, 400)
    assert.equal(inspectHtml.includes('<script'), true)
    assert.equal((inspectHtml.match(/<script/g) ?? []).length, 1)
    const missingNonce = await fetch(`${origin}/dsh-bot/canvas-inspect/${token.token}/1`)
    assert.equal(missingNonce.status, 400)
    const inspector = await fetch(`${origin}/dsh-bot/canvas-inspector.js`)
    assert.equal(inspector.status, 200)
    assert.match(await inspector.text(), /canvas-inspect/)
    assert.equal(await cookied.text(), html)
    const style = await fetch(`${origin}/dsh-bot/canvas-media/${token.token}/1/styles.css`)
    assert.equal(style.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(await style.text(), css)
    const image = await fetch(`${origin}/dsh-bot/canvas-media/${token.token}/1/hero.png`, { method: 'HEAD' })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('content-length'), String(png.length))
    const authorizedButWrong = await fetch(`${origin}/dsh-bot/canvas-media/${'a'.repeat(24)}/1/index.html`, {
      headers: { authorization: 'test-owner', cookie: 'dsh=owner-session' },
    })
    assert.equal(authorizedButWrong.status, 401)
    assert.equal((await authorizedButWrong.json()).code, 'FORBIDDEN')
    const otherRevision = await fetch(`${origin}/dsh-bot/canvas-media/${token.token}/2/index.html`)
    assert.equal(otherRevision.status, 401)
    const escaped = await fetch(`${origin}/dsh-bot/canvas-media/${token.token}/1/%2e%2e/index.html`)
    assert.equal(escaped.status, 400)
    assert.equal(parseCanvasMedia(`/dsh-bot/canvas-media/${token.token}/1/../../secret.html`), null)
    const liveAbort = new AbortController()
    const live = await fetch(`${origin}/dsh-bot/api/live?sessionId=session-canvas`, {
      headers,
      signal: liveAbort.signal,
    })
    assert.equal(live.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const reader = live.body?.getReader()
    assert.ok(reader)
    let text = ''
    const deadline = Date.now() + 2000
    while (reader && !text.includes('event: canvas') && Date.now() < deadline) {
      const step = await reader.read()
      if (step.done) break
      text += new TextDecoder().decode(step.value)
    }
    liveAbort.abort()
    await reader?.cancel().catch(() => undefined)
    assert.match(text, /event: canvas/)
    assert.match(text, /canvas\.revision/)
    assert.equal(text.includes(html), false)
    assert.equal(text.includes(css), false)
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an idle canvas stream does not repeat the same revision notice', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const dir = mkdtempSync(join(tmpdir(), 'sf-canvas-live-'))
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  const created = canvas.create({ sessionId: 'session-live' })
  assert.equal(created.ok, true)
  if (created.ok !== true) return
  await canvas.publish({
    canvasId: created.canvas.id,
    kind: 'snapshot',
    entry: 'index.html',
    expectedFence: 0,
    files: [{ path: 'index.html', type: 'text/html', bytes: Buffer.from('<p>quiet</p></html>') }],
  })
  const chunks: string[] = []
  const callbacks = new Map<string, Array<(...args: any[]) => void>>()
  let ended = false
  const pending = openPageLive(
    {
      on: (name: string, fn: (...args: any[]) => void) => {
        callbacks.set(name, [...(callbacks.get(name) ?? []), fn])
      },
    },
    {
      get writableEnded() {
        return ended
      },
      writeHead() {},
      write: text => chunks.push(String(text)),
      end() {
        ended = true
      },
      on() {},
    },
    {
      workStamp: () => 'same',
      workBoard: () => ({}),
      loadDesk: () => new Promise(() => {}),
      canvas: () => canvas.live('session-live'),
    },
  )
  const frames = () => chunks.filter(text => text.startsWith('event: canvas'))
  assert.equal(frames().length, 1)
  assert.equal(frames()[0]?.includes('<p>quiet</p>'), false)
  t.mock.timers.tick(60_000)
  assert.equal(frames().length, 1)
  for (const callback of callbacks.get('close') ?? []) callback()
  await pending
  canvas.close()
  rmSync(dir, { recursive: true, force: true })
  t.mock.timers.reset()
  assert.equal(readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8').includes('canvas_write'), false)
})
