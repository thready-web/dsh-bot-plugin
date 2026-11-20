/** Sessions whose turns must not start. A failed delete keeps the fence. */

export type DeletePhase = 'fence' | 'stop' | 'idle' | 'store' | 'canvas' | 'files' | 'done' | 'error'

export interface DeleteProgress {
  phase: DeletePhase | 'absent'
  percent: number
  error?: string
  deletedSessionIds?: string[]
}

const fenced = new Set<string>()

export function isFenced(sessionId: string) {
  return sessionId !== '' && fenced.has(sessionId)
}

export function fence(sessionIds: readonly string[]) {
  for (const id of sessionIds) if (id !== '') fenced.add(id)
}

export function unfence(sessionIds: readonly string[]) {
  for (const id of sessionIds) fenced.delete(id)
}

export interface DeleteJob {
  ownerId: string
  latest: DeleteProgress
  promise: Promise<void>
  listen(listener: (event: DeleteProgress) => void): void
  unlisten(listener: (event: DeleteProgress) => void): void
}

const jobs = new Map<string, DeleteJob & { listeners: Set<(event: DeleteProgress) => void> }>()

/**
 * Start a delete, or join the one already running for this bot.
 * A finished job is replayed. A failed job starts again.
 * The run is deferred so the caller can listen before the first event.
 */
export function beginDelete(
  ownerId: string,
  run: (publish: (event: DeleteProgress) => void) => Promise<void>,
): DeleteJob {
  const existing = jobs.get(ownerId)
  if (existing && existing.latest.phase !== 'error' && existing.latest.phase !== 'done') return existing
  if (existing?.latest.phase === 'done') return existing
  const listeners = existing?.listeners ?? new Set<(event: DeleteProgress) => void>()
  const job = {
    ownerId,
    latest: { phase: 'fence', percent: 10 } as DeleteProgress,
    listeners,
    promise: Promise.resolve(),
    listen(listener: (event: DeleteProgress) => void) {
      listeners.add(listener)
    },
    unlisten(listener: (event: DeleteProgress) => void) {
      listeners.delete(listener)
    },
  }
  const publish = (event: DeleteProgress) => {
    job.latest = event
    for (const listener of listeners) listener(event)
  }
  job.promise = Promise.resolve().then(() =>
    run(publish).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'delete failed'
      publish({ phase: 'error', percent: job.latest.percent, error: message })
    }),
  )
  jobs.set(ownerId, job)
  return job
}

export function deleteStatus(ownerId: string): DeleteProgress | null {
  return jobs.get(ownerId)?.latest ?? null
}
