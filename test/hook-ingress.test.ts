import { createHmac } from 'node:crypto'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { registerHttp } from '../src/http.ts'
import { openStore } from '../src/store.ts'
import { createTriggers } from '../src/triggers.ts'

function bindBot(store: ReturnType<typeof openStore>, sessionId: string) {
  const stamp = new Date().toISOString()
  store.db
    .prepare(
      `
      INSERT INTO session_bindings (
        session_id, kind, status, schema_version, fork_seeded, last_view_revision, compaction_epoch, created_at, updated_at
      ) VALUES (?, 'bot', 'active', 1, 0, 0, 0, ?, ?)
    `,
    )
    .run(sessionId, stamp, stamp)
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

test('a signed hook is accepted without a session cookie, and management routes are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-hook-ingress-'))
  const store = openStore(dir)
  bindBot(store, 'session-hook')
  const pushed: string[] = []
  const triggers = createTriggers(store, {
    secretDir: dir,
    push: async (_sessionId, messageId, text) => {
      pushed.push(`${messageId}\n${text}`)
      return { ok: true, seq: pushed.length, ambiguous: false }
    },
  })
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  registerHttp(
    {
      effect: (fn: () => void) => {
        fn()
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
    } as never,
    createEngine(store),
    () => triggers,
    () => null,
    dir,
  )
  const handler = routes.find(route => route.path === '/session-foundations')!.handler
  const { server, origin } = await listen(handler)
  const registered = triggers.registerWebhook('session-hook')
  assert.equal(registered.ok, true)
  const hook = registered.hook
  const secret = readFileSync(hook.secretFile, 'utf8')
  const sign = (raw: Buffer, timestamp: string) =>
    createHmac('sha256', secret)
      .update(`${timestamp}.${raw.toString('utf8')}`)
      .digest('hex')
  const post = (id: string, raw: Buffer, headers: Record<string, string>) =>
    fetch(`${origin}/session-foundations/hooks/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: new Uint8Array(raw),
    })
  try {
    const raw = Buffer.from('{"event":"mail.stored","id":"m1"}')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const denied = await post(hook.id, raw, {
      'x-foundations-timestamp': timestamp,
      'x-foundations-signature': '00',
      'x-foundations-event-id': 'm1',
      cookie: 'dsh=expired',
    })
    assert.equal(denied.status, 401)
    assert.equal(pushed.length, 0)
    const accepted = await post(hook.id, raw, {
      'x-foundations-timestamp': timestamp,
      'x-foundations-signature': sign(raw, timestamp),
      'x-foundations-event-id': 'm1',
      cookie: 'dsh=expired',
    })
    assert.equal(accepted.status, 202)
    const receipt = store.db
      .prepare('SELECT delivery_id FROM webhook_receipts WHERE hook_id = ? AND event_id = ?')
      .get(hook.id, 'm1') as { delivery_id: string }
    assert.equal(typeof receipt.delivery_id, 'string')
    assert.equal(pushed.length, 1)
    assert.match(pushed[0], /untrusted/)
    const replay = await post(hook.id, raw, {
      'x-foundations-timestamp': timestamp,
      'x-foundations-signature': sign(raw, timestamp),
      'x-foundations-event-id': 'm1',
    })
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).duplicate, true)
    assert.equal(pushed.length, 1)

    const fetched = await fetch(`${origin}/session-foundations/hooks/${hook.id}`)
    assert.equal(fetched.status, 401)
    const managed = await fetch(`${origin}/session-foundations/api/webhooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-foundations-timestamp': timestamp,
        'x-foundations-signature': sign(raw, timestamp),
        'x-foundations-event-id': 'nope',
      },
      body: JSON.stringify({ sessionId: 'session-hook' }),
    })
    assert.equal(managed.status, 401)
    const timers = await fetch(`${origin}/session-foundations/api/timers`, { method: 'POST', body: '{}' })
    assert.equal(timers.status, 401)
    const owned = await fetch(`${origin}/session-foundations/api/timers`, {
      method: 'POST',
      headers: { authorization: 'test-owner', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.notEqual(owned.status, 401)
    const huge = await post(hook.id, Buffer.alloc(70_000, 1), {
      'x-foundations-timestamp': timestamp,
      'x-foundations-signature': '00',
      'x-foundations-event-id': 'huge',
    })
    assert.equal(huge.status, 413)
    const stored = store.db.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get() as { n: number }
    assert.equal(stored.n, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    rmSync(dir, { recursive: true, force: true })
  }
})
