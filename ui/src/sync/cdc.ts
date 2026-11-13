import { CDC_CHUNK_RETRIES, CDC_CONCURRENCY, ENHANCE_CHUNK_PATH, ENHANCE_MANIFEST_PATH } from './constants.ts'
import { sha256Hex } from './sha256.ts'
import type { BoundedTransport, TransportOutcome, TransportSink } from './transport.ts'
import type { LogEvent } from './types.ts'
import { collectEvents } from './ws-follow.ts'

export interface CdcChunk {
  fromSeq: number
  toSeq: number
  bytes: number
  hash: string
}

export interface CdcManifest {
  sessionId: string
  throughSeq: number
  count: number
  totalSize: number
  chunks: CdcChunk[]
  epoch?: string
  format?: string
}

export interface CdcChunkCache {
  getChunk(hash: string): Promise<Uint8Array | null>
  putChunk(hash: string, bytes: Uint8Array): Promise<void>
}

export function createCdcSnapshotTransport(options: {
  fetch?: typeof fetch
  cache: CdcChunkCache
  concurrency?: number
  retries?: number
  manifestUrl?: string
  chunkUrl?: string
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): BoundedTransport {
  const post = options.fetch ?? fetch
  const concurrency = options.concurrency ?? CDC_CONCURRENCY
  const retries = options.retries ?? CDC_CHUNK_RETRIES
  const manifestUrl = options.manifestUrl ?? ENHANCE_MANIFEST_PATH
  const chunkUrl = options.chunkUrl ?? ENHANCE_CHUNK_PATH
  const wait = options.wait ?? defaultWait
  return {
    kind: 'cdc-snapshot',
    async fetch(req, sink, signal) {
      if (req.throughSeq <= req.afterSeq) return { ok: true, throughSeq: req.throughSeq }
      const local = new AbortController()
      const onAbort = () => local.abort()
      signal.addEventListener('abort', onAbort)
      try {
        const manifest = await loadManifest(post, manifestUrl, req, local.signal)
        if (!manifest.ok) return manifest
        return await pullChunks({
          manifest: manifest.value,
          afterSeq: req.afterSeq,
          throughSeq: req.throughSeq,
          sink,
          cache: options.cache,
          fetchImpl: post,
          chunkUrl,
          concurrency,
          retries,
          wait,
          signal: local.signal,
        })
      } catch (error) {
        if (signal.aborted || local.signal.aborted) return { ok: false, retryable: false, code: 'ABORTED' }
        return {
          ok: false,
          retryable: true,
          code: 'CDC_ERROR',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        if (!local.signal.aborted) local.abort()
      }
    },
  }
}

async function loadManifest(
  post: typeof fetch,
  url: string,
  req: { sessionId: string; afterSeq: number; throughSeq: number },
  signal: AbortSignal,
): Promise<{ ok: true; value: CdcManifest } | Extract<TransportOutcome, { ok: false }>> {
  const query = new URLSearchParams({
    sessionId: req.sessionId,
    throughSeq: String(req.throughSeq),
    afterSeq: String(req.afterSeq),
  })
  const response = await post(`${url}?${query}`, {
    method: 'GET',
    credentials: 'same-origin',
    signal,
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) return { ok: false, retryable: false, code: 'ENHANCE_UNAVAILABLE' }
  if (!response.ok)
    return { ok: false, retryable: response.status >= 500, code: 'CDC_MANIFEST', message: `HTTP ${response.status}` }
  const value = (await response.json()) as CdcManifest
  if (!Array.isArray(value.chunks)) return { ok: false, retryable: true, code: 'CDC_MANIFEST' }
  return { ok: true, value }
}

async function pullChunks(input: {
  manifest: CdcManifest
  afterSeq: number
  throughSeq: number
  sink: TransportSink
  cache: CdcChunkCache
  fetchImpl: typeof fetch
  chunkUrl: string
  concurrency: number
  retries: number
  wait: (ms: number, signal: AbortSignal) => Promise<void>
  signal: AbortSignal
}): Promise<TransportOutcome> {
  const chunks = [...input.manifest.chunks].sort((left, right) => left.fromSeq - right.fromSeq)
  const ready = new Map<number, LogEvent[]>()
  let loaded = 0
  const total = input.manifest.totalSize
  input.sink.progress({ loaded, total, unit: 'bytes' })
  input.sink.head(input.manifest.throughSeq)
  let nextToDeliver = 0
  const deliver = () => {
    while (nextToDeliver < chunks.length) {
      const chunk = chunks[nextToDeliver]
      if (!chunk || !ready.has(chunk.fromSeq)) break
      const events = (ready.get(chunk.fromSeq) ?? []).filter(
        event => event.seq > input.afterSeq && event.seq <= input.throughSeq,
      )
      if (events.length) input.sink.events(events, { throughSeq: input.throughSeq })
      nextToDeliver += 1
    }
  }

  const missing: CdcChunk[] = []
  for (const chunk of chunks) {
    const cached = await input.cache.getChunk(chunk.hash)
    if (cached && (await sha256Hex(cached)) === chunk.hash) {
      ready.set(chunk.fromSeq, parseNdjson(cached))
      loaded += chunk.bytes
      input.sink.progress({ loaded, total, unit: 'bytes' })
      deliver()
    } else {
      missing.push(chunk)
    }
  }
  if (missing.length === 0) {
    deliver()
    return { ok: true, throughSeq: input.throughSeq }
  }

  let cursor = 0
  let inflight = 0
  let failure: TransportOutcome | null = null
  let notify: (() => void) | null = null
  const kick = () => {
    const wake = notify
    notify = null
    wake?.()
  }
  const waitSlot = () =>
    new Promise<void>(resolve => {
      if (inflight === 0) {
        resolve()
        return
      }
      notify = resolve
    })

  const run = async (chunk: CdcChunk) => {
    for (let attempt = 0; attempt < input.retries; attempt += 1) {
      if (input.signal.aborted || failure) return
      try {
        const bytes = await fetchChunk(input.fetchImpl, input.chunkUrl, input.manifest.sessionId, chunk, input.signal)
        if ((await sha256Hex(bytes)) !== chunk.hash) throw new Error('hash mismatch')
        await input.cache.putChunk(chunk.hash, bytes)
        ready.set(chunk.fromSeq, parseNdjson(bytes))
        loaded += chunk.bytes
        input.sink.progress({ loaded, total, unit: 'bytes' })
        deliver()
        return
      } catch (error) {
        if (input.signal.aborted || failure) return
        if (attempt + 1 >= input.retries) {
          failure = {
            ok: false,
            retryable: true,
            code: 'CDC_CHUNK_FAILED',
            message: error instanceof Error ? error.message : String(error),
          }
          return
        }
        await input.wait(50 * 2 ** attempt, input.signal).catch(() => {})
      }
    }
  }

  const startNext = () => {
    while (!failure && !input.signal.aborted && inflight < input.concurrency && cursor < missing.length) {
      const chunk = missing[cursor]
      cursor += 1
      if (!chunk) break
      inflight += 1
      void run(chunk).finally(() => {
        inflight -= 1
        kick()
      })
    }
  }

  startNext()
  while (inflight > 0 && !input.signal.aborted) {
    startNext()
    if (inflight > 0) await waitSlot()
  }
  if (input.signal.aborted) return { ok: false, retryable: false, code: 'ABORTED' }
  if (failure) return failure
  deliver()
  return { ok: true, throughSeq: input.throughSeq }
}

async function fetchChunk(post: typeof fetch, url: string, sessionId: string, chunk: CdcChunk, signal: AbortSignal) {
  const query = new URLSearchParams({
    sessionId,
    fromSeq: String(chunk.fromSeq),
    toSeq: String(chunk.toSeq),
    hash: chunk.hash,
  })
  const response = await post(`${url}?${query}`, { method: 'GET', credentials: 'same-origin', signal })
  if (response.status === 404) throw Object.assign(new Error('not found'), { code: 'ENHANCE_UNAVAILABLE', status: 404 })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export function parseNdjson(bytes: Uint8Array): LogEvent[] {
  const text = new TextDecoder().decode(bytes)
  const events: LogEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(...collectEvents(JSON.parse(line)))
    } catch {
      /* skip a corrupt line */
    }
  }
  return events.sort((left, right) => left.seq - right.seq)
}

function defaultWait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
