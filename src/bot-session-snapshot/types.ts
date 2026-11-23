export const SNAPSHOT_FORMAT = 'ndjson-v1' as const
export const SNAPSHOT_KIND = 'main-session-event-log' as const
export const SNAPSHOT_SCOPE = 'event-log-only' as const
export const SNAPSHOT_MANIFEST_VERSION = 1 as const

export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

export interface LogSource {
  /** Inclusive log end; an empty log is -1. */
  head(sessionId: string): Promise<number>
  /** (afterSeq, throughSeq], ascending. Omitting throughSeq pins to the head at read time. */
  read(sessionId: string, afterSeq: number, throughSeq?: number): Promise<{ events: LogEvent[]; throughSeq: number }>
}

export interface BackupManifest {
  readonly version: typeof SNAPSHOT_MANIFEST_VERSION
  readonly kind: typeof SNAPSHOT_KIND
  readonly scope: typeof SNAPSHOT_SCOPE
  readonly format: typeof SNAPSHOT_FORMAT
  readonly snapshotId: string
  readonly sourceSessionId: string
  readonly createdAt: string
  readonly afterSeq: number
  readonly throughSeq: number
  readonly count: number
  readonly bytes: number
  readonly sha256: string
}

export const EVENTS_FILE = 'events.ndjson'
export const MANIFEST_FILE = 'manifest.json'
