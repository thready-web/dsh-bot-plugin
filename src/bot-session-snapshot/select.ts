import { forbidden, validation } from './errors.ts'

/** Child Worker sessions use this host id convention. See plugin work-worker.ts. */
export const WORKER_SESSION_PREFIX = 'worker-'

export function isWorkerSessionId(sessionId: string) {
  return sessionId.startsWith(WORKER_SESSION_PREFIX) && sessionId.length > WORKER_SESSION_PREFIX.length
}

export function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw validation('sessionId is required.')
  }
  if (sessionId.includes('\0') || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    throw validation('sessionId is not a valid identifier.')
  }
  return sessionId
}

/**
 * A snapshot target must be a main Bot session (kind `bot`), not a Worker
 * or an ordinary chat session.
 */
export function assertMainBotSession(sessionId: unknown, isBot: (id: string) => boolean): string {
  const id = assertSessionId(sessionId)
  if (isWorkerSessionId(id)) {
    throw forbidden('Worker sessions are not main Bot sessions and cannot be snapshotted.')
  }
  if (!isBot(id)) {
    throw forbidden('Only a main Bot session can be snapshotted.')
  }
  return id
}
