import { strict as assert } from 'node:assert'
import test from 'node:test'
import { forgetWorker, rememberWorker, retainWorkers, workerHandle } from '../src/worker-handles.ts'

test('plugin unload keeps worker handles and only forget disposes one', async () => {
  const disposed: string[] = []
  rememberWorker('worker-a', {
    dispose: async () => {
      disposed.push('a')
    },
  })
  rememberWorker('worker-b', {
    dispose: async () => {
      disposed.push('b')
    },
  })
  assert.deepEqual(retainWorkers().sort(), ['worker-a', 'worker-b'])
  assert.deepEqual(disposed, [])
  assert.equal(workerHandle('worker-a') != null, true)

  await forgetWorker('worker-a')
  assert.deepEqual(disposed, ['a'])
  assert.equal(workerHandle('worker-a'), undefined)
  assert.equal(workerHandle('worker-b') != null, true)
  assert.deepEqual(retainWorkers(), ['worker-b'])

  await forgetWorker('worker-b')
  assert.deepEqual(disposed, ['a', 'b'])
  assert.deepEqual(retainWorkers(), [])
})
