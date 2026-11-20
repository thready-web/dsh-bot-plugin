import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import { appendCardRecord, createCardLog, type CardRequest } from '../src/card-log.ts'
import type { HostContext } from '../src/host.ts'
import { openStore } from '../src/store.ts'

test('a card record is written once and a closed session stays pending until flush', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-card-log-'))
  const store = openStore(dir)
  const appended: Array<{ type: string; data: unknown }> = []
  let live = false
  let seq = 3
  const cards = createCardLog(store.db, {
    session: () => (live ? ({} as never) : null),
    append: (_session, type, data) => {
      appended.push({ type, data })
      seq += 1
      return seq
    },
  })
  const ctx = {} as HostContext
  const request: CardRequest = {
    kind: 'worker',
    key: 't1',
    sessionId: 'bot-a',
    payload: { ticketId: 't1', summary: 'sort the notes', status: 'accepted' },
  }
  try {
    assert.equal(cards.record(ctx, request), null)
    assert.equal(appended.length, 0)
    live = true
    assert.equal(cards.flush(ctx), undefined)
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.type, 'plugin:foundations/worker')
    assert.equal(cards.record(ctx, request), 4)
    assert.equal(appended.length, 1)
  } finally {
    store.close()
  }
})

test('a card record appends through the module that constructed the Session', async () => {
  const hostFile = new URL('../../../.run/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js', import.meta.url)
  if (!existsSync(hostFile)) return
  const host = (await import(hostFile.href)) as {
    Session: { create(id: string): Session & { snapshotEvents(): Array<{ type: string; data: unknown }> } }
  }
  const session = host.Session.create('session-card-module')
  const localAppend = appendPluginRecord as (session: Session, type: string, data: unknown) => number
  const payload = { ticketId: 't-host', summary: 'sort the notes', status: 'accepted' }
  assert.throws(() => localAppend(session, 'plugin:foundations/worker', payload), TypeError)
  const dir = mkdtempSync(join(tmpdir(), 'sf-card-log-'))
  const store = openStore(dir)
  const cards = createCardLog(store.db, {
    session: () => session,
    append: appendCardRecord,
  })
  const ctx = {} as HostContext
  const request: CardRequest = {
    kind: 'worker',
    key: 't-host',
    sessionId: 'session-card-module',
    payload,
  }
  try {
    const seq = cards.record(ctx, request)
    assert.equal(seq, 0)
    assert.equal(session.snapshotEvents().at(-1)?.type, 'plugin:foundations/worker')
    assert.deepEqual(session.snapshotEvents().at(-1)?.data, payload)
  } finally {
    store.close()
  }
})
