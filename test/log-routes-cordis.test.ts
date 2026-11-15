import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createEngine } from '../src/engine.ts'
import { attachedSession, registerHttp, unloadAttachedSession } from '../src/http.ts'
import { inject as httpInject } from '../src/http-plugin.ts'
import { createLogSnapshotService } from '../src/log/snapshot-service.ts'
import { createLogSource } from '../src/log/source.ts'
import { registerLogRoutes } from '../src/log/routes.ts'
import { openStore } from '../src/store.ts'

/**
 * The HTTP plugin injects webServer and sessionQuery, but not connection.
 * Accessing ctx.connection on that fiber throws; ctx.get('connection') does not.
 */
test('a Cordis plugin that does not inject connection still mounts log and management routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cordis-http-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const routes: Array<{ path: string; handler: (req: any, res: any) => unknown }> = []
  const root = new Context()
  root.provide('webServer', {
    register(route: { path: string; handler: (req: any, res: any) => unknown }) {
      routes.push(route)
      return () => {}
    },
  })
  root.provide('agents', {})
  root.provide('sessionPersistence', {})
  root.provide('sessionQuery', {
    async observeSession() {
      return { events: [], cursor: -1, [Symbol.dispose]() {} }
    },
  })
  // Hosts attach this as a context field, not an injected service.
  ;(root as any).profileContext = { dir }

  let logOnConnection: boolean | undefined
  const fiber = await root.plugin({
    name: 'session-foundations-http-probe',
    inject: ['webServer', 'agents', 'sessionPersistence', 'sessionQuery'],
    apply(ctx: Context) {
      assert.throws(() => (ctx as any).connection, /cannot get property "connection" without inject/)
      assert.equal(ctx.get('connection'), undefined)
      const service = createLogSnapshotService(createLogSource(ctx as any))
      logOnConnection = registerLogRoutes(ctx as any, service)
      registerHttp(
        ctx as any,
        engine,
        () => null,
        () => null,
        '',
      )
    },
  })

  try {
    assert.equal(logOnConnection, false)
    assert.deepEqual(
      routes.map(route => route.path).sort(),
      ['/api/dsh-bot', '/dsh-bot', '/session-foundations'].sort(),
    )
    const handler = (path: string) => {
      const route = routes.find(entry => path === entry.path || path.startsWith(`${entry.path}/`))
      assert.ok(route, `no handler for ${path}`)
      return route!.handler
    }
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      void handler(path)(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      const probe = await fetch(`${origin}/api/dsh-bot/log/range`, { method: 'HEAD' })
      assert.equal(probe.status, 200)
      const missing = await fetch(`${origin}/api/dsh-bot/log/manifest`)
      assert.equal(missing.status, 400)
      const marked = await fetch(`${origin}/session-foundations/api/sessions/mark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-cordis-mark' }),
      })
      assert.equal(marked.status, 200)
      const body = (await marked.json()) as { ok?: boolean; sessionId?: string }
      assert.equal(body.ok, true)
      assert.equal(body.sessionId, 'session-cordis-mark')
      assert.equal(engine.isBot('session-cordis-mark'), true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    }
  } finally {
    await fiber.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the http plugin injects sessions and can tell a live session from a cold one', async () => {
  assert.ok(httpInject.includes('sessions'))
  const root = new Context()
  root.provide('sessions', {
    get(id: string) {
      return id === 'session-live' ? { id } : undefined
    },
  })
  const fiber = await root.plugin({
    name: 'session-lookup',
    inject: ['sessions'],
    apply(ctx: Context) {
      assert.equal(attachedSession(ctx as never, 'session-live'), true)
      assert.equal(attachedSession(ctx as never, 'session-cold'), false)
    },
  })
  await fiber.dispose()
})

test('unload closes the writer and detaches the live session before its files can be removed', async () => {
  const order: string[] = []
  const sessions = new Map<string, { detach(): void }>()
  const sessionEntry = {
    detach() {
      order.push('session')
      sessions.delete('session-live')
    },
  }
  sessions.set('session-live', sessionEntry)
  const agentEntry = { id: 'session-live', agent: { id: 'session-live' } }
  const agents = new Map<string, typeof agentEntry>([['session-live', agentEntry]])
  const ctx = {
    sessions: {
      store: sessions,
      get(id: string) {
        return sessions.get(id)
      },
    },
    agents: {
      store: agents,
      get(id: string) {
        return agents.get(id)?.agent
      },
      detachEntered(entry: { id: string }) {
        order.push('agent')
        agents.delete(entry.id)
      },
    },
    sessionPersistence: {
      tracker: {
        writers: new Map([
          [
            'session-live',
            {
              close: async () => {
                order.push('writer')
              },
            },
          ],
        ]),
      },
    },
  }
  await unloadAttachedSession(ctx as never, 'session-live')
  assert.deepEqual(order, ['writer', 'agent', 'session'])
  assert.equal(attachedSession(ctx as never, 'session-live'), false)
})
