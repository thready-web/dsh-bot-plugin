import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { eventNdjson } from '../../src/bot-session-snapshot/canonical.ts'
import { SnapshotError } from '../../src/bot-session-snapshot/errors.ts'
import {
  createSnapshotStore,
  sha256Hex,
  SNAPSHOT_DIR_NAME,
  validateEventRange,
} from '../../src/bot-session-snapshot/store.ts'
import { event, memorySource, sequence } from './helpers.ts'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'bot-snapshot-'))
}

test('validateEventRange requires a contiguous seq starting at 0', () => {
  validateEventRange([], -1)
  validateEventRange(sequence(3), 2)
  assert.throws(
    () => validateEventRange(sequence(3), 3),
    (error: SnapshotError) => error.code === 'CONFLICT',
  )
  assert.throws(
    () => validateEventRange([event(1)], 1),
    (error: SnapshotError) => error.code === 'CONFLICT',
  )
  assert.throws(
    () => validateEventRange([event(0), event(2)], 2),
    (error: SnapshotError) => error.code === 'CONFLICT',
  )
})

test('create pins a cutoff, writes immutable files, and lists metadata', async () => {
  const dataDir = await tempDir()
  const logs = { 'bot-main': sequence(3) }
  const store = createSnapshotStore({
    dataDir,
    source: memorySource(logs),
    isBot: id => id === 'bot-main',
  })
  const created = await store.create('bot-main')
  assert.equal(created.version, 1)
  assert.equal(created.kind, 'main-session-event-log')
  assert.equal(created.scope, 'event-log-only')
  assert.equal(created.format, 'ndjson-v1')
  assert.equal(created.sourceSessionId, 'bot-main')
  assert.equal(created.afterSeq, -1)
  assert.equal(created.throughSeq, 2)
  assert.equal(created.count, 3)
  const { events } = store.get(created.snapshotId)
  assert.equal(sha256Hex(events), created.sha256)
  assert.equal(events.length, created.bytes)
  const listed = store.list('bot-main')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.snapshotId, created.snapshotId)
  // Later log growth must not change a published snapshot.
  logs['bot-main'] = sequence(6)
  const again = store.get(created.snapshotId)
  assert.equal(again.manifest.throughSeq, 2)
  assert.equal(again.manifest.count, 3)
  const next = await store.create('bot-main')
  assert.equal(next.throughSeq, 5)
  assert.equal(next.count, 6)
  assert.notEqual(next.snapshotId, created.snapshotId)
})

test('empty logs are published with throughSeq -1', async () => {
  const store = createSnapshotStore({
    dataDir: await tempDir(),
    source: memorySource({ 'bot-main': [] }),
    isBot: id => id === 'bot-main',
  })
  const created = await store.create('bot-main')
  assert.equal(created.throughSeq, -1)
  assert.equal(created.count, 0)
  assert.equal(created.bytes, 0)
})

test('refuses workers, ordinary sessions, and half-written directories', async () => {
  const dataDir = await tempDir()
  const store = createSnapshotStore({
    dataDir,
    source: memorySource({ 'bot-main': sequence(1), 'worker-1': sequence(1), ordinary: sequence(1) }),
    isBot: id => id === 'bot-main',
  })
  await assert.rejects(store.create('worker-1'), (error: SnapshotError) => error.code === 'FORBIDDEN')
  await assert.rejects(store.create('ordinary'), (error: SnapshotError) => error.code === 'FORBIDDEN')
  const created = await store.create('bot-main')
  const tmp = join(dataDir, SNAPSHOT_DIR_NAME, `.tmp-els_20990101T000000Z_deadbeef-1-abc`)
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'manifest.json'), '{"version":1}')
  const names = store.list('bot-main').map(item => item.snapshotId)
  assert.deepEqual(names, [created.snapshotId])
})

test('checksum mismatch is not treated as a published snapshot', async () => {
  const dataDir = await tempDir()
  const store = createSnapshotStore({
    dataDir,
    source: memorySource({ 'bot-main': sequence(2) }),
    isBot: id => id === 'bot-main',
  })
  const created = await store.create('bot-main')
  const eventsPath = join(dataDir, SNAPSHOT_DIR_NAME, created.snapshotId, 'events.ndjson')
  writeFileSync(eventsPath, `${readFileSync(eventsPath)}tamper`)
  assert.equal(store.list('bot-main').length, 0)
  assert.throws(
    () => store.get(created.snapshotId),
    (error: SnapshotError) => error.code === 'CORRUPT',
  )
})

test('concurrent creates for one session are serialized and both publish', async () => {
  const dataDir = await tempDir()
  const store = createSnapshotStore({
    dataDir,
    source: memorySource({ 'bot-main': sequence(4) }, { delay: 25 }),
    isBot: id => id === 'bot-main',
  })
  const [first, second] = await Promise.all([store.create('bot-main'), store.create('bot-main')])
  assert.notEqual(first.snapshotId, second.snapshotId)
  assert.equal(store.list('bot-main').length, 2)
  assert.equal(existsSync(join(dataDir, SNAPSHOT_DIR_NAME, first.snapshotId, 'manifest.json')), true)
  assert.equal(existsSync(join(dataDir, SNAPSHOT_DIR_NAME, second.snapshotId, 'events.ndjson')), true)
})

test('create does not write when the official log has a gap', async () => {
  const dataDir = await tempDir()
  const store = createSnapshotStore({
    dataDir,
    source: memorySource({ 'bot-main': [event(0), event(2)] }),
    isBot: id => id === 'bot-main',
  })
  await assert.rejects(store.create('bot-main'), (error: SnapshotError) => error.code === 'CONFLICT')
  assert.equal(existsSync(join(dataDir, SNAPSHOT_DIR_NAME)) && store.list('bot-main').length === 0, true)
})

test('canonical bytes stay stable for the published cutoff', async () => {
  const events = sequence(2)
  const store = createSnapshotStore({
    dataDir: await tempDir(),
    source: memorySource({ 'bot-main': events }),
    isBot: id => id === 'bot-main',
  })
  const created = await store.create('bot-main')
  const published = store.get(created.snapshotId)
  assert.deepEqual(published.events, eventNdjson(events).bytes)
})
