import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeleteEvent, readDeleteEvents } from './delete-job.ts'
import { forgetLogCache, createIdbCheckpoint } from './sync/checkpoint.ts'
import { installFakeIndexedDB } from './sync/fake-idb.ts'

test('parseDeleteEvent reads a progress line', () => {
  assert.equal(parseDeleteEvent(''), null)
  assert.equal(parseDeleteEvent('not-json'), null)
  assert.deepEqual(parseDeleteEvent('{"phase":"stop","percent":30}'), { phase: 'stop', percent: 30 })
  assert.deepEqual(parseDeleteEvent('{"phase":"done","percent":90,"deletedSessionIds":["session-a", 1]}'), {
    phase: 'done',
    percent: 90,
    deletedSessionIds: ['session-a'],
  })
})

test('readDeleteEvents yields each line', async () => {
  const chunks = [
    new TextEncoder().encode('{"phase":"fence","percent":10}\n{"phase":'),
    new TextEncoder().encode('"done","percent":90}\n'),
  ]
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  )
  const seen: string[] = []
  const last = await readDeleteEvents(response, event => seen.push(event.phase))
  assert.deepEqual(seen, ['fence', 'done'])
  assert.equal(last?.phase, 'done')
})

test('forgetLogCache drops one session and leaves another', async () => {
  const fake = installFakeIndexedDB()
  const checkpoint = await createIdbCheckpoint(fake)
  const event = { type: 'user/message', seq: 1, time: 1, data: {} }
  await checkpoint.putEvents('session-keep', [event])
  await checkpoint.putEvents('session-drop', [{ ...event, seq: 2 }])
  await checkpoint.setCursor('session-drop', 2, 2)
  await checkpoint.setCursor('session-keep', 1, 1)
  await forgetLogCache(['session-drop'], fake)
  assert.deepEqual(await checkpoint.readEvents('session-drop'), [])
  assert.equal((await checkpoint.readEvents('session-keep')).length, 1)
  assert.equal(await checkpoint.getCursor('session-drop'), null)
  assert.deepEqual(await checkpoint.getCursor('session-keep'), { appliedSeq: 1, headSeq: 1 })
})
