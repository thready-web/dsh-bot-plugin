import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const chrome = [
  process.env.CHROME_PATH,
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(path => path && existsSync(path))

const stylesheet = fileURLToPath(new URL('../ui/src/styles.css', import.meta.url))

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${stylesheet}" />
</head>
<body>
<div id="root">
  <div class="shell in-chat">
    <aside class="side"></aside>
    <section class="chat">
      <header class="chat-head">
        <button type="button" class="back">Sessions</button>
        <span class="bot-badge">BOT</span>
        <h1 id="title">Skill-load inventory acceptance check</h1>
        <span class="work-chip">Delivered</span>
        <button type="button" class="files-open">Memory</button>
        <button type="button" class="files-open">Files</button>
        <a href="#official">Official client</a>
      </header>
      <button type="button" class="basis">basis line for this session</button>
      <div class="chat-body">
        <div class="scroll">
          <div class="column">
            <div class="markdown">
              <p>Public HEAD 302 to Cloudflare Access. Bridge ports stay on their own lines and the transcript has to scroll inside the column.</p>
              <p>verify_runtime fully green, with a long wrapped path /opt/dsh-bot/backups/preview-deploy/20261119-233931-5ebfbd9b91dcd70561aa75f3380a5da6f720d/ROLLBACK.sh that must not widen the page.</p>
              ${'<p>Another paragraph of the report so the inner scroller is taller than the chat column.</p>'.repeat(24)}
            </div>
          </div>
        </div>
      </div>
      <div class="composer-wrap">
        <form class="column">
          <div class="card">
            <textarea rows="1" placeholder="Message, or type @ to mention another bot"></textarea>
            <div class="card-row">
              <div class="tools">
                <button type="button" class="add" aria-label="Add">+</button>
                <button type="button" class="chip">
                  <svg viewBox="0 0 16 16" aria-hidden="true"></svg>
                  Workspace Write
                </button>
              </div>
              <div class="trailing">
                <span class="model">deepseek-v4.1-flash</span>
                <button type="button" class="send" aria-label="Send">↑</button>
              </div>
            </div>
          </div>
          <p class="stats">9 turns · 53 steps</p>
        </form>
      </div>
    </section>
  </div>
</div>
<div class="files-drawer narrow" id="drawer" hidden>
  <header class="files-head"><span class="files-crumb-current">workspace</span></header>
  <div class="files-body"><div class="files-name">a-very-long-file-name-that-must-stay-inside-the-drawer.txt</div></div>
</div>
<div class="settings-drawer" id="settings" hidden>
  <div class="settings-drawer-sheet"><h3>Memory</h3><p>Drawer copy stays inside the sheet.</p></div>
</div>
<script>
const box = (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height }
}
const hit = (el) => {
  const r = el.getBoundingClientRect()
  const node = document.elementFromPoint(r.x + Math.min(8, r.width / 2), r.y + r.height / 2)
  if (!node) return 'none'
  if (node === el || el.contains(node)) return true
  return node.tagName + '.' + node.className
}
window.measure = () => {
  const q = (s) => document.querySelector(s)
  const de = document.documentElement
  const vv = visualViewport
  const controls = [...q('.chat-head').children].map((el) => ({
    name: el.tagName + '.' + el.className,
    text: (el.textContent || '').trim().slice(0, 48),
    box: box(el),
    hit: hit(el),
  }))
  const chip = q('.chip')
  const model = q('.model')
  const cr = chip.getBoundingClientRect()
  const mr = model.getBoundingClientRect()
  const overlap = cr.left < mr.right - 0.5 && cr.right > mr.left + 0.5 && cr.top < mr.bottom - 0.5 && cr.bottom > mr.top + 0.5
  return {
    inner: [innerWidth, innerHeight],
    doc: [de.clientWidth, de.scrollWidth, de.clientHeight, de.scrollHeight, de.scrollLeft || window.scrollX, window.scrollY],
    vv: { w: vv.width, h: vv.height, ox: vv.offsetLeft, oy: vv.offsetTop, scale: vv.scale },
    shell: box(q('.shell')),
    head: box(q('.chat-head')),
    title: box(q('#title')),
    scroll: [q('.scroll').clientWidth, q('.scroll').scrollWidth, q('.scroll').clientHeight, q('.scroll').scrollHeight],
    composer: box(q('.composer-wrap')),
    stats: box(q('.stats')),
    chip: box(chip),
    model: box(model),
    send: box(q('.send')),
    overlap,
    controls,
    wrap: getComputedStyle(q('.chat-head')).flexWrap,
  }
}
</script>
</body>
</html>`

type Box = { x: number; y: number; right: number; bottom: number; w: number; h: number }
type Measure = {
  inner: [number, number]
  doc: [number, number, number, number, number, number]
  vv: { w: number; h: number; ox: number; oy: number; scale: number }
  shell: Box
  head: Box
  title: Box
  scroll: [number, number, number, number]
  composer: Box
  stats: Box
  chip: Box
  model: Box
  send: Box
  overlap: boolean
  controls: { name: string; text: string; box: Box; hit: boolean | string }[]
  wrap: string
}

test('mobile header and composer stay inside the visual viewport', {
  skip: chrome ? false : 'Chrome is not installed',
  timeout: 90_000,
}, async () => {
  if (!chrome) return
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-layout-'))
  const html = join(dir, 'index.html')
  writeFileSync(html, page)
  const profile = join(dir, 'profile')
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let browserSocket = ''
  try {
    browserSocket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome did not open a DevTools port')), 15_000)
      proc.stderr.on('data', chunk => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      proc.on('exit', code => {
        clearTimeout(timer)
        reject(new Error(`Chrome exited before DevTools was ready (${code})`))
      })
    })
    const version = await (await fetch(httpVersion(browserSocket))).json()
    const browser = new Cdp(version.webSocketDebuggerUrl)
    await browser.open()
    const widths = [320, 360, 375, 390, 412, 1100, 1280]
    try {
      for (const width of widths) {
        const measured = await layoutAt(browser, html, width, 800, 'Skill-load inventory acceptance check', false)
        assertLayout(measured, width, false)
      }
      const longTitle = 'Skill-load inventory acceptance check '.repeat(8).trim()
      const narrow = await layoutAt(browser, html, 375, 800, longTitle, false)
      assertLayout(narrow, 375, false)
      assert.ok(narrow.title.w < narrow.shell.w, 'a long title ellipsizes inside the shell')
      const drawer = await layoutAt(browser, html, 375, 800, 'Skill-load inventory acceptance check', true)
      assertLayout(drawer, 375, true)
    } finally {
      browser.close()
    }
  } finally {
    proc.kill('SIGKILL')
    await new Promise(resolve => proc.once('exit', () => resolve(undefined)))
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    } catch {
      /* Chrome can release its profile after the process has exited. */
    }
  }
})

function assertLayout(data: Measure, width: number, drawerOpen: boolean) {
  const label = `${width}px${drawerOpen ? ' drawer' : ''}`
  assert.equal(data.wrap, 'wrap', label)
  assert.ok(data.doc[1] <= data.doc[0] + 1, `${label} document scrollWidth ${data.doc[1]} > clientWidth ${data.doc[0]}`)
  assert.equal(data.doc[4], 0, label)
  assert.equal(data.doc[5], 0, label)
  assert.ok(Math.abs(data.vv.ox) < 0.5, `${label} visual offsetLeft ${data.vv.ox}`)
  assert.ok(Math.abs(data.vv.oy) < 0.5, `${label} visual offsetTop ${data.vv.oy}`)
  assert.equal(data.vv.scale, 1, label)
  assert.ok(data.inner[0] <= width + 1, `${label} layout viewport grew to ${data.inner[0]}`)
  assert.ok(Math.abs(data.shell.bottom - data.vv.h) < 1, `${label} shell does not fill the visual viewport`)
  const gap = data.shell.bottom - data.stats.bottom
  assert.ok(gap >= 8 && gap <= 16, `${label} stats gap ${gap}`)
  assert.ok(Math.abs(data.composer.bottom - data.shell.bottom) < 1, label)
  assert.ok(data.scroll[3] > data.scroll[2], `${label} transcript does not scroll internally`)
  assert.ok(data.scroll[2] > 80, label)
  assert.equal(data.overlap, false, `${label} permission chip overlaps the model`)
  assert.ok(data.model.right <= data.shell.right + 0.5, label)
  assert.ok(data.send.right <= data.shell.right + 0.5 && data.send.w > 20, label)
  assert.ok(data.title.w >= 48, `${label} title collapsed to ${data.title.w}`)
  for (const control of data.controls) {
    const back = control.name === 'BUTTON.back'
    if (back && width >= 800) {
      assert.equal(control.box.w, 0, `${label} desktop keeps Sessions in the sidebar`)
      continue
    }
    assert.ok(control.box.w > 8 && control.box.h > 8, `${label} ${control.text} has no box`)
    assert.ok(
      control.box.x >= -0.5 && control.box.right <= data.shell.right + 0.5,
      `${label} ${control.text} escapes the shell`,
    )
    if (!drawerOpen) assert.equal(control.hit, true, `${label} ${control.text} is not hit-testable`)
  }
  if (width >= 1100) {
    const tops = data.controls.filter(control => control.box.w > 0).map(control => control.box.y)
    assert.ok(Math.max(...tops) - Math.min(...tops) < 4, `${label} header wrapped on desktop`)
  }
}

function httpVersion(socketUrl: string) {
  const url = new URL(socketUrl)
  return `http://${url.host}/json/version`
}

async function layoutAt(
  browser: Cdp,
  html: string,
  width: number,
  height: number,
  title: string,
  drawer: boolean,
): Promise<Measure> {
  const created = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targetId = created.targetId
  assert.ok(targetId)
  const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const sessionId = attached.sessionId
  assert.ok(sessionId)
  const send = (method: string, params: Record<string, unknown> = {}) => browser.send(method, params, sessionId)
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 800,
    })
    await send('Page.enable')
    await send('Page.navigate', { url: `file://${html}` })
    await send('Runtime.evaluate', {
      expression: `document.fonts.ready.then(() => { document.getElementById('title').textContent = ${JSON.stringify(title)}; for (const id of ['drawer', 'settings']) { const el = document.getElementById(id); el.hidden = false; el.style.display = ${drawer ? "''" : "'none'"}; } })`,
      awaitPromise: true,
    })
    const result = await send('Runtime.evaluate', { expression: 'measure()', returnByValue: true })
    const value = result.result?.value
    assert.ok(value, JSON.stringify(result))
    assert.equal(result.result?.subtype, undefined, JSON.stringify(result))
    return value
  } finally {
    await browser.send('Target.closeTarget', { targetId })
  }
}

class Cdp {
  url: string
  next = 1
  pending = new Map<number, { resolve: (value: CdpResult) => void; reject: (error: Error) => void }>()
  ws: WebSocket | null = null

  constructor(url: string) {
    this.url = url
  }

  open() {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: CdpResult; error?: unknown }
      if (message.id == null) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result ?? {})
    })
    return new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = this.next++
    const ws = this.ws
    if (!ws) return Promise.reject(new Error('DevTools socket is closed'))
    return new Promise<CdpResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const message: { id: number; method: string; params: Record<string, unknown>; sessionId?: string } = {
        id,
        method,
        params,
      }
      if (sessionId) message.sessionId = sessionId
      ws.send(JSON.stringify(message))
    })
  }

  close() {
    this.ws?.close()
  }
}

type CdpResult = {
  targetId?: string
  sessionId?: string
  result?: { subtype?: string; value?: Measure }
  [key: string]: unknown
}
