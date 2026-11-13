import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createCdcSnapshotTransport, parseNdjson, type CdcManifest } from './cdc.ts'
import { createMemoryCheckpoint } from './checkpoint.ts'
import { sha256Hex } from './sha256.ts'
import type { LogEvent } from './types.ts'
import { stableStringifyForTest } from './test-util.ts'

function ev(seq: number): LogEvent {
  return { type: 'user/message', seq, time: seq, data: { id: `m${seq}` } }
}

function ndjson(events: LogEvent[]) {
  return new TextEncoder().encode(events.map(event => stableStringifyForTest(event)).join('\n') + '\n')
}

async function chunk(fromSeq: number, toSeq: number, events: LogEvent[]) {
  const bytes = ndjson(events.filter(event => event.seq >= fromSeq && event.seq <= toSeq))
  return { fromSeq, toSeq, bytes: bytes.byteLength, hash: await sha256Hex(bytes), body: bytes }
}

test('a 6-wide window starts that many requests and still delivers in seq order', async () => {
  const events = Array.from({ length: 12 }, (_, seq) => ev(seq))
  const parts: Awaited<ReturnType<typeof chunk>>[] = []
  for (let i = 0; i < 12; i += 2) parts.push(await chunk(i, i + 1, events))
  const started: number[] = []
  const inflightMax = { n: 0, max: 0 }
  let inflight = 0
  const releases: Array<() => void> = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/manifest')) {
      const manifest: CdcManifest = {
        sessionId: 's',
        throughSeq: 11,
        count: 12,
        totalSize: parts.reduce((sum, part) => sum + part.bytes, 0),
        chunks: parts.map(({ body: _body, ...meta }) => meta),
        format: 'ndjson-v1',
      }
      return new Response(JSON.stringify(manifest), { status: 200 })
    }
    const fromSeq = Number(new URL(url, 'http://local').searchParams.get('fromSeq'))
    started.push(fromSeq)
    inflight += 1
    inflightMax.n = inflight
    inflightMax.max = Math.max(inflightMax.max, inflight)
    await new Promise<void>(resolve => releases.push(resolve))
    inflight -= 1
    const part = parts.find(item => item.fromSeq === fromSeq)
    return new Response(part!.body, { status: 200 })
  }) as typeof fetch

  const received: number[] = []
  const transport = createCdcSnapshotTransport({ fetch: fetchImpl, cache: createMemoryCheckpoint(), concurrency: 6 })
  const ac = new AbortController()
  const done = transport.fetch(
    { sessionId: 's', afterSeq: -1, throughSeq: 11 },
    {
      events(batch) {
        received.push(...batch.map(event => event.seq))
      },
      head() {},
      progress() {},
      ephemeral() {},
    },
    ac.signal,
  )

  await waitUntil(() => started.length === 6)
  assert.deepEqual(started, [0, 2, 4, 6, 8, 10])
  assert.equal(inflightMax.max, 6)
  // Resolve later chunks first; delivery must still be in seq order.
  releases[5]!()
  releases[4]!()
  releases[0]!()
  await waitUntil(() => received.includes(1))
  assert.deepEqual(received, [0, 1])
  releases[1]!()
  releases[2]!()
  releases[3]!()
  const outcome = await done
  assert.equal(outcome.ok, true)
  assert.deepEqual(
    received,
    events.map(event => event.seq),
  )
})

test('a failed chunk is retried and then CDC stops so the official page can finish the gap', async () => {
  const events = [ev(0), ev(1), ev(2), ev(3)]
  const first = await chunk(0, 1, events)
  const second = await chunk(2, 3, events)
  let secondHits = 0
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/manifest')) {
      return new Response(
        JSON.stringify({
          sessionId: 's',
          throughSeq: 3,
          count: 4,
          totalSize: first.bytes + second.bytes,
          chunks: [meta(first), meta(second)],
        }),
        { status: 200 },
      )
    }
    const fromSeq = Number(new URL(url, 'http://local').searchParams.get('fromSeq'))
    if (fromSeq === 0) return new Response(first.body, { status: 200 })
    secondHits += 1
    return new Response('nope', { status: 500 })
  }) as typeof fetch
  const received: number[] = []
  const transport = createCdcSnapshotTransport({
    fetch: fetchImpl,
    cache: createMemoryCheckpoint(),
    concurrency: 6,
    retries: 3,
    wait: async () => {},
  })
  const outcome = await transport.fetch(
    { sessionId: 's', afterSeq: -1, throughSeq: 3 },
    {
      events(batch) {
        received.push(...batch.map(event => event.seq))
      },
      head() {},
      progress() {},
      ephemeral() {},
    },
    new AbortController().signal,
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'CDC_CHUNK_FAILED')
  assert.equal(secondHits, 3)
  assert.deepEqual(received, [0, 1])
})

test('AbortSignal cancels in-flight chunk fetches', async () => {
  const first = await chunk(0, 0, [ev(0)])
  let aborted = 0
  let started = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/manifest')) {
      return new Response(
        JSON.stringify({ sessionId: 's', throughSeq: 0, count: 1, totalSize: first.bytes, chunks: [meta(first)] }),
        { status: 200 },
      )
    }
    started += 1
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        aborted += 1
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => {
        aborted += 1
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  }) as typeof fetch
  const ac = new AbortController()
  const transport = createCdcSnapshotTransport({ fetch: fetchImpl, cache: createMemoryCheckpoint() })
  const done = transport.fetch(
    { sessionId: 's', afterSeq: -1, throughSeq: 0 },
    {
      events() {},
      head() {},
      progress() {},
      ephemeral() {},
    },
    ac.signal,
  )
  await waitUntil(() => started >= 1)
  ac.abort()
  const outcome = await done
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'ABORTED')
  assert.ok(aborted >= 1)
})

test('parseNdjson reads one event per line', () => {
  const bytes = ndjson([ev(0), ev(1)])
  assert.deepEqual(
    parseNdjson(bytes).map(event => event.seq),
    [0, 1],
  )
})

function meta(part: { fromSeq: number; toSeq: number; bytes: number; hash: string }) {
  return { fromSeq: part.fromSeq, toSeq: part.toSeq, bytes: part.bytes, hash: part.hash }
}

function waitUntil(isReady: () => boolean) {
  return new Promise<void>(resolve => {
    const tick = () => {
      if (isReady()) resolve()
      else setTimeout(tick, 0)
    }
    tick()
  })
}
