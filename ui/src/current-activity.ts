import { OPEN_TOOL_STATES, redactText, toolPresentation, type ToolStatus } from './activity.ts'
import { isAnswerableQuestion, userQuestionView } from './user-question.ts'
import type { ToolApprovalView } from './tool-approval.ts'
import { english, type Copy, type MessageKey } from './i18n/index.ts'
import type { Segment } from './types.ts'
import type { WorkTicket } from './work.ts'

export interface CurrentActivityInput {
  segments: readonly Segment[]
  drafting: boolean
  currentTurn?: number | null
  tickets?: readonly WorkTicket[]
  connectionPhase?: string
  pendingApprovals?: readonly ToolApprovalView[]
  t?: Copy
}

export interface ActivitySummary {
  text: string
  moving: boolean
}

const OPEN_TICKETS = new Set(['accepted', 'enqueued', 'started', 'needs_user', 'ready'])
const SETTLED_TICKETS = new Set(['delivered', 'failed', 'cancelled'])

const TOOL_LABEL: Record<ToolStatus, MessageKey> = {
  preparing: 'activity.status.preparing',
  waiting: 'activity.status.waiting',
  running: 'activity.status.running',
  worker: 'activity.status.worker',
  background: 'activity.status.background',
  succeeded: 'activity.status.succeeded',
  failed: 'activity.status.failed',
  cancelled: 'activity.status.cancelled',
  unknown: 'activity.status.unknown',
}

const TICKET_LABEL: Record<string, MessageKey> = {
  accepted: 'activity.ticket.scheduling',
  enqueued: 'activity.ticket.scheduling',
  started: 'activity.status.worker',
  needs_user: 'activity.ticket.needsUser',
  ready: 'activity.ticket.ready',
}

/** A read-only summary, never a second transcript or evidence of process liveness. */
export function currentActivity(input: CurrentActivityInput): ActivitySummary | null {
  const { segments, drafting, currentTurn, tickets = [], t = english } = input
  const unresolved: ActivitySummary[] = []
  const lastKnown: ActivitySummary[] = []
  const representedTickets = new Set<string>()
  const inCurrentTurn = (turn?: number) => currentTurn == null || turn === currentTurn
  const toolLabel = (state: ToolStatus) => t(TOOL_LABEL[state])
  for (const segment of segments) {
    if (segment.kind !== 'tool') continue
    const view = toolPresentation(segment, undefined, tickets)
    const question = userQuestionView(segment)
    if (question && isAnswerableQuestion(question.state) && drafting && inCurrentTurn(segment.turn)) {
      unresolved.push({ text: t('question.waiting'), moving: true })
      continue
    }
    if (view.status === 'worker' && view.ticket) continue // Count the linked worker once below, not once per dispatch call.
    if (view.status === 'worker' && view.ticketId) {
      if (representedTickets.has(view.ticketId)) continue
      representedTickets.add(view.ticketId)
    }
    const detail = view.description || view.command || view.title
    const item = { text: `${toolLabel(view.status)}: ${detail}`, moving: view.status !== 'background' }
    if (view.status === 'background') {
      // Last-known is not completion, but it is also not current pending work after the turn settles.
      if (drafting && inCurrentTurn(segment.turn)) lastKnown.push(item)
      continue
    }
    if (!OPEN_TOOL_STATES.has(view.status)) continue
    if (!drafting || !inCurrentTurn(segment.turn)) continue
    unresolved.push(item)
  }
  if (input.pendingApprovals?.some(item => item.state === 'open')) {
    unresolved.push({ text: t('approval.waiting'), moving: true })
  }
  for (const ticket of tickets) {
    if (representedTickets.has(ticket.id) || SETTLED_TICKETS.has(ticket.status) || !OPEN_TICKETS.has(ticket.status))
      continue
    representedTickets.add(ticket.id)
    const key = TICKET_LABEL[ticket.status]
    if (!key) continue
    unresolved.push({
      text: `${t(key)}: ${ticket.summary}`,
      moving: ['accepted', 'enqueued', 'started'].includes(ticket.status),
    })
  }
  let summary = unresolved.find(item => item.text === t('question.waiting')) ?? unresolved.at(-1)
  if (unresolved.length > 1 && summary) {
    summary = {
      text: `${t('activity.pendingCount', { count: String(unresolved.length) })} · ${summary.text}`,
      moving: unresolved.some(item => item.moving),
    }
  }
  if (!summary && lastKnown.length) summary = lastKnown.at(-1)
  if (!summary && drafting) {
    const current = segments.filter(item => inCurrentTurn(item.turn))
    summary = current.some(item => item.kind === 'think' && item.running)
      ? { text: t('activity.thinking'), moving: true }
      : current.some(item => item.kind === 'assistant' && item.streaming)
        ? { text: t('bot.replying'), moving: true }
        : { text: t('activity.waitingModel'), moving: true }
  }
  if (!summary) return null
  if (input.connectionPhase && input.connectionPhase !== 'live') {
    const syncing = ['restoring', 'connecting', 'syncing'].includes(input.connectionPhase)
    summary = {
      text: t('activity.staleSummary', {
        phase: syncing ? t('activity.syncing') : t('activity.connectionUnavailable'),
        text: summary.text,
      }),
      moving: false,
    }
  }
  return { ...summary, text: redactText(summary.text).replace(/\s+/g, ' ').trim() }
}
