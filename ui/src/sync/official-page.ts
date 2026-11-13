import { PAGE_MAX_MESSAGES, PAGE_TURN_WINDOW, SESSION_EVENTS_PATH } from './constants.ts'
import type { BoundedTransport } from './transport.ts'
import { collectEvents } from './ws-follow.ts'
import { sessionAddress, type SessionAddress } from './types.ts'

export function createOfficialPageTransport(
  options: {
    addressOf?: (sessionId: string) => SessionAddress
    fetch?: typeof fetch
    url?: string
    maxMessages?: number
  } = {},
): BoundedTransport {
  const addressOf = options.addressOf ?? (sessionId => sessionAddress(sessionId))
  const post = options.fetch ?? fetch
  const url = options.url ?? SESSION_EVENTS_PATH
  const maxMessages = options.maxMessages ?? PAGE_MAX_MESSAGES
  return {
    kind: 'official-page',
    async fetch(req, sink, signal) {
      if (req.throughSeq <= req.afterSeq) return { ok: true, throughSeq: req.throughSeq }
      let beforeSeq = req.throughSeq + 1
      let loaded = 0
      const total = req.throughSeq - req.afterSeq
      sink.progress({ loaded: 0, total, unit: 'events' })
      try {
        while (!signal.aborted) {
          const page = await rpcPage(
            post,
            url,
            {
              address: addressOf(req.sessionId),
              throughSeq: req.throughSeq,
              beforeSeq,
              maxMessages,
              turnWindow: PAGE_TURN_WINDOW,
            },
            signal,
          )
          if (!page.ok) return page
          const events = collectEvents(page.records)
          if (events.length) sink.events(events, { throughSeq: req.throughSeq })
          loaded += events.length
          sink.progress({ loaded, total, unit: 'events' })
          const first = events.reduce((min, event) => Math.min(min, event.seq), Number.POSITIVE_INFINITY)
          if (!page.hasMore || !Number.isFinite(first) || first <= req.afterSeq + 1) break
          if (first >= beforeSeq)
            return { ok: false, retryable: true, code: 'PAGE_STALLED', message: 'Official page did not move.' }
          beforeSeq = first
        }
        if (signal.aborted) return { ok: false, retryable: false, code: 'ABORTED' }
        return { ok: true, throughSeq: req.throughSeq }
      } catch (error) {
        if (signal.aborted) return { ok: false, retryable: false, code: 'ABORTED' }
        return {
          ok: false,
          retryable: true,
          code: 'PAGE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

async function rpcPage(
  post: typeof fetch,
  url: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<
  | { ok: true; records: unknown; hasMore: boolean; cursor?: number }
  | { ok: false; retryable: boolean; code: string; message?: string }
> {
  const response = await post(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: 'session/events',
      payload: { args: { request } },
    }),
  })
  let body: any = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok || body?.result?.ok === false) {
    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 0,
      code: 'PAGE_ERROR',
      message: body?.result?.error?.message ?? `session/events HTTP ${response.status}`,
    }
  }
  const value = body?.result?.value ?? body?.result ?? body
  return {
    ok: true,
    records: value?.records ?? value?.events ?? value,
    hasMore: value?.hasMore === true,
    cursor: value?.cursor,
  }
}
