import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dispatchBackupRequest } from '../../src/bot-session-snapshot/routes.ts'
import { createSnapshotStore, sha256Hex } from '../../src/bot-session-snapshot/store.ts'
import { memorySource, sequence } from './helpers.ts'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'bot-snapshot-http-'))
}

function storeFor(dataDir: string) {
  return createSnapshotStore({
    dataDir,
    source: memorySource({ 'bot-main': sequence(3), ordinary: sequence(2) }),
    isBot: id => id === 'bot-main',
  })
}

test('handlers create, list, read metadata, and download bytes', async () => {
  const store = storeFor(await tempDir())
  const created = await dispatchBackupRequest(
    store,
    new Request('http://127.0.0.1/api/dsh-bot/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bot-main' }),
    }),
  )
  assert.equal(created?.status, 201)
  const createdBody = (await created!.json()) as { snapshot: { snapshotId: string; sha256: string; count: number } }
  assert.equal(createdBody.snapshot.count, 3)
  const listed = await dispatchBackupRequest(
    store,
    new Request('http://127.0.0.1/api/dsh-bot/backups?sessionId=bot-main'),
  )
  assert.equal(listed?.status, 200)
  const listBody = (await listed!.json()) as { snapshots: Array<{ snapshotId: string }> }
  assert.equal(listBody.snapshots[0]?.snapshotId, createdBody.snapshot.snapshotId)
  const item = await dispatchBackupRequest(
    store,
    new Request(`http://127.0.0.1/api/dsh-bot/backups/item?snapshotId=${createdBody.snapshot.snapshotId}`),
  )
  assert.equal(item?.status, 200)
  const events = await dispatchBackupRequest(
    store,
    new Request(`http://127.0.0.1/api/dsh-bot/backups/events?snapshotId=${createdBody.snapshot.snapshotId}`),
  )
  assert.equal(events?.status, 200)
  const bytes = Buffer.from(await events!.arrayBuffer())
  assert.equal(sha256Hex(bytes), createdBody.snapshot.sha256)
  assert.equal(events!.headers.get('x-checksum-sha256'), createdBody.snapshot.sha256)
  const archive = await dispatchBackupRequest(
    store,
    new Request(`http://127.0.0.1/api/dsh-bot/backups/archive?snapshotId=${createdBody.snapshot.snapshotId}`),
  )
  assert.equal(archive?.status, 200)
  assert.equal(archive!.headers.get('content-type'), 'application/x-tar')
  const tar = Buffer.from(await archive!.arrayBuffer())
  assert.ok(tar.length >= 1024)
  assert.ok(tar.subarray(0, 100).toString('utf8').startsWith('manifest.json'))
})

test('handlers reject ordinary sessions and unknown snapshot ids', async () => {
  const store = storeFor(await tempDir())
  const forbidden = await dispatchBackupRequest(
    store,
    new Request('http://127.0.0.1/api/dsh-bot/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ordinary' }),
    }),
  )
  assert.equal(forbidden?.status, 403)
  const missing = await dispatchBackupRequest(
    store,
    new Request('http://127.0.0.1/api/dsh-bot/backups/item?snapshotId=els_20200101T000000Z_ffffffff'),
  )
  assert.equal(missing?.status, 404)
  const unknown = await dispatchBackupRequest(store, new Request('http://127.0.0.1/api/dsh-bot/log/manifest'))
  assert.equal(unknown, null)
})

test('loopback HTTP server covers create, list, and download', async () => {
  const store = storeFor(await tempDir())
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => {
      void (async () => {
        try {
          const host = req.headers.host ?? '127.0.0.1'
          const method = req.method ?? 'GET'
          const hasBody = method === 'POST' || method === 'PUT'
          const headers = new Headers()
          const type = req.headers['content-type']
          if (typeof type === 'string') headers.set('content-type', type)
          const request = new Request(`http://${host}${req.url}`, {
            method,
            headers,
            ...(hasBody ? { body: Buffer.concat(chunks), duplex: 'half' as const } : {}),
          })
          const response = (await dispatchBackupRequest(store, request)) ?? new Response('missing', { status: 404 })
          const body = Buffer.from(await response.arrayBuffer())
          const outHeaders: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            outHeaders[key] = value
          })
          res.writeHead(response.status, outHeaders)
          res.end(body)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end(message)
        }
      })()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const createdRes = await fetch(`${base}/api/dsh-bot/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bot-main' }),
    })
    assert.equal(createdRes.status, 201)
    const createdBody = (await createdRes.json()) as { ok: boolean; snapshot: { snapshotId: string; sha256: string } }
    assert.equal(createdBody.ok, true)
    const listedRes = await fetch(`${base}/api/dsh-bot/backups?sessionId=bot-main`)
    assert.equal(listedRes.status, 200)
    const listBody = (await listedRes.json()) as { snapshots: Array<{ snapshotId: string }> }
    assert.equal(listBody.snapshots[0]?.snapshotId, createdBody.snapshot.snapshotId)
    const eventsRes = await fetch(`${base}/api/dsh-bot/backups/events?snapshotId=${createdBody.snapshot.snapshotId}`)
    assert.equal(eventsRes.status, 200)
    assert.equal(sha256Hex(Buffer.from(await eventsRes.arrayBuffer())), createdBody.snapshot.sha256)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
