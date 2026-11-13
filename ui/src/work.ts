/** Ticket cards for the main transcript. Labels come from the active catalog. */

import { english, type Copy, type MessageKey } from './i18n/index.ts'

export interface WorkEvent {
  eventId: string
  kind: string
  applyStatus: string
  revision: number
  text: string
}

export interface WorkTicket {
  id: string
  status: string
  revision: number
  summary: string
  childSessionId: string | null
  startedAt: string | null
  events: WorkEvent[]
}

const STATUS_KEY: Record<string, MessageKey> = {
  accepted: 'work.status.accepted',
  enqueued: 'work.status.enqueued',
  started: 'work.status.started',
  waiting_budget: 'work.status.waitingBudget',
  needs_user: 'work.status.needs_user',
  ready: 'work.status.ready',
  delivered: 'work.status.delivered',
  cancelled: 'work.status.cancelled',
  failed: 'work.status.failed',
}

const CLOSED = new Set(['delivered', 'cancelled'])
const BACKGROUND = new Set(['accepted', 'enqueued', 'started', 'needs_user', 'waiting_budget'])

export function workLabel(status: string, t: Copy = english): string {
  const key = STATUS_KEY[status]
  return key ? t(key) : status
}

export function isTicketNotice(text: string): boolean {
  return text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .startsWith('[foundations:ticket]')
}

export interface WorkBriefing {
  revision: number
  wallMs: number | null
  maxTokens: number | null
  material: string
  notes: string[]
  body: string
  cancel: boolean
}

/** The worker's task envelope. Ordinary user text stays a bubble. */
export function parseBriefing(text: string): WorkBriefing | null {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trimStart()
  if (!normalized.startsWith('[foundations:briefing]')) return null
  const rest = normalized.slice('[foundations:briefing]'.length).replace(/^\n/, '')
  const splitAt = rest.indexOf('\n---\n')
  if (splitAt < 0) return null
  const notes: string[] = []
  const fields: Record<string, string> = {}
  for (const line of rest.slice(0, splitAt).split('\n')) {
    const match = /^(briefing_revision|budget_wall_ms|budget_max_tokens|material_sha256):\s*(.*)$/.exec(line)
    if (match?.[1]) fields[match[1]] = (match[2] ?? '').trim()
    else if (line.trim() !== '') notes.push(line.trim())
  }
  const revision = Number(fields.briefing_revision)
  const wallMs = Number(fields.budget_wall_ms)
  const maxTokens = Number(fields.budget_max_tokens)
  return {
    revision: Number.isFinite(revision) && revision > 0 ? revision : 1,
    wallMs: Number.isFinite(wallMs) && wallMs > 0 ? wallMs : null,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
    material: fields.material_sha256 ?? '',
    notes,
    body: rest.slice(splitAt + '\n---\n'.length).trim(),
    cancel: notes.some(note => note.startsWith('This is a cancellation note') || note.startsWith('这是取消说明')),
  }
}

/** Child sessions are opened from a ticket card, not from the session list. */
export function isWorkerSession(sessionId: string): boolean {
  return sessionId.startsWith('worker-') && sessionId.length > 'worker-'.length
}

export function workerTicketId(sessionId: string): string {
  return isWorkerSession(sessionId) ? sessionId.slice('worker-'.length) : ''
}

export function readLiveSignals(body: Record<string, unknown>): Record<string, string[]> {
  const signals = body.signals
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) return {}
  const next: Record<string, string[]> = {}
  for (const [id, value] of Object.entries(signals)) {
    next[id] = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  return next
}

export function readLiveCardsByOwner(body: Record<string, unknown>): Record<string, WorkTicket[]> {
  const cards = body.cards
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) return {}
  const next: Record<string, WorkTicket[]> = {}
  for (const [id, value] of Object.entries(cards)) next[id] = readLiveCards({ cards: value })
  return next
}

/** The page stream nests the board under work. A bare board still parses. */
export function readLiveBoard(
  body: Record<string, unknown>,
): { signals: Record<string, string[]>; cards: Record<string, WorkTicket[]> } | null {
  const scope =
    body.work && typeof body.work === 'object' && !Array.isArray(body.work)
      ? (body.work as Record<string, unknown>)
      : body
  if (!('signals' in scope) && !('cards' in scope)) return null
  return { signals: readLiveSignals(scope), cards: readLiveCardsByOwner(scope) }
}

export function readLiveCards(body: Record<string, unknown>): WorkTicket[] {
  if (!Array.isArray(body.cards)) return []
  return body.cards.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const summary = typeof row.summary === 'string' ? row.summary : ''
    const ticket = readTicket(row, summary)
    return ticket ? [ticket] : []
  })
}

export function readTicket(body: Record<string, unknown>, summary = '', t: Copy = english): WorkTicket | null {
  const ticket = body.ticket
  if (!ticket || typeof ticket !== 'object') return null
  const row = ticket as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.status !== 'string') return null
  const attempts = Array.isArray(body.attempts) ? body.attempts : []
  const active = typeof row.active_attempt_id === 'string' ? row.active_attempt_id : ''
  const attempt = attempts.find(item => item && typeof item === 'object' && (item as { id?: unknown }).id === active) as
    | { started_at?: unknown }
    | undefined
  const events = Array.isArray(body.events) ? body.events.flatMap(readEvent) : []
  const child = typeof row.child_session_id === 'string' ? row.child_session_id : ''
  let waitingBudget = row.waiting_budget === true
  if (typeof row.budget_json === 'string') {
    try {
      waitingBudget ||= JSON.parse(row.budget_json).quota?.waiting === true
    } catch {
      /* Legacy malformed metadata is not a waiting signal. */
    }
  }
  const title = summary.trim() || t('work.ticket')
  return {
    id: row.id,
    status: waitingBudget && ['started', 'enqueued'].includes(row.status) ? 'waiting_budget' : row.status,
    revision: typeof row.briefing_revision === 'number' ? row.briefing_revision : 1,
    summary: title,
    childSessionId: child.startsWith('worker-') ? child : null,
    startedAt: typeof attempt?.started_at === 'string' ? attempt.started_at : null,
    events,
  }
}

export function cardsToShow(tickets: readonly WorkTicket[]): WorkTicket[] {
  const active = tickets.filter(ticket => !CLOSED.has(ticket.status))
  const delivered = tickets.find(ticket => ticket.status === 'delivered')
  return delivered ? [...active, delivered] : active
}

export function backgroundOpen(tickets: readonly { status: string }[]): boolean {
  return tickets.some(ticket => BACKGROUND.has(ticket.status))
}

/**
 * A live parent turn blocks an ordinary composer.
 * A bot chat stays open: sending interrupts the current reply.
 * An open background ticket also leaves an ordinary composer free.
 */
export function composerLocked(turnLive: boolean, tickets: readonly { status: string }[], chat = false): boolean {
  if (chat) return false
  return turnLive && !backgroundOpen(tickets)
}

/** The line under a bot transcript while a reply is in progress. */
export function chatStatus(activity: string, t: Copy = english): string {
  return activity === 'Replying' ? t('bot.replying') : t('bot.thinking')
}

/** Memory and ticket tools stay off the chat surface. Host tools still get one row. */
export function bookkeepingOnly(segments: readonly { kind: string; name?: string }[]): boolean {
  return (
    segments.length > 0 &&
    segments.every(
      segment =>
        segment.kind === 'think' || (segment.kind === 'tool' && (segment.name ?? '').startsWith('foundations_')),
    )
  )
}

const WORKING = new Set(['accepted', 'enqueued', 'started'])

/** Presence on a bot. Ready is intentionally absent: it is not a user-facing state. */
export function botSignal(tickets: readonly { status: string }[], live = false): 'run' | 'wait' | null {
  if (live) return 'run'
  let waiting = false
  let working = false
  for (const ticket of tickets) {
    if (ticket.status === 'delivered' || ticket.status === 'cancelled') continue
    if (ticket.status === 'needs_user' || ticket.status === 'waiting_budget') waiting = true
    else if (WORKING.has(ticket.status)) working = true
  }
  if (waiting) return 'wait'
  if (working) return 'run'
  return null
}

export function workPreview(tickets: readonly WorkTicket[], now = Date.now(), t: Copy = english): string {
  const started = tickets.filter(ticket => ticket.status === 'started')
  if (started.length > 1) return t('work.preview.startedMany', { count: String(started.length) })
  const focus = focusTicket(tickets)
  if (!focus || focus.status === 'ready') return ''
  const label = workLabel(focus.status, t)
  if (focus.status === 'started') {
    const elapsed = formatElapsed(focus.startedAt, now)
    return elapsed ? `${label} · ${elapsed}` : label
  }
  return label
}

export function workPlaceholder(tickets: readonly WorkTicket[], t: Copy = english): string | null {
  const started = tickets.filter(ticket => ticket.status === 'started')
  if (started.length > 1) return t('work.placeholder.many')
  const focus = focusTicket(tickets)
  if (!focus) return null
  if (focus.status === 'started') return t('work.placeholder.started')
  if (focus.status === 'waiting_budget') return t('work.fact.waitingBudget')
  if (focus.status === 'needs_user') return t('work.placeholder.needsUser')
  if (focus.status === 'ready') return t('work.placeholder.ready')
  if (focus.status === 'failed') return t('work.placeholder.failed')
  return null
}

export function ticketFacts(ticket: WorkTicket, now: number, t: Copy = english): string[] {
  const lines = [t('work.fact.revision', { revision: String(ticket.revision) })]
  if (ticket.status === 'accepted') lines.push(t('work.fact.accepted'))
  if (ticket.status === 'enqueued') lines.push(t('work.fact.enqueued'))
  if (ticket.status === 'started') {
    const elapsed = formatElapsed(ticket.startedAt, now)
    if (elapsed) lines.push(t('work.fact.elapsed', { time: elapsed }))
    lines.push(t('work.fact.wall'))
  }
  if (ticket.status === 'waiting_budget') lines.push(t('work.fact.waitingBudget'))
  if (ticket.status === 'needs_user') lines.push(t('work.fact.needsUser'))
  if (ticket.status === 'ready') lines.push(t('work.fact.ready'))
  if (ticket.status === 'delivered') lines.push(t('work.fact.delivered'))
  if (ticket.status === 'failed') lines.push(t('work.fact.failed'))
  if (ticket.revision > 1 && (ticket.status === 'enqueued' || ticket.status === 'accepted')) {
    lines.push(t('work.fact.sameWorker'))
    lines.push(t('work.fact.restart'))
  }
  const progress = latestProgress(ticket)
  if (progress) lines.push(progress)
  return lines
}

export function questionView(ticket: WorkTicket): { text: string; stale: boolean } | null {
  const questions = ticket.events.filter(event => event.kind === 'question' && event.text.trim() !== '')
  if (ticket.status === 'needs_user') {
    const live = questions.filter(event => event.revision === ticket.revision && event.applyStatus !== 'stale').at(-1)
    return { text: live?.text ?? '', stale: false }
  }
  if (
    ticket.revision > 1 &&
    (ticket.status === 'enqueued' || ticket.status === 'accepted' || ticket.status === 'started')
  ) {
    const stale = [...questions].reverse().find(event => event.applyStatus === 'stale')
    if (stale) return { text: stale.text, stale: true }
  }
  return null
}

export function dispatchTicketId(tool: { name: string; result: string }): string | null {
  if (tool.name !== 'foundations_dispatch' || tool.result.trim() === '') return null
  const parsed = parseResult(tool.result)
  if (parsed) {
    if (parsed.ok === false) return null
    return typeof parsed.ticketId === 'string' && parsed.ticketId !== '' ? parsed.ticketId : null
  }
  const match = /"ticketId"\s*:\s*"([^"]+)"/.exec(tool.result)
  return match?.[1] ?? null
}

export function isBudgetRefusal(tool: { name: string; result: string }): boolean {
  if (tool.name !== 'foundations_dispatch' || tool.result.trim() === '') return false
  const parsed = parseResult(tool.result)
  if (parsed) return parsed.ok === false && parsed.code === 'BUDGET'
  return tool.result.includes('"BUDGET"') || /concurrency limit/i.test(tool.result)
}

export function budgetRefusalText(result: string, t: Copy = english): string {
  const parsed = parseResult(result)
  if (parsed && typeof parsed.message === 'string' && parsed.message !== '') return parsed.message
  return t('work.budgetFallback')
}

export function formatElapsed(startedAt: string | null, now: number): string {
  if (!startedAt) return ''
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start)) return ''
  const total = Math.max(0, Math.floor((now - start) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function focusTicket(tickets: readonly WorkTicket[]): WorkTicket | null {
  const shown = cardsToShow(tickets)
  const rank = ['waiting_budget', 'needs_user', 'started', 'enqueued', 'accepted', 'ready', 'failed']
  for (const status of rank) {
    const found = shown.find(ticket => ticket.status === status)
    if (found) return found
  }
  return shown[0] ?? null
}

function latestProgress(ticket: WorkTicket): string {
  const rows = ticket.events.filter(
    event =>
      event.kind === 'progress' &&
      event.applyStatus === 'applied' &&
      event.revision === ticket.revision &&
      event.text.trim() !== '',
  )
  return rows.at(-1)?.text ?? ''
}

function readEvent(value: unknown): WorkEvent[] {
  if (!value || typeof value !== 'object') return []
  const row = value as Record<string, unknown>
  if (typeof row.event_id !== 'string' || typeof row.kind !== 'string') return []
  return [
    {
      eventId: row.event_id,
      kind: row.kind,
      applyStatus: typeof row.apply_status === 'string' ? row.apply_status : '',
      revision: typeof row.briefing_revision === 'number' ? row.briefing_revision : 0,
      text: typeof row.text === 'string' ? row.text : '',
    },
  ]
}

function parseResult(result: string): { ok?: unknown; code?: unknown; message?: unknown; ticketId?: unknown } | null {
  try {
    const parsed = JSON.parse(result) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as { ok?: unknown; code?: unknown; message?: unknown; ticketId?: unknown }
  } catch {
    return null
  }
}
