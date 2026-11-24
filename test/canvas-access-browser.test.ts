import { strict as assert } from 'node:assert'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { createEngine } from '../src/engine.ts'
import { registerHttp } from '../src/http.ts'
import { openStore } from '../src/store.ts'

const bundled = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../scripts/bundle-inspector.mjs', import.meta.url))],
  {
    stdio: 'inherit',
  },
)
if (bundled.status !== 0) throw new Error('canvas inspector bundle failed')

const harnessJs = buildSync({
  entryPoints: [fileURLToPath(new URL('./canvas-access-harness.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
}).outputFiles[0]!.text

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const html =
  '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1 id="title">Poster title</h1><img id="hero" src="images/hero.png" alt=""></body></html>'
const css =
  'h1{color:#abcdef;background-image:url("images/hero.png")}@font-face{font-family:CanvasMark;src:url("fonts/mark.woff2")}body{font-family:CanvasMark,sans-serif}'
const font = Buffer.from('woff2mark')

function sha256(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const files = [
  { path: 'index.html', type: 'text/html', bytes: Buffer.from(html) },
  { path: 'styles.css', type: 'text/css', bytes: Buffer.from(css) },
  { path: 'images/hero.png', type: 'image/png', bytes: png },
  { path: 'fonts/mark.woff2', type: 'font/woff2', bytes: font },
]

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })
}

class Cdp {
  private ws!: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private waiters: Array<(message: any) => void> = []
  private socketUrl: string

  constructor(url: string) {
    this.socketUrl = url
  }

  async open() {
    this.ws = new WebSocket(this.socketUrl)
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('devtools socket failed')))
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      const pending = message.id ? this.pending.get(message.id) : undefined
      if (pending) {
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
        return
      }
      for (const waiter of this.waiters) waiter(message)
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  on(fn: (message: any) => void) {
    this.waiters.push(fn)
  }

  close() {
    this.ws.close()
  }
}

function chromeBinary(): string {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome binary found; set CHROME_BIN')
}

function launchChrome() {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-chrome-'))
  const proc = spawn(
    chromeBinary(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${dir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not open a devtools port')), 15_000)
    let buf = ''
    proc.stderr?.on('data', chunk => {
      buf += chunk.toString()
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1]!)
    })
  })
  return { proc, dir, url }
}

test('an access challenge proxy still shows the canvas, and a cookie is not a capability', {
  timeout: 60_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-canvas-access-'))
  const store = openStore(dir)
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  let dispose = () => {}
  registerHttp(
    {
      effect: (fn: () => unknown) => {
        const done = fn()
        if (typeof done === 'function') dispose = done as () => void
      },
      get: () => ({
        requestRejection: (req: IncomingMessage) => (req.headers.authorization === 'test-owner' ? 0 : 401),
      }),
      webServer: {
        register: (route: (typeof routes)[number]) => {
          routes.push(route)
          return () => {}
        },
      },
    } as any,
    createEngine(store),
    () => null,
    () => ({ liveStamp: () => 'stamp', liveBoardAll: () => ({ tickets: [] }) }) as any,
    dir,
  )
  const handler = routes.find(route => route.path === '/dsh-bot')!.handler
  const upstream = createServer((req, res) => void handler(req, res))
  const upstreamPort = await listen(upstream)
  const loginHits: string[] = []
  const login = createServer((req, res) => {
    loginHits.push(req.headers.cookie ?? '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><title>Sign in</title><p>cdn-cgi/access/login</p>')
  })
  const loginPort = await listen(login)
  const seen: Array<{ path: string; cookie: string }> = []
  const proxy = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const cookie = req.headers.cookie ?? ''
    if (!cookie.split(';').some(part => part.trim() === 'CF_Authorization=present')) {
      res.writeHead(302, {
        location: `http://127.0.0.1:${loginPort}/cdn-cgi/access/login`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (path === '/preview.html' || path === '/harness.js') {
      const body =
        path === '/harness.js'
          ? harnessJs
          : '<!doctype html><meta charset="utf-8"><p id="state">pending</p><iframe id="frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script src="/harness.js"></script>'
      res.writeHead(200, {
        'content-type': path === '/harness.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }
    seen.push({ path, cookie })
    const upstreamReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstreamReq)
  })
  const proxyPort = await listen(proxy)
  const origin = `http://127.0.0.1:${proxyPort}`
  const headers = { authorization: 'test-owner', 'content-type': 'application/json' }
  const chrome = launchChrome()
  let browser: ChildProcess | null = null
  let cdp: Cdp | null = null
  try {
    const created = await (
      await fetch(`http://127.0.0.1:${upstreamPort}/dsh-bot/api/canvas`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'session-canvas', title: 'Poster' }),
      })
    ).json()
    const id = created.canvas.id as string
    const published = await (
      await fetch(`http://127.0.0.1:${upstreamPort}/dsh-bot/api/canvas/${id}/snapshot`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedFence: 0,
          entry: 'index.html',
          files: files.map(file => ({ path: file.path, type: file.type, body: file.bytes.toString('base64') })),
        }),
      })
    ).json()
    assert.equal(published.revision, 1)
    const minted = await (
      await fetch(`http://127.0.0.1:${upstreamPort}/dsh-bot/api/canvas/${id}/token`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: 1 }),
      })
    ).json()
    const token = minted.token as string
    const manifest = files.map(file => ({
      path: file.path,
      type: file.type,
      bytes: file.bytes.length,
      hash: sha256(file.bytes),
    }))
    const spec = { token, revision: 1, entry: 'index.html', manifest }

    browser = (await chrome.url, chrome.proc)
    const socket = await chrome.url
    cdp = new Cdp(socket)
    await cdp.open()
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send(
      'Network.setCookie',
      { name: 'CF_Authorization', value: 'present', url: origin, httpOnly: true },
      sessionId,
    )
    await cdp.send('Network.setCookie', { name: 'dsh_session', value: 'owner-secret', url: origin }, sessionId)
    const loaded = new Promise<void>(resolve => {
      const onMessage = (message: any) => {
        if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
          resolve()
        }
      }
      cdp?.on(onMessage)
    })
    await cdp.send('Page.navigate', { url: `${origin}/preview.html` }, sessionId)
    await loaded
    const evaluate = async (expression: string, contextId?: number) => {
      const outcome = await cdp!.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
        sessionId,
      )
      if (outcome.exceptionDetails) throw new Error(outcome.exceptionDetails.text || 'page evaluation failed')
      return outcome.result?.value
    }

    assert.equal(await evaluate(`preview.load(${JSON.stringify(spec)})`), 'shown')
    const targets = await cdp.send('Target.getTargets')
    const iframeTarget = targets.targetInfos.find(
      (item: { type?: string; url?: string }) => item.type === 'iframe' || item.url === 'about:srcdoc',
    )
    assert.ok(iframeTarget)
    const attached = await cdp.send('Target.attachToTarget', { targetId: iframeTarget.targetId, flatten: true })
    const frameSession = attached.sessionId as string
    await cdp.send('Runtime.enable', {}, frameSession)
    const evaluateFrame = async (expression: string) => {
      const outcome = await cdp!.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        frameSession,
      )
      if (outcome.exceptionDetails)
        throw new Error(outcome.exceptionDetails.exception?.description || JSON.stringify(outcome.exceptionDetails))
      return outcome.result?.value
    }
    const inside = await evaluateFrame(
      `(() => {
        const title = document.getElementById('title')
        const image = document.getElementById('hero')
        const style = getComputedStyle(title)
        return {
          text: title.textContent,
          color: style.color,
          background: style.backgroundImage,
          width: image.naturalWidth,
          cookie: (() => { try { return document.cookie } catch (error) { return 'blocked:' + error.name } })(),
          font: [...document.querySelectorAll('style')].some(node => node.textContent.includes('data:font/woff2')),
          scripts: document.scripts.length,
        }
      })()`,
    )
    assert.equal(inside.text, 'Poster title')
    assert.equal(inside.color, 'rgb(171, 205, 239)')
    assert.match(inside.background, /^url\("data:image\/png/)
    assert.equal(inside.width, 1)
    assert.equal(inside.cookie, 'blocked:SecurityError')
    assert.equal(inside.font, true)
    assert.equal(inside.scripts, 1)
    const leaked = await evaluateFrame(
      `fetch('/dsh-bot/api/canvas?sessionId=session-canvas', { credentials: 'include' }).then(response => 'status:' + response.status, error => 'blocked:' + error.name)`,
    )
    assert.match(leaked, /^blocked:/)
    const frameAttrs = await evaluate(
      `(() => { const frame = document.querySelector('iframe'); return { sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src'), cookie: document.cookie } })()`,
    )
    assert.equal(frameAttrs.sandbox, 'allow-scripts')
    assert.equal(frameAttrs.src, null)
    assert.match(frameAttrs.cookie, /dsh_session=owner-secret/)
    assert.equal(frameAttrs.cookie.includes('CF_Authorization'), false)
    assert.equal(loginHits.length, 0)
    assert.equal(
      seen.every(row => row.cookie.includes('dsh_session=owner-secret')),
      true,
    )
    assert.equal(
      seen.some(row => row.path.includes('/dsh-bot/canvas-media/') && row.path.endsWith('/index.html')),
      true,
    )

    assert.equal(await evaluate('preview.foreign()'), 'refused')
    assert.equal(loginHits.length, 0)

    const missing = { ...spec, token: 'c'.repeat(24) }
    assert.equal(await evaluate(`preview.load(${JSON.stringify(missing)})`), 'rejected')
    const wrongRevision = { ...spec, revision: 2 }
    assert.equal(await evaluate(`preview.load(${JSON.stringify(wrongRevision)})`), 'rejected')
    const database = new DatabaseSync(join(dir, 'canvas.sqlite'))
    database.prepare(`UPDATE canvas_tokens SET expires_at = ?`).run('2000-01-01T00:00:00.000Z')
    database.close()
    assert.equal(await evaluate(`preview.load(${JSON.stringify(spec)})`), 'rejected')

    await cdp.send('Network.deleteCookies', { name: 'CF_Authorization', url: origin }, sessionId)
    const before = loginHits.length
    assert.equal(await evaluate(`preview.load(${JSON.stringify({ ...spec, token })})`), 'access')
    assert.equal(
      loginHits.slice(before).some(cookie => cookie.includes('dsh_session') || cookie.includes('CF_Authorization')),
      false,
    )
    assert.equal(await evaluate(`document.getElementById('frame').getAttribute('srcdoc')`), null)
    assert.equal(await evaluate(`document.body.textContent.includes('cdn-cgi/access/login')`), false)
  } finally {
    try {
      cdp?.close()
    } catch {
      /* the socket may already be gone */
    }
    browser?.kill('SIGKILL')
    chrome.proc.kill('SIGKILL')
    upstream.closeAllConnections?.()
    login.closeAllConnections?.()
    proxy.closeAllConnections?.()
    await Promise.all([
      new Promise(resolve => upstream.close(resolve)),
      new Promise(resolve => login.close(resolve)),
      new Promise(resolve => proxy.close(resolve)),
    ])
    dispose()
    store.close()
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(chrome.dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
    } catch {
      /* chrome can still be releasing its profile */
    }
  }
})
