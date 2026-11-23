/** States the workbench can show. Mood stays neutral until a product source exists. */
export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done'

export type PresenceMood = 'neutral'

export type PresenceEngine = 'none' | 'open-bot-avatar' | 'dotform'

export interface PresenceSegment {
  kind: string
  running?: boolean
  streaming?: boolean
  name?: string
  status?: string
  /** Set when a tool has a result. An empty string still counts as no result. */
  result?: string
}

export interface PresenceThread {
  drafting: boolean
  turn: number | null
  failures: Record<number, { message: string; code?: string }>
  /** turn/end reason kind already stored by the transcript, such as `completed` or `aborted`. */
  turnEnds: Record<number, string>
  /**
   * Nested abort cause when the host still has it (`grant-denied`, `hook`).
   * A bare `aborted` without this cause is a stop, not a block.
   */
  abortCause?: string
  segments: PresenceSegment[]
}

export interface PresenceSource {
  sessionId: string
  thread?: PresenceThread
  ticket?: { status: string }
  approvals?: Array<{ state: string }>
  /** Wall time when the current completion began. Absent means no done window. */
  settledAt?: number
}

export interface PresenceView {
  state: PresenceState
  mood: PresenceMood
  /** Empty when the mark is decorative beside a name that is already announced. */
  label: string
  definitionId: string
}

export const DONE_WINDOW_MS = 4000
