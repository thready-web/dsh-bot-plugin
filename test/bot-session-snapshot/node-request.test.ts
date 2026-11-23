import { strict as assert } from 'node:assert'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { incomingToFetchRequest } from '../../src/bot-session-snapshot/node-request.ts'
import { dispatchBackupRequest } from '../../src/bot-session-snapshot/routes.ts'
import { createSnapshotStore } from '../../src/bot-session-snapshot/store.ts'
import { memorySource, sequence } from './helpers.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function nodeRequest(method: string, url: string, headers: Record<string, string>, body?: string): IncomingMessage {
  const req = Readable.from(body !== undefined ? [Buffer.from(body)] : []) as IncomingMessage
  Object.assign(req, { method, url, headers })
  return req
}

test('incomingToFetchRequest forwards a POST JSON body', async () => {
  const payload = JSON.stringify({ sessionId: 'bot-main' })
  const request = await incomingToFetchRequest(
    nodeRequest(
      'POST',
      '/api/dsh-bot/backups',
      {
        host: 'tobs.thready.org',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      },
      payload,
    ),
  )
  assert.equal(request.method, 'POST')
  assert.equal(new URL(request.url).pathname, '/api/dsh-bot/backups')
  assert.deepEqual(await request.json(), { sessionId: 'bot-main' })
})

test('incomingToFetchRequest leaves GET requests bodyless', async () => {
  const request = await incomingToFetchRequest(
    nodeRequest('GET', '/api/dsh-bot/backups?sessionId=bot-main', { host: '127.0.0.1:31980' }),
  )
  assert.equal(request.method, 'GET')
  assert.equal(request.body, null)
})

test('a Request built without a body or query is rejected as the live adapter used to do', async () => {
  const store = createSnapshotStore({
    dataDir: await mkdtemp(join(tmpdir(), 'bot-snapshot-nobody-')),
    source: memorySource({ 'bot-main': sequence(3) }),
    isBot: id => id === 'bot-main',
  })
  const dropped = await incomingToFetchRequest(
    nodeRequest('POST', '/api/dsh-bot/backups', { host: '127.0.0.1', 'content-type': 'application/json' }),
  )
  // Simulate the previous asFetchRequest, which copied only method and headers.
  const broken = new Request(dropped.url, { method: dropped.method, headers: dropped.headers })
  const response = await dispatchBackupRequest(store, broken)
  assert.equal(response?.status, 400)
  const body = (await response!.json()) as { code: string; message: string }
  assert.equal(body.code, 'VALIDATION')
  assert.match(body.message, /sessionId is required/)
})

test('UI create payload (JSON body, no query) succeeds when the Node body is forwarded', async () => {
  const store = createSnapshotStore({
    dataDir: await mkdtemp(join(tmpdir(), 'bot-snapshot-ui-post-')),
    source: memorySource({ 'bot-main': sequence(3) }),
    isBot: id => id === 'bot-main',
  })
  const payload = JSON.stringify({ sessionId: 'bot-main' })
  const request = await incomingToFetchRequest(
    nodeRequest(
      'POST',
      '/api/dsh-bot/backups',
      { host: '127.0.0.1', 'content-type': 'application/json', accept: 'application/json' },
      payload,
    ),
  )
  const response = await dispatchBackupRequest(store, request)
  assert.equal(response?.status, 201)
  const body = (await response!.json()) as { ok: boolean; snapshot: { snapshotId: string; count: number } }
  assert.equal(body.ok, true)
  assert.equal(body.snapshot.count, 3)
  const listed = await dispatchBackupRequest(
    store,
    new Request('http://127.0.0.1/api/dsh-bot/backups?sessionId=bot-main'),
  )
  assert.equal(listed?.status, 200)
  const listBody = (await listed!.json()) as { snapshots: Array<{ snapshotId: string }> }
  assert.equal(listBody.snapshots[0]?.snapshotId, body.snapshot.snapshotId)
})
