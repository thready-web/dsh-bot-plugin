import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthorizationController } from '../src/authorization.ts'
import { createEngine } from '../src/engine.ts'
import { registerHttp } from '../src/http.ts'
import { openStore } from '../src/store.ts'
import { openPageLive } from '../src/work-http.ts'

// Uses native-service stand-ins and in-process HTTP only. No login/model/worker.
test('compact interactions omit provider enumeration; legacy APIs retain the full catalog', async t => {
  let lists = 0
  const directory = Array.from({ length: 40 }, (_, index) => ({
    key: `provider-${index}`,
    label: `Provider ${index}`,
    methods: [{ id: 'api-key', label: 'Provider credentials or browser authorization' }],
    inFlight: false,
  }))
  const authorization = createAuthorizationController()
  authorization.bind({
    get: () => ({
      list: () => {
        lists++
        return directory
      },
    }),
  } as any)
  const dir = mkdtempSync(join(tmpdir(), 'sf-interaction-http-'))
  const store = openStore(dir)
  const routes: Array<{ path: string; handler(req: any, res: any): unknown }> = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register(route: (typeof routes)[number]) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const questionCalls: string[] = []
  registerHttp(
    ctx as any,
    createEngine(store),
    () => null,
    () => null,
    '',
    () =>
      ({
        snapshot: (id: string) => {
          questionCalls.push(id)
          return [{ callId: 'official-ask', timed: true, waitState: 'waiting' }]
        },
      }) as any,
    {
      getAuthorization: () => authorization,
      getApprovals: () => ({ snapshot: () => [{ requestId: 'native-approval', state: 'open' }] }) as any,
    },
  )
  const handler = routes.find(route => route.path === '/dsh-bot')!.handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const small = await (await fetch(`${origin}/dsh-bot/api/interactions?sessionId=one&compact=1`)).json()
    assert.equal(lists, 0)
    assert.equal(small.authorization.entries, undefined)
    assert.equal(small.questions[0].callId, 'official-ask')
    assert.equal(small.approvals[0].state, 'open')
    assert.deepEqual(questionCalls, ['one'])
    const full = await (await fetch(`${origin}/dsh-bot/api/interactions?sessionId=one`)).json()
    assert.equal(full.authorization.entries.length, 40)
    assert.equal(lists, 1)
    const catalog = await (await fetch(`${origin}/dsh-bot/api/authorization`)).json()
    assert.equal(catalog.entries.length, 40)
    const compactBytes = Buffer.byteLength(JSON.stringify(small))
    const legacyBytes = Buffer.byteLength(JSON.stringify(full))
    assert.ok(compactBytes < legacyBytes / 5)
    t.diagnostic(`40-provider fixture payload: legacy=${legacyBytes} bytes, compact=${compactBytes} bytes`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing page SSE samples native interaction snapshots without catalog reads or waiting on desk RPC', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const chunks: string[] = []
  const callbacks = new Map<string, Array<(...args: any[]) => void>>()
  let samples = 0
  let unreadable = false
  let value = {
    ok: true,
    sessionId: 'one',
    questions: [] as unknown[],
    approvals: [] as unknown[],
    authorization: { prompts: [] as unknown[], notices: [] as unknown[] },
  }
  let ended = false
  const request = {
    on: (name: string, fn: (...args: any[]) => void) => {
      callbacks.set(name, [...(callbacks.get(name) ?? []), fn])
    },
  }
  const pending = openPageLive(
    request,
    {
      get writableEnded() {
        return ended
      },
      writeHead() {},
      write: text => chunks.push(text),
      end() {
        ended = true
      },
      on() {},
    },
    {
      workStamp: () => 'same',
      workBoard: () => ({}),
      loadDesk: () => new Promise(() => {}),
      interactions: () => {
        samples++
        if (unreadable) throw new Error('Native snapshot temporarily unavailable')
        return value
      },
    },
  )
  const frames = () => chunks.filter(text => text.startsWith('event: interactions'))
  assert.equal(frames().length, 1)
  t.mock.timers.tick(60_000)
  assert.equal(frames().length, 1, 'connected idle sends no repeated interaction payload')
  unreadable = true
  t.mock.timers.tick(5000)
  assert.equal(
    chunks.filter(text => text.startsWith('event: interaction-error')).length,
    1,
    'snapshot failure emits one fallback signal, not one per tick',
  )
  unreadable = false
  value = {
    ...value,
    questions: [{ callId: 'continued', waitState: 'counting', remainingMs: 5000 }],
    approvals: [{ requestId: 'official', state: 'open' }],
    authorization: { prompts: [{ promptId: 'pending', kind: 'text' }], notices: [{ message: 'Login code' }] },
  }
  t.mock.timers.tick(1000)
  assert.equal(frames().length, 2, 'official changes arrive independently of stalled desk RPC')
  assert.match(frames()[1]!, /continued/)
  for (const callback of callbacks.get('close') ?? []) callback()
  await pending
  const before = samples
  t.mock.timers.tick(60_000)
  assert.equal(samples, before, 'sampler is cleaned up on disconnect')
  t.mock.timers.reset()
})

test('compact authorization carries official notices, prompts and flow state without listing providers', async () => {
  let lists = 0
  let answer = ''
  const auth = createAuthorizationController()
  auth.bind({
    get: () => ({
      list: () => {
        lists++
        return []
      },
      begin: async ({ interaction }: any) => {
        interaction.notify({ message: 'Use the browser', url: 'https://example.com/login' })
        answer = await interaction.prompt({ kind: 'text', message: 'Confirm the code' })
        return { status: 'authorized' }
      },
    }),
  } as any)
  const before = auth.snapshot({ catalog: false }).catalogRevision
  const pending = auth.begin({ key: 'sample', method: 'browser' })
  const active = auth.snapshot({ catalog: false })
  assert.equal(lists, 0)
  assert.deepEqual(active.inFlight, ['sample'])
  assert.equal(active.notices[0]!.message, 'Use the browser')
  assert.equal(active.prompts[0]!.message, 'Confirm the code')
  assert.notEqual(active.catalogRevision, before)
  auth.answer({ promptId: active.prompts[0]!.promptId, value: 'confirmed' })
  assert.equal((await pending).ok, true)
  assert.equal(answer, 'confirmed')
  assert.deepEqual(auth.snapshot({ catalog: false }).prompts, [])
  assert.deepEqual(auth.snapshot({ catalog: false }).inFlight, [])
  assert.notEqual(auth.snapshot({ catalog: false }).catalogRevision, active.catalogRevision)
  assert.equal(lists, 0)
})
