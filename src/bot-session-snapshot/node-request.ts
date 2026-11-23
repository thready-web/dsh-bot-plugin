import type { IncomingMessage } from 'node:http'

const BODYLESS = new Set(['GET', 'HEAD'])

/**
 * Adapt a Node HTTP IncomingMessage into a Fetch Request, including the
 * request body. The plugin HTTP hook must use this (or an equivalent) when
 * dispatching backup routes; dropping the body makes the Snapshot panel's
 * JSON-only POST look like a missing sessionId.
 */
export async function incomingToFetchRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? '127.0.0.1'
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    }
  }
  const method = req.method ?? 'GET'
  if (BODYLESS.has(method.toUpperCase())) {
    return new Request(url, { method, headers })
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks)
  return new Request(url, {
    method,
    headers,
    body,
    duplex: 'half',
  } as RequestInit)
}
