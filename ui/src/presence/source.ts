import {
  completionActive,
  derivePresence,
  nextSettledAt,
  type PresenceSource,
  type PresenceThread,
  type PresenceView,
  type SettledStamp,
} from '@tobs/bot-presence'
import type { ThreadState } from '../types'

const RANK = ['failed', 'needs_user', 'waiting_budget', 'started', 'accepted', 'enqueued', 'delivered', 'ready']

export function focusStatus(statuses: readonly string[]): string | undefined {
  for (const status of RANK) {
    if (statuses.includes(status)) return status
  }
  return statuses[0]
}

export function presenceFromThread(
  sessionId: string,
  thread: ThreadState,
  approvals: readonly { state: string }[],
  ticketStatus: string | undefined,
  settledAt?: number,
): PresenceSource {
  const mapped: PresenceThread = {
    drafting: thread.drafting,
    turn: thread.turn,
    failures: thread.failures,
    turnEnds: thread.turnEnds,
    segments: thread.segments.map(segment => {
      if (segment.kind === 'tool') {
        return {
          kind: segment.kind,
          running: segment.running,
          name: segment.name,
          status: segment.status,
          result: segment.result,
        }
      }
      if (segment.kind === 'assistant') return { kind: segment.kind, streaming: segment.streaming }
      if (segment.kind === 'think') return { kind: segment.kind, running: segment.running }
      return { kind: segment.kind }
    }),
  }
  return {
    sessionId,
    thread: mapped,
    ...(ticketStatus ? { ticket: { status: ticketStatus } } : {}),
    approvals: approvals.map(item => ({ state: item.state })),
    ...(settledAt != null ? { settledAt } : {}),
  }
}

export function presenceForRow(sessionId: string, running: boolean, statuses: readonly string[]): PresenceSource {
  const status = focusStatus(statuses)
  return {
    sessionId,
    ...(status ? { ticket: { status } } : {}),
    ...(running
      ? {
          thread: {
            drafting: true,
            turn: null,
            failures: {},
            turnEnds: {},
            segments: [],
          },
        }
      : {}),
  }
}

export function faceGlyph(name: string, bot = false): string {
  const glyph = Array.from(name.trim())[0]
  if (glyph) return glyph
  return bot ? 'B' : '·'
}

export function viewFor(source: PresenceSource, now: number): PresenceView {
  return derivePresence(source, now)
}

export function stampFor(
  previous: SettledStamp | null,
  sessionId: string,
  source: PresenceSource,
  now: number,
): SettledStamp {
  return nextSettledAt(previous, sessionId, completionActive(source), now)
}
