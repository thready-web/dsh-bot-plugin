import assert from 'node:assert/strict'
import test from 'node:test'
import { forgetUnauthorized, reloadForUnauthorized } from './unauthorized-reload.ts'

function store() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as unknown as Storage
}

function location() {
  const reloads: number[] = []
  return {
    reloads,
    target: { reload: () => void reloads.push(1) } as unknown as Pick<Location, 'reload'>,
  }
}

test('a 401 asks the browser for the document again', () => {
  const storage = store()
  const target = location()
  assert.equal(reloadForUnauthorized(target.target, storage, 1_000), true)
  assert.equal(target.reloads.length, 1)
})

test('a second 401 inside the window does not reload again', () => {
  const storage = store()
  const target = location()
  assert.equal(reloadForUnauthorized(target.target, storage, 1_000), true)
  assert.equal(reloadForUnauthorized(target.target, storage, 1_500), false)
  assert.equal(target.reloads.length, 1)
})

test('the guard opens again after the window, and after a success', () => {
  const storage = store()
  const target = location()
  reloadForUnauthorized(target.target, storage, 1_000)
  assert.equal(reloadForUnauthorized(target.target, storage, 12_000), true)
  assert.equal(target.reloads.length, 2)

  forgetUnauthorized(storage)
  assert.equal(reloadForUnauthorized(target.target, storage, 12_500), true)
  assert.equal(target.reloads.length, 3)
})

test('the module knows nothing about a login path or a provider', () => {
  const source = String(reloadForUnauthorized)
  for (const word of ['trial-login', 'login', 'cloudflare', 'access', '401', 'token']) {
    assert.equal(source.toLowerCase().includes(word.toLowerCase()), false)
  }
})
