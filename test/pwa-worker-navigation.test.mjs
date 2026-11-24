import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildShell } from '../ui/pwa/build-shell.mjs'

/**
 * Run the generated worker against a fake environment.
 *
 * This is the regression test for the bug that broke automatic sign-in: a document
 * navigation must never be answered from the shell when the network has something
 * to say about it. The worker only has to recognise a network redirect and hand it
 * to the browser; who owns authentication is not the worker's business.
 */
const HTML = `<!doctype html><html><head><title>shell</title></head><body><div id="root"></div></body></html>`

function shellBytes() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-sw-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), HTML)
  writeFileSync(join(dir, 'assets/index-abc.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'assets/index-abc.css'), 'body{}\n')
  return dir
}

/** A network answer shaped like a Response, without Node's read-only `redirected`. */
function answer({ status = 200, body = '', redirected = false, url = 'https://bot.example/dsh-bot/' } = {}) {
  return {
    status,
    redirected,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    async text() {
      return body
    },
  }
}

function loadWorker(dir, options = {}) {
  const source = readFileSync(join(dir, 'sw.js'), 'utf8')
  const listeners = new Map()
  const stored = new Map()
  const sandbox = {
    console,
    URL,
    Headers,
    Request,
    Response,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    fetch: options.fetch,
    caches: {
      async open(name) {
        const bucket = stored.get(name) ?? new Map()
        stored.set(name, bucket)
        return {
          async match(key) {
            return bucket.get(String(key))
          },
          async put(key, response) {
            bucket.set(String(key), response)
          },
          async keys() {
            return [...bucket.keys()].map(key => new Request(String(key)))
          },
        }
      },
      async keys() {
        return [...stored.keys()]
      },
      async delete(name) {
        stored.delete(name)
      },
    },
    self: {
      location: { origin: 'https://bot.example' },
      clients: {
        async matchAll() {
          return []
        },
        async claim() {},
      },
      skipWaiting() {},
      addEventListener(type, handler) {
        listeners.set(type, handler)
      },
    },
  }
  sandbox.self.caches = sandbox.caches
  sandbox.self.fetch = options.fetch
  sandbox.self.console = console
  runInNewContext(source, sandbox, { filename: 'sw.js' })
  return { listeners, stored }
}

async function navigate(listeners, url, requestInit = {}) {
  let answered
  const event = {
    request: new Request(url, { method: 'GET', ...init(requestInit) }),
    respondWith(value) {
      answered = Promise.resolve(value)
    },
  }
  listeners.get('fetch')(event)
  return answered
}

function init(requestInit) {
  return requestInit
}

function seedShell(stored, releaseId) {
  const bucket = new Map()
  bucket.set('/dsh-bot/index.html', new Response(HTML, { headers: { 'content-type': 'text/html' } }))
  stored.set(`dsh-bot-shell-${releaseId}`, bucket)
}

test('a redirected navigation is handed to the browser so authentication can run', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    const worker = loadWorker(dir, {
      fetch: async () =>
        answer({
          status: 200,
          redirected: true,
          url: 'https://thready.cloudflareaccess.com/cdn-cgi/access/login/bot.example',
        }),
    })
    seedShell(worker.stored, plan.releaseId)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    assert.equal(response.status, 302)
    assert.equal(
      response.headers.get('location'),
      'https://thready.cloudflareaccess.com/cdn-cgi/access/login/bot.example',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a 200 interstitial page is returned unchanged instead of the cached shell', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    const bounce =
      '<!doctype html><meta http-equiv="refresh" content="2;url=/trial-login?next=%2Fdsh-bot%2F">' +
      '<script>location.replace("/trial-login?next="+encodeURIComponent(location.pathname))</script>'
    const worker = loadWorker(dir, { fetch: async () => answer({ body: bounce }) })
    seedShell(worker.stored, plan.releaseId)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    const body = await response.text()
    assert.ok(body.includes('/trial-login?next='), 'the bounce must reach the browser')
    assert.equal(body.includes('<title>shell</title>'), false, 'the cached shell must not win')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ordinary authorized navigation returns the network document', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    const worker = loadWorker(dir, { fetch: async () => answer({ body: '<html>fresh</html>' }) })
    seedShell(worker.stored, plan.releaseId)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    assert.equal(await response.text(), '<html>fresh</html>')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a navigation that cannot reach the network falls back to the cached shell', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    const worker = loadWorker(dir, {
      fetch: async () => {
        throw new TypeError('offline')
      },
    })
    seedShell(worker.stored, plan.releaseId)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    assert.equal(await response.text(), HTML)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('server errors are shown, not replaced by the shell', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    const worker = loadWorker(dir, { fetch: async () => answer({ status: 500, body: 'boom' }) })
    seedShell(worker.stored, plan.releaseId)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    assert.equal(response.status, 500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the worker asks the origin without following anything itself, and keeps the request URL', async () => {
  const dir = shellBytes()
  try {
    await buildShell(dir)
    const seen = []
    const worker = loadWorker(dir, {
      fetch: async (url, init) => {
        seen.push({ url, redirect: init?.redirect })
        return answer({ body: '<html>fresh</html>' })
      },
    })
    await navigate(worker.listeners, 'https://bot.example/dsh-bot/')
    assert.equal(seen[0].url, 'https://bot.example/dsh-bot/')
    assert.equal(seen[0].redirect, 'follow')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the API stays untouched by the worker', async () => {
  const dir = shellBytes()
  try {
    await buildShell(dir)
    let probed = false
    const worker = loadWorker(dir, {
      fetch: async () => {
        probed = true
        return answer({ body: '{}' })
      },
    })
    const answered = await navigate(worker.listeners, 'https://bot.example/dsh-bot/api/sessions')
    assert.equal(answered, undefined, 'the worker must not answer API requests')
    assert.equal(probed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assets still come from the shell bucket before the network', async () => {
  const dir = shellBytes()
  try {
    const plan = await buildShell(dir)
    let hits = 0
    const worker = loadWorker(dir, {
      fetch: async () => {
        hits += 1
        return answer({ body: 'network' })
      },
    })
    const bucket = worker.stored.get(`dsh-bot-shell-${plan.releaseId}`) ?? new Map()
    bucket.set('/dsh-bot/assets/index-abc.js', new Response('cached-js', { status: 200 }))
    worker.stored.set(`dsh-bot-shell-${plan.releaseId}`, bucket)
    const response = await navigate(worker.listeners, 'https://bot.example/dsh-bot/assets/index-abc.js')
    assert.equal(await response.text(), 'cached-js')
    assert.equal(hits, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
