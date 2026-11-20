/**
 * Chat cards are plugin records on the owner session.
 * appendPluginRecord assigns the seq and does not wake a turn.
 * A session that is not entered keeps a pending row until flush.
 *
 * The desk and this plugin can each load @deepseek-ai/dsh-session.
 * appendPluginRecord only accepts a Session from its own module, so the
 * append below is taken from the module that constructed the live session.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { CanvasPublished, CanvasStore } from './canvas-store.ts'
import type { HostContext } from './host.ts'
import type { SqlDatabase } from './store.ts'

export const WORKER_CARD = 'plugin:foundations/worker'
export const CANVAS_CARD = 'plugin:foundations/canvas'
export const APPROVAL_CARD = 'plugin:foundations/approval'

export interface WorkerCardRecord {
  ticketId: string
  summary: string
  status: string
}

export interface CanvasCardRecord {
  canvasId: string
  revision: number
  kind: 'snapshot' | 'delta'
  title: string
  ticketId: string | null
}

export interface ApprovalCardRecord {
  requestId: string
  toolName: string
  reason: string
  callId?: string
}

export type CardRequest =
  | { kind: 'worker'; key: string; sessionId: string; payload: WorkerCardRecord }
  | { kind: 'canvas'; key: string; sessionId: string; payload: CanvasCardRecord }
  | { kind: 'approval'; key: string; sessionId: string; payload: ApprovalCardRecord }

const RECORD_TYPE = {
  worker: WORKER_CARD,
  canvas: CANVAS_CARD,
  approval: APPROVAL_CARD,
} as const

type CardAppender = {
  session(ctx: HostContext, sessionId: string): Session | null
  append(session: Session, type: string, data: unknown): number
}

const logs = new Map<string, CardLog>()

export function publishCardLog(dataDir: string, log: CardLog | null) {
  if (log) logs.set(dataDir, log)
  else logs.delete(dataDir)
}

export function cardLogFor(dataDir: string) {
  return logs.get(dataDir) ?? null
}

export function createCardLog(db: SqlDatabase, appender: CardAppender = hostAppender): CardLog {
  return new CardLog(db, appender)
}

export function bindCanvasCards(canvas: CanvasStore, ctx: HostContext, dataDir: string) {
  return canvas.onPublished(event => {
    const cards = cardLogFor(dataDir)
    if (!cards) return
    cards.record(ctx, canvasRequest(event))
  })
}

export function backlogCanvases(canvas: CanvasStore, ctx: HostContext, dataDir: string) {
  const cards = cardLogFor(dataDir)
  if (!cards) return
  for (const event of canvas.publishedPreviews()) {
    if (event.sessionId === '') continue
    cards.record(ctx, canvasRequest(event))
  }
}

export function canvasRequest(event: CanvasPublished): CardRequest {
  return {
    kind: 'canvas',
    key: `${event.canvasId}:${event.revision}`,
    sessionId: event.sessionId,
    payload: {
      canvasId: event.canvasId,
      revision: event.revision,
      kind: event.kind,
      title: event.title,
      ticketId: event.ticketId,
    },
  }
}

type AppendRecord = (session: Session, type: string, data: unknown) => number

const localAppend = appendPluginRecord as AppendRecord
const appendByClass = new WeakMap<Function, AppendRecord>()
let appendFailureLogged = false

/** Append with the dsh-session module that owns this Session instance. */
export function appendCardRecord(session: Session, type: string, data: unknown): number {
  return appenderFor(session)(session, type, data)
}

const hostAppender: CardAppender = {
  session: liveSession,
  append: appendCardRecord,
}

export class CardLog {
  db: SqlDatabase
  appender: CardAppender

  constructor(db: SqlDatabase, appender: CardAppender) {
    this.db = db
    this.appender = appender
  }

  /** One record per key. A later call returns the seq already stored. */
  record(ctx: HostContext, request: CardRequest): number | null {
    const existing = this.db
      .prepare('SELECT seq FROM card_log WHERE kind = ? AND key = ?')
      .get(request.kind, request.key)
    if (typeof existing?.seq === 'number') return existing.seq
    this.db
      .prepare(
        `INSERT INTO card_log (kind, key, session_id, payload, seq) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(kind, key) DO UPDATE SET
           session_id = excluded.session_id,
           payload = excluded.payload
         WHERE card_log.seq IS NULL`,
      )
      .run(request.kind, request.key, request.sessionId, JSON.stringify(request.payload))
    return this.commit(ctx, request.kind, request.key, request.sessionId)
  }

  flush(ctx: HostContext) {
    const rows = this.db.prepare('SELECT kind, key, session_id FROM card_log WHERE seq IS NULL').all() as Array<{
      kind: string
      key: string
      session_id: string
    }>
    for (const row of rows) {
      if (row.kind !== 'worker' && row.kind !== 'canvas' && row.kind !== 'approval') continue
      this.commit(ctx, row.kind, row.key, row.session_id)
    }
  }

  private commit(ctx: HostContext, kind: CardRequest['kind'], key: string, sessionId: string): number | null {
    const row = this.db.prepare('SELECT payload, seq FROM card_log WHERE kind = ? AND key = ?').get(kind, key) as
      | { payload?: string; seq?: number | null }
      | undefined
    if (!row) return null
    if (typeof row.seq === 'number') return row.seq
    const session = this.appender.session(ctx, sessionId)
    if (!session || typeof row.payload !== 'string') return null
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      return null
    }
    let seq: number
    try {
      seq = this.appender.append(session, RECORD_TYPE[kind], payload)
    } catch (error) {
      logAppendFailure(ctx, error)
      return null
    }
    if (!Number.isInteger(seq) || seq < 0) return null
    this.db.prepare('UPDATE card_log SET seq = ? WHERE kind = ? AND key = ? AND seq IS NULL').run(seq, kind, key)
    return seq
  }
}

function appenderFor(session: Session): AppendRecord {
  const ctor = session.constructor
  if (typeof ctor !== 'function') return localAppend
  const cached = appendByClass.get(ctor)
  if (cached) return cached
  const append = appendFromSessionModule(session) ?? localAppend
  appendByClass.set(ctor, append)
  return append
}

function appendFromSessionModule(session: Session): AppendRecord | null {
  const file = sessionModuleFile(session)
  if (!file) return null
  try {
    const loaded = createRequire(file)(file) as { appendPluginRecord?: unknown }
    if (typeof loaded.appendPluginRecord !== 'function') return null
    return loaded.appendPluginRecord as AppendRecord
  } catch {
    return null
  }
}

function sessionModuleFile(session: object): string | null {
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'seq')?.get
  if (typeof getter !== 'function') return null
  const previous = Error.prepareStackTrace
  Error.prepareStackTrace = (_error, sites) => sites
  let file: string | null = null
  try {
    getter.call(
      new Proxy(Object.create(Object.getPrototypeOf(session)), {
        get() {
          throw new Error('session-module')
        },
      }),
    )
  } catch (error) {
    const sites = (error as { stack?: NodeJS.CallSite[] }).stack
    if (!Array.isArray(sites)) return file
    const owner = sites.find(site => site.getFileName()?.includes('dsh-session'))
    const found = owner?.getFileName()
    if (typeof found === 'string') file = found.startsWith('file:') ? fileURLToPath(found) : found
  } finally {
    Error.prepareStackTrace = previous
  }
  return file
}

function logAppendFailure(ctx: HostContext, error: unknown) {
  if (appendFailureLogged || !(error instanceof TypeError)) return
  appendFailureLogged = true
  const message = error.message
  ctx.logger?.warn?.('session-foundations: card record was not appended: %s', message)
}

function liveSession(ctx: HostContext, sessionId: string): Session | null {
  try {
    const session = ctx.sessions?.get?.(sessionId)
    if (session) return session as Session
  } catch {
    /* not entered */
  }
  try {
    const agent = ctx.agents?.get?.(sessionId)
    if (agent?.session) return agent.session as Session
  } catch {
    /* not entered */
  }
  return null
}
