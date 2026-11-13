import { toolError } from './errors.ts'
import { diffValue } from './live-diff.ts'

type LiveRequest = {
  socket?: { setTimeout(msecs: number, callback?: () => void): unknown } | null
  on(event: string, listener: (...args: any[]) => void): unknown
}

type LiveResponse = {
  socket?: { setTimeout(msecs: number, callback?: () => void): unknown } | null
  readonly writableEnded: boolean
  status?: number
  headers?: Record<string, unknown> | null
  writeHead(statusCode: number, headers?: Record<string, string>): unknown
  write(chunk: string): unknown
  end(chunk?: unknown): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
}

/**
 * One server-sent frame. An unchanged stamp sends nothing.
 * @param {{ liveStamp: () => string, liveBoard: (sessionId: string) => unknown }} work
 * @param {string} sessionId
 * @param {string | null} previousStamp
 */
export function nextLiveFrame(
  work: { liveStamp: () => string; liveBoard: (sessionId: string) => unknown },
  sessionId: string,
  previousStamp: string | null,
) {
  const stamp = work.liveStamp()
  if (previousStamp !== null && stamp === previousStamp) return { stamp, frame: '' }
  const body = work.liveBoard(sessionId)
  return { stamp, frame: `event: snapshot\ndata: ${JSON.stringify(body)}\n\n` }
}

/**
 * Holds the response open. The caller waits until the client disconnects.
 * A 1s stamp check is in-process; the browser does not re-fetch tickets.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} sessionId
 * @param {{ liveStamp: () => string, liveBoard: (sessionId: string) => unknown }} work
 */
export function openWorkLive(
  req: LiveRequest,
  res: LiveResponse,
  sessionId: string,
  work: { liveStamp: () => string; liveBoard: (sessionId: string) => unknown },
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  req.socket?.setTimeout(0)
  res.socket?.setTimeout(0)
  res.write(`:${' '.repeat(2048)}\n\n`)
  let stopped = false
  /** @type {string | null} */
  let stamp: string | null = null
  let quiet = 0
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    if (!res.writableEnded) res.end()
  }
  const pump = () => {
    if (stopped) return
    try {
      const next = nextLiveFrame(work, sessionId, stamp)
      stamp = next.stamp
      if (next.frame !== '') {
        quiet = 0
        res.write(next.frame)
        return
      }
      quiet += 1
      if (quiet >= 15) {
        quiet = 0
        res.write(': ping\n\n')
      }
    } catch {
      stop()
    }
  }
  pump()
  timer = setInterval(pump, 1000)
  timer.unref?.()
  req.on('close', stop)
  res.on('error', stop)
  return new Promise(resolve => {
    req.on('close', () => resolve(undefined))
  })
}

/**
 * First sight of a side is a snapshot. Later sights are the patch from the last frame.
 * @param {'desk' | 'work'} name
 * @param {unknown} previous
 * @param {unknown} value
 */
function frameFor(name: 'desk' | 'work', previous: unknown, value: unknown) {
  if (previous === undefined) {
    return {
      stored: cloneJson(value),
      frame: `event: snapshot\ndata: ${JSON.stringify({ ok: true, [name]: value })}\n\n`,
    }
  }
  const patch = diffValue(previous, value)
  if (!patch) return { stored: previous, frame: '' }
  return {
    stored: cloneJson(value),
    frame: `event: delta\ndata: ${JSON.stringify({ ok: true, [name]: patch })}\n\n`,
  }
}

/**
 * @param {unknown} value
 */
function cloneJson(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * One stream for the whole desk. Work is checked every second; the host list
 * is checked on deskIntervalMs. The first frame of each side is the whole object.
 * A later frame of that side is only the patch against the previous one.
 * This stream does not cut the page with FastCDC. Session history uses the
 * snapshot routes, and new session events stay event records.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   workStamp: () => string,
 *   workBoard: () => unknown,
 *   loadDesk: () => Promise<unknown>,
 *   deskIntervalMs?: number,
 *   intervalMs?: number,
 * }} source
 */
export function openPageLive(
  req: LiveRequest,
  res: LiveResponse,
  source: {
    workStamp: () => string
    workBoard: () => unknown
    loadDesk: () => Promise<unknown>
    interactions?: () => unknown
    deskIntervalMs?: number
    intervalMs?: number
  },
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  req.socket?.setTimeout(0)
  res.socket?.setTimeout(0)
  res.write(`:${' '.repeat(2048)}\n\n`)
  let stopped = false
  let busy = false
  /** @type {string | null} */
  let workStamp: string | null = null
  /** @type {unknown} */
  let sentWork: unknown
  /** @type {unknown} */
  let sentDesk: unknown
  let lastDesk = 0
  let quiet = 0
  const deskIntervalMs = source.deskIntervalMs ?? 8000
  const intervalMs = source.intervalMs ?? 1000
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer: ReturnType<typeof setInterval> | null = null
  let interactionTimer: ReturnType<typeof setInterval> | null = null
  let lastInteractions = ''
  let interactionFailed = false
  const pumpInteractions = () => {
    if (stopped || !source.interactions) return
    try {
      const text = JSON.stringify(source.interactions())
      if (text === lastInteractions && !interactionFailed) return
      interactionFailed = false
      lastInteractions = text
      res.write(`event: interactions\ndata: ${text}\n\n`)
    } catch {
      // Downgrade the client to REST fallback without closing desk/work updates.
      if (!interactionFailed) {
        interactionFailed = true
        res.write('event: interaction-error\ndata: {}\n\n')
      }
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    if (interactionTimer) clearInterval(interactionTimer)
    if (!res.writableEnded) res.end()
  }
  const pump = async () => {
    if (stopped || busy) return
    busy = true
    try {
      /** @type {string} */
      let deskFrame: string = ''
      /** @type {string} */
      let workFrame: string = ''
      const stamp = source.workStamp()
      if (stamp !== workStamp) {
        workStamp = stamp
        const next = frameFor('work', sentWork, source.workBoard())
        sentWork = next.stored
        workFrame = next.frame
      }
      if (lastDesk === 0 || Date.now() - lastDesk >= deskIntervalMs) {
        lastDesk = Date.now()
        try {
          const desk = await source.loadDesk()
          if (stopped) return
          const next = frameFor('desk', sentDesk, desk)
          sentDesk = next.stored
          deskFrame = next.frame
        } catch {
          // A host list failure leaves the ticket stream open.
        }
      }
      if (deskFrame !== '' || workFrame !== '') {
        quiet = 0
        if (deskFrame !== '') res.write(deskFrame)
        if (workFrame !== '') res.write(workFrame)
        return
      }
      quiet += 1
      if (quiet >= 15) {
        quiet = 0
        res.write(': ping\n\n')
      }
    } catch {
      stop()
    } finally {
      busy = false
    }
  }
  pumpInteractions()
  if (source.interactions) {
    interactionTimer = setInterval(pumpInteractions, intervalMs)
    interactionTimer.unref?.()
  }
  void pump()
  timer = setInterval(() => {
    void pump()
  }, intervalMs)
  timer.unref?.()
  req.on('close', stop)
  res.on('error', stop)
  return new Promise(resolve => {
    req.on('close', () => resolve(undefined))
  })
}

/**
 * Loopback JSON for the ticket protocol. This does not serve the workbench.
 * @param {string} method
 * @param {string} path
 * @param {URL} url
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof import('./work-worker.js').createWorkRuntime> | null} work
 */
export async function handleWorkApi(
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown>,
  work: ReturnType<typeof import('./work-worker.ts').createWorkRuntime> | null,
) {
  if (!path.startsWith('/session-foundations/api/work')) return null
  if (!work) return { status: 503, body: toolError('UNAVAILABLE', 'The work host is not attached yet.') }
  if (method === 'GET' && path === '/session-foundations/api/work/tickets') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') return { status: 400, body: toolError('VALIDATION', 'sessionId is required.') }
    return { status: 200, body: { ok: true, tickets: work.summaries(sessionId) } }
  }
  if (method === 'GET' && path === '/session-foundations/api/work/ticket') {
    const id = url.searchParams.get('id') ?? ''
    const found = work.detail(id)
    if (!found) return { status: 404, body: toolError('NOT_FOUND', 'No such ticket.') }
    return { status: 200, body: { ok: true, ...found } }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/tick') {
    await work.tick()
    return { status: 200, body: { ok: true } }
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return { status: 400, body: toolError('VALIDATION', 'sessionId is required.') }
  if (method === 'POST' && path === '/session-foundations/api/work/hold') {
    const result = work.holdNotices(sessionId)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/release') {
    const result = work.releaseHold(sessionId)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/dispatch') {
    const result = await work.dispatch(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/supply') {
    const result = await work.supply(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/redirect') {
    const result = await work.redirect(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/cancel') {
    const result = await work.cancelTicket(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/retry') {
    const result = await work.retry(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/publish') {
    const result = await work.publish(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/reject') {
    const result = await work.reject(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  if (method === 'POST' && path === '/session-foundations/api/work/report') {
    const result = await work.report(sessionId, body)
    return { status: result.ok === false ? 400 : 200, body: result }
  }
  return null
}
