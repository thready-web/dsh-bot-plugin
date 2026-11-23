import { avatarIdFor } from './catalog.ts'
import { DONE_WINDOW_MS, type PresenceSource, type PresenceState, type PresenceView } from './types.ts'

const WORKING = new Set(['started', 'accepted', 'enqueued'])
const BLOCKED_ABORT = /grant-denied|^hook$|hook-fail/i

/**
 * Highest matching fact wins. Text, tool output, and emoji never become a mood.
 * `still` is chosen by the caller from the placement, not from this result.
 */
export function derivePresence(source: PresenceSource, now = Date.now()): PresenceView {
  const state = presenceState(source, now)
  return {
    state,
    mood: 'neutral',
    label: '',
    definitionId: avatarIdFor(source.sessionId || 'chat'),
  }
}

export function presenceState(source: PresenceSource, now = Date.now()): PresenceState {
  if (isBlocked(source)) return 'blocked'
  if (isWaiting(source)) return 'waiting'
  if (isWorking(source)) return 'working'
  if (isThinking(source)) return 'thinking'
  if (isDone(source, now)) return 'done'
  return 'idle'
}

/** True only while a completion is the highest fact, before the done window is applied. */
export function completionActive(source: PresenceSource): boolean {
  if (isBlocked(source) || isWaiting(source) || isWorking(source) || isThinking(source)) return false
  return isCompleted(source)
}

export interface SettledStamp {
  sessionId: string
  active: boolean
  at?: number
}

/** Remember when a completion started so the done pose can expire. */
export function nextSettledAt(
  previous: SettledStamp | null,
  sessionId: string,
  active: boolean,
  now: number,
): SettledStamp {
  if (!previous || previous.sessionId !== sessionId) {
    return { sessionId, active, ...(active ? { at: now } : {}) }
  }
  if (active && !previous.active) return { sessionId, active, at: now }
  if (!active) return { sessionId, active }
  return { ...previous, active }
}

export function isBlocked(source: PresenceSource): boolean {
  const thread = source.thread
  const turn = thread?.turn
  if (turn != null && thread?.failures[turn]) return true
  if (source.ticket?.status === 'failed') return true
  if (turn == null || !thread || thread.turnEnds[turn] !== 'aborted') return false
  return BLOCKED_ABORT.test(thread.abortCause ?? '')
}

export function isWaiting(source: PresenceSource): boolean {
  if (source.approvals?.some(item => item.state === 'open')) return true
  const status = source.ticket?.status
  if (status === 'needs_user' || status === 'waiting_budget') return true
  return (source.thread?.segments ?? []).some(segment => {
    if (segment.kind !== 'tool' || segment.name !== 'ask_user_question') return false
    const open = segment.running === true || segment.status === 'waiting' || segment.status === 'running'
    return open && !segment.result
  })
}

export function isWorking(source: PresenceSource): boolean {
  if (source.ticket && WORKING.has(source.ticket.status)) return true
  return (source.thread?.segments ?? []).some(
    segment => segment.kind === 'tool' && segment.running === true && segment.name !== 'ask_user_question',
  )
}

export function isThinking(source: PresenceSource): boolean {
  if (source.thread?.drafting) return true
  return (source.thread?.segments ?? []).some(
    segment =>
      (segment.kind === 'assistant' && segment.streaming === true) ||
      (segment.kind === 'think' && (segment.running === true || segment.streaming === true)),
  )
}

function isCompleted(source: PresenceSource): boolean {
  const turn = source.thread?.turn
  if (turn != null && source.thread?.turnEnds[turn] === 'completed') return true
  const status = source.ticket?.status
  return status === 'delivered' || status === 'ready'
}

function isDone(source: PresenceSource, now: number): boolean {
  if (!isCompleted(source) || source.settledAt == null) return false
  const age = now - source.settledAt
  return age >= 0 && age < DONE_WINDOW_MS
}
