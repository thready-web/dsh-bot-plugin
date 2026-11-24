/** Desk calls. Session, task, file, health, and usage routes are served by the plugin. */

import { forgetUnauthorized, reloadForUnauthorized, reloadStorage } from './unauthorized-reload.ts'

export async function api(
  path: string,
  options?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch('/dsh-bot/api' + path, {
    ...options,
    // A redirect to a login page is unobservable from a page and breaks CORS; asking as
    // an XHR makes a gateway answer with a status instead. It says nothing about who
    // owns the login.
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', ...(options?.headers ?? {}) },
  })
  // A 401 means this request needs credentials. The app does not own that decision:
  // it only asks for the document again so the gateway or login bridge can act.
  if (response.status === 401) reloadForUnauthorized(window.location, reloadStorage())
  else if (response.ok) forgetUnauthorized(reloadStorage())
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
}

/** Read a JSON body as it arrives. `total` is the content length when the server sent one. */
export async function readJsonStream(
  response: Response,
  onBytes?: (received: number, total: number | null) => void,
): Promise<unknown> {
  const header = response.headers.get('content-length')
  const parsedLength = header == null ? null : Number(header)
  const total = parsedLength != null && Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null
  if (!response.body) {
    const text = await response.text()
    onBytes?.(new TextEncoder().encode(text).byteLength, total)
    return JSON.parse(text || 'null')
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let received = 0
  while (true) {
    const step = await reader.read()
    if (step.done) break
    parts.push(step.value)
    received += step.value.byteLength
    onBytes?.(received, total)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  return text === '' ? null : JSON.parse(text)
}
