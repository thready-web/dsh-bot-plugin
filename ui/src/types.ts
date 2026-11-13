import type { ToolStatus } from './activity.ts'
export interface SessionItem {
  sessionId: string
  running?: boolean
  blank?: boolean
  cwd?: string
  title?: string | null
}

export interface UserSegment {
  kind: 'user'
  id: string
  text: string
  time?: number
  seq: number
  turn?: number
  optimistic?: boolean
}

export interface ThinkSegment {
  kind: 'think'
  id: string
  text: string
  running: boolean
  seq: number
  turn?: number
  step?: number
}

export interface ToolSegment {
  kind: 'tool'
  id: string
  callId: string
  /** Stream arguments are not proof of dispatch; an empty result still settles the call. */
  status?: ToolStatus
  callReceived?: boolean
  resultReceived?: boolean
  callSeq?: number
  resultSeq?: number
  requestedAt?: number
  settledAt?: number
  meta?: unknown
  errorCode?: string
  name: string
  args: string
  result: string
  error: boolean
  running: boolean
  seq: number
  turn?: number
  step?: number
}

export interface AssistantSegment {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
  time?: number
  seq: number
  turn?: number
  step?: number
  messageId?: string
}

export type Segment = UserSegment | ThinkSegment | ToolSegment | AssistantSegment

export interface TurnFailure {
  message: string
  code?: string
}

export interface RetryAttempt {
  retryId: string
  retry: number
  maxRetries: number | null
  delayMs: number
  message: string
  code?: string
  state: 'scheduled' | 'started'
}

export interface LiveBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id: string
  name: string
  args: string
}

export interface StreamAttempt {
  attemptId: string
  turn: number
  step: number
  nextIndex: number
  startedAfterSeq: number
}

export interface HeldAssistant {
  type?: string
  seq?: number
  time?: number
  surfaceOp?: unknown
  data?: Record<string, unknown>
}

export interface ThreadState {
  segments: Segment[]
  live: Record<string, { seq: number; blocks: LiveBlock[] }>
  completed: Record<number, number>
  failures: Record<number, TurnFailure>
  retries: Record<number, RetryAttempt[]>
  title: string
  model: string
  preset: string
  turns: number | null
  steps: number | null
  drafting: boolean
  activity: string
  turn: number | null
  turnStartedAt: number | null
  streamAttempt: StreamAttempt | null
  streamRevision: number
  pendingAssistant: HeldAssistant | null
  turnEnds: Record<number, string>
}

export interface TaskRecord {
  id: string
  status: string
  sessionId?: string
  reason?: string
}

export interface HealthBody {
  accessMode?: string
  owner?: string
  primary?: { reachable?: boolean }
  execution?: { ready?: boolean; reason?: string }
}

export interface UsageBody {
  connected?: boolean
  code?: string
  error?: string
}

export const emptyThread = (): ThreadState => ({
  segments: [],
  live: {},
  activity: '',
  completed: {},
  failures: {},
  retries: {},
  title: '',
  model: '',
  preset: '',
  turns: null,
  steps: null,
  drafting: false,
  turn: null,
  turnStartedAt: null,
  streamAttempt: null,
  streamRevision: 0,
  pendingAssistant: null,
  turnEnds: {},
})
