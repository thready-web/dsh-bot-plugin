import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DB_NAME, DB_VERSION, openLogDb } from './idb.ts'
import { createIdbCheckpoint, createMemoryCheckpoint } from './checkpoint.ts'
import { installFakeIndexedDB } from './fake-idb.ts'

test('a fresh open creates the v2 stores', async () => {
  const fake = installFakeIndexedDB()
  const opened = await openLogDb(fake)
  assert.equal(opened.ok, true)
  if (opened.ok !== true) return
  const names = [...opened.db.objectStoreNames]
  assert.deepEqual(names.sort(), ['log_chunks', 'log_cursors', 'log_events'])
  assert.equal(opened.db.version, DB_VERSION)
})

test('upgrading v1 deletes the old stores and does not migrate rows', async () => {
  const fake = installFakeIndexedDB()
  await fake.seedV1({
    chunks: { oldhash: { bytes: new Uint8Array([1]) } },
    events: { 's:0': { sessionId: 's', seq: 0 } },
  })
  const opened = await openLogDb(fake)
  assert.equal(opened.ok, true)
  if (opened.ok !== true) return
  const names = [...opened.db.objectStoreNames]
  assert.equal(names.includes('chunks'), false)
  assert.equal(names.includes('events'), false)
  assert.ok(names.includes('log_chunks'))
  const checkpoint = await createIdbCheckpoint(fake)
  assert.deepEqual(await checkpoint.readEvents('s'), [])
  assert.equal(await checkpoint.getChunk('oldhash'), null)
})

test('a blocked upgrade falls back to a memory checkpoint', async () => {
  const fake = installFakeIndexedDB({ blockUpgrade: true })
  await fake.seedV1({ chunks: {}, events: {} })
  const opened = await openLogDb(fake)
  assert.deepEqual(opened, { ok: false, reason: 'blocked' })
  const checkpoint = await createIdbCheckpoint(fake)
  assert.equal(checkpoint.mode, 'memory')
  await checkpoint.setCursor('s', 3, 3)
  assert.deepEqual(await checkpoint.getCursor('s'), { appliedSeq: 3, headSeq: 3 })
})

test('memory checkpoint is available when IndexedDB is missing', async () => {
  const memory = createMemoryCheckpoint()
  assert.equal(memory.mode, 'memory')
  await memory.putEvents('s', [{ type: 'user/message', seq: 1, time: 1, data: {} }])
  assert.equal((await memory.readEvents('s'))[0]?.seq, 1)
  assert.equal(DB_NAME, 'dsh-bot')
})
