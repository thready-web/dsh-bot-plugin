import { strict as assert } from 'node:assert'
import test from 'node:test'
import { SnapshotError } from '../../src/bot-session-snapshot/errors.ts'
import { assertMainBotSession, isWorkerSessionId } from '../../src/bot-session-snapshot/select.ts'

test('rejects missing, worker, and ordinary sessions', () => {
  const isBot = (id: string) => id === 'bot-main'
  assert.equal(isWorkerSessionId('worker-ticket-1'), true)
  assert.equal(isWorkerSessionId('worker-'), false)
  assert.throws(
    () => assertMainBotSession('', isBot),
    (error: SnapshotError) => error.code === 'VALIDATION',
  )
  assert.throws(
    () => assertMainBotSession('worker-ticket-1', isBot),
    (error: SnapshotError) => error.code === 'FORBIDDEN',
  )
  assert.throws(
    () => assertMainBotSession('../etc/passwd', isBot),
    (error: SnapshotError) => error.code === 'VALIDATION',
  )
  assert.throws(
    () => assertMainBotSession('plain-session', isBot),
    (error: SnapshotError) => error.code === 'FORBIDDEN',
  )
  assert.equal(assertMainBotSession('bot-main', isBot), 'bot-main')
})
