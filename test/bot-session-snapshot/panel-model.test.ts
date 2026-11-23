import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  applyCreateResult,
  applyListResult,
  blockedReason,
  canCreateSnapshot,
  initialSnapshotPanelState,
} from '../../src/bot-session-snapshot/panel-model.ts'
import type { BackupManifest } from '../../src/bot-session-snapshot/types.ts'

const copy = {
  create: 'Create',
  creating: 'Creating',
  empty: 'Empty',
  error: 'Pick a session',
  worker: 'Workers are not backed up here',
  ordinary: 'Only a main Bot session',
}

const manifest = {
  version: 1,
  kind: 'main-session-event-log',
  scope: 'event-log-only',
  format: 'ndjson-v1',
  snapshotId: 'els_20261123T010000Z_aaaaaaaa',
  sourceSessionId: 'bot-main',
  createdAt: '2026-11-23T01:00:00.000Z',
  afterSeq: -1,
  throughSeq: 2,
  count: 3,
  bytes: 10,
  sha256: 'abc',
} as BackupManifest

test('panel model allows create only for main Bot sessions', () => {
  assert.equal(canCreateSnapshot({ sessionId: 'bot-main', isBot: true, isWorker: false }), true)
  assert.equal(canCreateSnapshot({ sessionId: 'worker-1', isBot: false, isWorker: true }), false)
  assert.equal(blockedReason({ sessionId: 'worker-1', isBot: false, isWorker: true }, copy), copy.worker)
  assert.equal(blockedReason({ sessionId: 'plain', isBot: false, isWorker: false }, copy), copy.ordinary)
})

test('panel model prepends a created snapshot and surfaces errors', () => {
  const loaded = applyListResult(initialSnapshotPanelState(), { ok: true, snapshots: [] })
  const created = applyCreateResult(loaded, { ok: true, snapshot: manifest })
  assert.equal(created.snapshots[0]?.snapshotId, manifest.snapshotId)
  const failed = applyCreateResult(created, { ok: false, message: 'nope' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.message, 'nope')
  assert.equal(failed.snapshots.length, 1)
})
