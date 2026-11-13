import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { openStore } from './store.ts'
import { createEngine } from './engine.ts'
import { createMockWorld } from './work-mock.ts'
import { createWorkRuntime } from './work-worker.ts'
import { handleWorkApi } from './work-http.ts'

/**
 * Loopback mock of the native inbox. It is not the workbench and not a real DSH host.
 * @param {{ dataDir: string, port?: number, now?: () => Date }} options
 */
export async function startWorkMock(options: { dataDir: string; port?: number; now?: () => Date }) {
  const store = openStore(options.dataDir)
  const engine = createEngine(store)
  const world = createMockWorld()
  const clock = { ms: Date.now() }
  const now = options.now ?? (() => new Date(clock.ms))
  const work = createWorkRuntime(store, engine, {
    createChild: spec => world.createChild(spec),
    push: (sessionId, messageId, text) => world.push(sessionId, messageId, text),
    logHas: (sessionId, messageId) => world.logHas(sessionId, messageId),
    remove: (sessionId, messageId) => world.remove(sessionId, messageId),
    pendingIds: sessionId => world.pendingIds(sessionId),
    cancel: (sessionId, cancelOptions) => world.cancel(sessionId, cancelOptions),
    snapshot: sessionId => world.snapshot(sessionId),
    childPresent: sessionId => world.hasSession(sessionId),
    now,
    pid: process.pid,
  })
  const server = createServer(async (req, res) => {
    const remote = req.socket.remoteAddress ?? ''
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      send(res, 403, { ok: false, code: 'FORBIDDEN' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      const body = req.method === 'GET' ? {} : await readJson(req)
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/mark') {
        const binding = engine.markBot(String(body.sessionId ?? ''))
        send(res, 200, { ok: true, kind: 'bot', sessionId: binding.session_id })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/plain') {
        const binding = engine.ensureSession(String(body.sessionId ?? ''))
        send(res, 200, { ok: true, kind: binding.kind, sessionId: binding.session_id })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/user-message') {
        const messageId = world.postUser(String(body.sessionId), String(body.text ?? ''))
        send(res, 200, { ok: true, messageId, pending: world.pendingIds(String(body.sessionId)) })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/claim') {
        const claimed = world.claim(String(body.sessionId))
        if (claimed) work.observeClaimed(String(body.sessionId), claimed.messageId, claimed.turn)
        send(res, 200, { ok: true, claimed, ticketStatus: statusOf(work, body.ticketId) })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/user-seen') {
        const event = world.seeUser(String(body.sessionId), String(body.messageId), Number(body.turn ?? 1))
        work.observeSession(String(body.sessionId), event)
        send(res, 200, { ok: true, seq: event.seq, ticketStatus: statusOf(work, body.ticketId) })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/turn-end') {
        const event = world.endTurn(
          String(body.sessionId),
          Number(body.turn ?? 1),
          String(body.reasonKind ?? 'completed'),
        )
        work.observeSession(String(body.sessionId), event)
        send(res, 200, { ok: true, ticketStatus: statusOf(work, body.ticketId) })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/assistant') {
        if (body.tool && typeof body.tool === 'object') {
          world.toolCall(String(body.sessionId), String(body.tool.name ?? ''), body.tool.arguments ?? {})
        }
        const event = world.assistant(String(body.sessionId), String(body.text ?? ''))
        await work.tick()
        send(res, 200, { ok: true, seq: event.seq, ticketStatus: statusOf(work, body.ticketId) })
        return
      }
      if (req.method === 'POST' && path === '/session-foundations/api/work/mock/clock') {
        clock.ms = Date.parse(String(body.iso))
        send(res, 200, { ok: true, iso: new Date(clock.ms).toISOString() })
        return
      }
      if (req.method === 'GET' && path === '/session-foundations/api/work/mock/inbox') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        send(res, 200, {
          ok: true,
          pending: world.pendingIds(sessionId),
          events: world.events(sessionId),
          cancels: world.cancels,
        })
        return
      }
      const handled = await handleWorkApi(req.method ?? 'GET', path, url, body, work)
      if (!handled) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' })
        return
      }
      send(res, handled.status, handled.body)
    } catch (error) {
      send(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          try {
            store.close()
          } catch {
            /* closed */
          }
          resolve()
        })
      }),
  }
}

/**
 * @param {ReturnType<typeof import('./work-worker.js').createWorkRuntime>} work
 * @param {unknown} ticketId
 */
function statusOf(work: ReturnType<typeof import('./work-worker.ts').createWorkRuntime>, ticketId: unknown) {
  if (typeof ticketId !== 'string' || ticketId === '') return null
  return work.detail(ticketId)?.ticket.status ?? null
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function readJson(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = []
    req.on('data', (chunk: any) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

const isMain = process.argv[1] && /work-mock-host\.(?:js|ts)$/.test(process.argv[1])
if (isMain) {
  const portFlag = process.argv.indexOf('--port')
  const dirFlag = process.argv.indexOf('--data-dir')
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 31993
  const dataDir = dirFlag >= 0 ? process.argv[dirFlag + 1] : ''
  if (dataDir === '') {
    console.error('pass --data-dir')
    process.exit(1)
  }
  mkdirSync(dataDir, { recursive: true })
  const started = await startWorkMock({ dataDir, port })
  console.log(JSON.stringify({ ok: true, mock: true, realLlm: false, origin: started.origin, dataDir }))
}
