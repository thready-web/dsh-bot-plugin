/** Quiesce a bot and its workers, then delete the data that belongs to them. */

import type { CanvasStore } from './canvas-store.ts'
import { fence, unfence, type DeleteProgress } from './deleting.ts'
import {
  deleteOwnedCanvases,
  deleteOwnedLogs,
  deleteOwnedSessions,
  quietSessions,
  sessionClosure,
} from './session-wipe.ts'
import type { Store } from './store.ts'

const ROUNDS = 3

export interface DeleteHost {
  store: Store
  canvas: CanvasStore | null
  sessionsRoot: string
  stateRoot: string
  /** True when a turn is still running. Null when the host list cannot be read. */
  running(sessionId: string): Promise<boolean | null>
  /** Cancel the turn, wait until idle, and detach. False when the wait times out. */
  stop(sessionId: string): Promise<boolean>
  silence(sessionId: string): void
  cancelQuestions(sessionId: string): void
  abandonApprovals(sessionId: string): void
  forgetDesk(sessionIds: readonly string[]): void
  dropMemory(sessionIds: readonly string[]): void
}

export async function executeDelete(host: DeleteHost, ownerId: string, publish: (event: DeleteProgress) => void) {
  const ids = new Set<string>([ownerId])
  fence([ownerId])
  publish({ phase: 'fence', percent: 10 })
  try {
    const stopped = await quiesce(host, ownerId, ids, publish)
    if (!stopped.ok) {
      publish({ phase: 'error', percent: 45, error: stopped.error })
      return
    }
    const sessionIds = [...ids]
    publish({ phase: 'store', percent: 65 })
    await deleteOwnedSessions(host.store, sessionIds)
    publish({ phase: 'canvas', percent: 78 })
    if (host.canvas) deleteOwnedCanvases(host.canvas, sessionIds)
    publish({ phase: 'files', percent: 90 })
    deleteOwnedLogs({ sessionsRoot: host.sessionsRoot, stateRoot: host.stateRoot, sessionIds })
    host.forgetDesk(sessionIds)
    host.dropMemory(sessionIds)
    unfence(sessionIds)
    publish({ phase: 'done', percent: 90, deletedSessionIds: sessionIds })
  } catch (error) {
    publish({
      phase: 'error',
      percent: 45,
      error: error instanceof Error ? error.message : 'delete failed',
    })
  }
}

async function quiesce(
  host: DeleteHost,
  ownerId: string,
  ids: Set<string>,
  publish: (event: DeleteProgress) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  publish({ phase: 'stop', percent: 30 })
  for (let round = 0; round < ROUNDS; round += 1) {
    const found = sessionClosure(host.store.db, ownerId)
    for (const id of found) ids.add(id)
    fence(found)
    await quietSessions(host.store, found)
    const ordered = [...found.filter(id => id !== ownerId), ownerId]
    let timedOut = false
    for (const id of ordered) {
      host.silence(id)
      host.cancelQuestions(id)
      host.abandonApprovals(id)
      const stopped = await host.stop(id)
      if (!stopped) timedOut = true
    }
    publish({ phase: 'idle', percent: 45 })
    let busy = timedOut
    let unknown = false
    for (const id of found) {
      const running = await host.running(id)
      if (running === null) unknown = true
      if (running === true) busy = true
    }
    if (unknown) return { ok: false, error: 'session_unreadable' }
    const again = sessionClosure(host.store.db, ownerId)
    const same = again.length === found.length && again.every(id => found.includes(id))
    if (!busy && same) {
      for (const id of again) ids.add(id)
      return { ok: true }
    }
    for (const id of again) ids.add(id)
  }
  return { ok: false, error: 'running' }
}
