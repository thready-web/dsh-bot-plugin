import type { BackupManifest } from './types.ts'

export type SnapshotPanelCopy = {
  create: string
  creating: string
  empty: string
  error: string
  worker: string
  ordinary: string
}

export type SnapshotPanelStatus = 'idle' | 'loading' | 'creating' | 'error'

export interface SnapshotPanelState {
  status: SnapshotPanelStatus
  snapshots: BackupManifest[]
  message: string
}

export function initialSnapshotPanelState(): SnapshotPanelState {
  return { status: 'idle', snapshots: [], message: '' }
}

export function canCreateSnapshot(input: { sessionId: string; isBot: boolean; isWorker: boolean }) {
  return input.sessionId !== '' && input.isBot && !input.isWorker
}

export function blockedReason(
  input: { sessionId: string; isBot: boolean; isWorker: boolean },
  copy: SnapshotPanelCopy,
) {
  if (input.sessionId === '') return copy.error
  if (input.isWorker) return copy.worker
  if (!input.isBot) return copy.ordinary
  return ''
}

export function applyListResult(
  state: SnapshotPanelState,
  result: { ok: true; snapshots: BackupManifest[] } | { ok: false; message: string },
): SnapshotPanelState {
  if (!result.ok) return { ...state, status: 'error', message: result.message }
  return { status: 'idle', snapshots: result.snapshots, message: result.snapshots.length === 0 ? '' : state.message }
}

export function applyCreateResult(
  state: SnapshotPanelState,
  result: { ok: true; snapshot: BackupManifest } | { ok: false; message: string },
): SnapshotPanelState {
  if (!result.ok) return { ...state, status: 'error', message: result.message }
  const rest = state.snapshots.filter(item => item.snapshotId !== result.snapshot.snapshotId)
  return { status: 'idle', snapshots: [result.snapshot, ...rest], message: '' }
}
