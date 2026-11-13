import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { dshBin, nodeBin } from './dsh-bin.ts'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = nodeBin()
const DSH = dshBin(ROOT)

/**
 * Real DSH 0.2.2-rc.1 plus the mock provider. Two child sessions of the same
 * bot overlap (both unfinished), a third ticket queues, and after one child
 * is cancelled the queued ticket starts. This is not the mock-host unit test.
 */
test('real DSH host: two workers overlap, a third queues, then starts after a slot frees', {
  timeout: 180000,
}, async t => {
  assert.ok(DSH !== '' && existsSync(DSH), 'set DSH_BIN to the @deepseek-ai/dsh@0.2.2-rc.1 bin.js')
  const home = mkdtempSync(join(tmpdir(), 'sf-work-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sf-work-work-'))
  const patch = join(work, 'patch.yml')
  writeFileSync(
    patch,
    `
- id: agent-default-model
  config:
    provider: foundations-mock
    model: mock-1
- insert:
    - id: foundations-mock
      name: ${JSON.stringify(join(ROOT, 'fixtures/mock-llm.mjs'))}
    - id: session-foundations
      name: ${JSON.stringify(join(ROOT, 'dist/index.js'))}
      config:
        contextWindow: 128000
        work:
          perBot: 2
          global: 4
          perBotQueue: 2
          globalQueue: 4
          workerWallMs: 10000
          leaseMs: 1000
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const port = 31994
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', HOME: home, PATH: process.env.PATH }
  delete (env as Record<string, unknown>).DSH_BOT_WORK_BUDGET
  const logPath = join(work, 'dsh.log')
  let child = start(env, patch, port, logPath)
  try {
    const token = await waitForToken(child, logPath)
    let cookie = await exchange(origin, token)
    const created = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
    const sessionId = created.result?.value?.sessionId
    assert.equal(typeof sessionId, 'string')
    await rpc(origin, cookie, 'session/selectModel', {
      request: { sessionId, provider: 'foundations-mock', model: 'mock-1' },
    })
    await plugin(origin, cookie, '/session-foundations/api/sessions/mark', { sessionId })

    const first = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
      sessionId,
      briefing: 'FOUNDATIONS_DELAY 20000\nfirst overlapping worker',
      idempotencyKey: 'host-one',
    })
    const second = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
      sessionId,
      briefing: 'FOUNDATIONS_DELAY 20000\nsecond overlapping worker',
      idempotencyKey: 'host-two',
    })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.queued, false)
    assert.equal(second.queued, false)
    assert.equal(typeof first.childSessionId, 'string')
    assert.equal(typeof second.childSessionId, 'string')
    assert.notEqual(first.childSessionId, second.childSessionId)
    assert.equal(['enqueued', 'started'].includes(first.ticketStatus), true)
    assert.equal(['enqueued', 'started'].includes(second.ticketStatus), true)

    const firstEvents = await eventsOf(origin, cookie, first.childSessionId)
    const secondEvents = await eventsOf(origin, cookie, second.childSessionId)
    assert.equal(
      firstEvents.some((event: any) => event.type === 'turn/end'),
      false,
      'first child is still running',
    )
    assert.equal(
      secondEvents.some((event: any) => event.type === 'turn/end'),
      false,
      'second child is still running',
    )
    const toolNames = toolNamesOf(firstEvents)
    writeFileSync(
      join(work, 'child-tools.json'),
      JSON.stringify({ first: toolNames, eventsHead: firstEvents.slice(0, 8) }, null, 2),
    )
    assert.equal(toolNames.includes('bash'), true, 'plugin-created workers should see official bash')
    assert.equal(toolNames.includes('read') && toolNames.includes('write'), true)

    const third = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
      sessionId,
      briefing: 'FOUNDATIONS_DELAY 5000\nqueued until a slot frees',
      idempotencyKey: 'host-three',
    })
    assert.equal(third.ok, true)
    assert.equal(third.queued, true)
    assert.equal(third.childSessionId == null, true)
    assert.equal(third.ticketStatus, 'accepted')

    const cancelled = await plugin(origin, cookie, '/session-foundations/api/work/cancel', {
      sessionId,
      ticketId: first.ticketId,
    })
    assert.equal(cancelled.ok, true)

    const started = Date.now()
    let promoted: any = null
    while (Date.now() - started < 20000) {
      const detail = await pluginGet(
        origin,
        cookie,
        `/session-foundations/api/work/ticket?id=${encodeURIComponent(third.ticketId)}`,
      )
      if (detail.ticket?.status === 'enqueued' || detail.ticket?.status === 'started') {
        promoted = detail.ticket
        break
      }
      await plugin(origin, cookie, '/session-foundations/api/work/tick', { sessionId })
      await delay(250)
    }
    assert.ok(promoted, 'the queued ticket started after a slot freed')
    assert.equal(typeof promoted.child_session_id, 'string')
    const stillSecond = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/work/ticket?id=${encodeURIComponent(second.ticketId)}`,
    )
    assert.equal(['enqueued', 'started'].includes(stillSecond.ticket.status), true)
    const secondStill = await eventsOf(origin, cookie, second.childSessionId)
    assert.equal(
      secondStill.some((event: any) => event.type === 'turn/end'),
      false,
      'second child still overlaps the promoted third',
    )
    // Free the original slots before proving real host pre-step suspension.
    for (const ticketId of [second.ticketId, third.ticketId]) {
      await plugin(origin, cookie, '/session-foundations/api/work/cancel', { sessionId, ticketId })
    }
    await t.test(
      'official async pre-step blocks model requests past lease and host wall, then resumes the same turn',
      async () => {
        const paused = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
          sessionId,
          briefing: 'FOUNDATIONS_QUOTA_LOOP',
          idempotencyKey: 'host-quota',
          budget: { maxTokens: 1000, wallMs: 1000 },
        })
        const detail = () =>
          pluginGet(origin, cookie, `/session-foundations/api/work/ticket?id=${encodeURIComponent(paused.ticketId)}`)
        let waiting: any
        for (let i = 0; i < 100; i++) {
          waiting = await detail()
          if (JSON.parse(waiting.ticket.budget_json).quota?.phase === 'waiting') break
          await delay(100)
        }
        assert.equal(
          JSON.parse(waiting.ticket.budget_json).quota?.phase,
          'waiting',
          'the actual host reached the suspended pre-step',
        )
        const initial = await eventsOf(origin, cookie, paused.childSessionId)
        const countRequests = (events: any[]) => events.filter(event => event.type === 'assistant/message').length
        assert.equal(countRequests(initial), 1)
        assert.equal(
          initial.some((event: any) => event.type === 'turn/end'),
          false,
        )
        await delay(10500) // Past both the configured 1s lease and 10s host active-wall cap.
        assert.equal(
          countRequests(await eventsOf(origin, cookie, paused.childSessionId)),
          1,
          'no second mock model call during wait',
        )
        const still = await detail()
        assert.equal(still.ticket.status, 'started')
        const small = await grantThroughMockMain(
          origin,
          cookie,
          sessionId,
          { ticketId: paused.ticketId, maxTokens: 500 },
          1500,
        )
        assert.equal(small.waitingBudget, true)
        assert.equal(small.usedTokens, 2000)
        await delay(500)
        assert.equal(countRequests(await eventsOf(origin, cookie, paused.childSessionId)), 1)
        const enough = await grantThroughMockMain(
          origin,
          cookie,
          sessionId,
          { ticketId: paused.ticketId, maxTokens: 5000, wallMs: 5000 },
          6500,
        )
        assert.equal(enough.ok, true)
        assert.equal(enough.waitingBudget, false)
        let final: any
        for (let i = 0; i < 100; i++) {
          final = await detail()
          if (final.ticket.status === 'ready') break
          await delay(100)
        }
        assert.equal(final.ticket.status, 'ready', JSON.stringify({ ticket: final.ticket, events: final.events }))
        assert.equal(final.ticket.active_attempt_id, waiting.ticket.active_attempt_id)
        assert.equal(final.ticket.child_session_id, paused.childSessionId)
        assert.equal(final.attempts.length, 1)
        const events = await eventsOf(origin, cookie, paused.childSessionId)
        assert.equal(events.filter((event: any) => event.type === 'turn/start').length, 1)
        assert.equal(countRequests(events), 3)
        assert.equal(JSON.parse(final.ticket.budget_json).quota.tokens, 2028)
        t.diagnostic(
          `model-free DSH: committed mock model messages while paused=1, after grant=3; same child/attempt/turn; cumulative tokens=2028`,
        )
      },
    )
    await t.test(
      'a paused ticket survives process restart without dispatch, then explicit grant re-enters the same child in a new turn',
      async () => {
        const paused = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
          sessionId,
          briefing: 'FOUNDATIONS_QUOTA_LOOP',
          idempotencyKey: 'host-quota-restart',
          budget: { maxTokens: 1000, wallMs: 1000 },
        })
        const detail = () =>
          pluginGet(origin, cookie, `/session-foundations/api/work/ticket?id=${encodeURIComponent(paused.ticketId)}`)
        let before: any
        for (let i = 0; i < 100; i++) {
          before = await detail()
          if (JSON.parse(before.ticket.budget_json).quota?.phase === 'waiting') break
          await delay(100)
        }
        assert.equal(JSON.parse(before.ticket.budget_json).quota?.waiting, true)
        await stop(child)
        writeFileSync(logPath, '')
        child = start(env, patch, port, logPath)
        cookie = await exchange(origin, await waitForToken(child, logPath))
        await delay(1500)
        assert.equal(
          (await eventsOf(origin, cookie, paused.childSessionId)).filter((e: any) => e.type === 'assistant/message')
            .length,
          1,
        )
        assert.equal((await detail()).ticket.status, 'started')
        const grant = await grantThroughMockMain(
          origin,
          cookie,
          sessionId,
          { ticketId: paused.ticketId, maxTokens: 5000, wallMs: 5000 },
          6000,
        )
        assert.equal(grant.continuation, 'same-session-new-turn')
        let final: any
        for (let i = 0; i < 100; i++) {
          final = await detail()
          if (final.ticket.status === 'ready') break
          await delay(100)
        }
        assert.equal(final.ticket.status, 'ready', JSON.stringify({ ticket: final.ticket, events: final.events }))
        assert.equal(final.ticket.active_attempt_id, before.ticket.active_attempt_id)
        assert.equal(final.ticket.child_session_id, paused.childSessionId)
        assert.equal(final.attempts.length, 1)
        assert.equal(final.attempts[0].fencing_token, before.attempts[0].fencing_token)
        assert.equal(
          final.ticket.briefing_revision,
          before.ticket.briefing_revision + 1,
          'new input generation fences the disposed turn result',
        )
        const events = await eventsOf(origin, cookie, paused.childSessionId)
        assert.equal(
          events.filter((e: any) => e.type === 'turn/start').length,
          2,
          'disposed turns are not falsely called seamless',
        )
        assert.equal(events.filter((e: any) => e.type === 'assistant/message').length, 3)
        assert.equal(JSON.parse(final.ticket.budget_json).quota.tokens, 2028)
        t.diagnostic(
          'model-free restart: no request on restore; explicit grant resumed same ticket/attempt/fence/child in a new turn',
        )
      },
    )
    await t.test(
      'deny and cancellation terminate actual suspended native turns without another mock request',
      async () => {
        for (const action of ['deny', 'cancel']) {
          const job = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
            sessionId,
            briefing: 'FOUNDATIONS_QUOTA_LOOP',
            idempotencyKey: `host-quota-${action}`,
            budget: { maxTokens: 1000, wallMs: 1000 },
          })
          const detail = () =>
            pluginGet(origin, cookie, `/session-foundations/api/work/ticket?id=${encodeURIComponent(job.ticketId)}`)
          let row: any
          for (let i = 0; i < 100; i++) {
            row = await detail()
            if (JSON.parse(row.ticket.budget_json).quota?.phase === 'waiting') break
            await delay(100)
          }
          assert.equal(JSON.parse(row.ticket.budget_json).quota?.phase, 'waiting')
          if (action === 'deny')
            await grantThroughMockMain(origin, cookie, sessionId, { ticketId: job.ticketId, deny: true }, null)
          else
            await plugin(origin, cookie, '/session-foundations/api/work/cancel', { sessionId, ticketId: job.ticketId })
          let events: any[] = []
          for (let i = 0; i < 100; i++) {
            events = await eventsOf(origin, cookie, job.childSessionId)
            if (events.some(event => event.type === 'turn/end')) break
            await delay(100)
          }
          assert.equal(events.filter(event => event.type === 'assistant/message').length, 1)
          assert.match(
            JSON.stringify(events.find(event => event.type === 'turn/end')?.data.reason),
            action === 'deny' ? /grant-denied/ : /ticket-cancel/,
          )
          assert.equal((await detail()).ticket.status, action === 'deny' ? 'failed' : 'cancelled')
        }
      },
    )
    // Plugin ctx.logger info is not printed by DSH 0.2.2-rc.1; the slot caps
    // are proven by the queue and promotion behavior above, not the process log.
  } finally {
    await stop(child)
  }
})

/** Exercise the real bot-only tool; there is deliberately no public grant API. */
async function grantThroughMockMain(
  origin: string,
  cookie: string,
  sessionId: string,
  args: Record<string, unknown>,
  total: number | null,
) {
  await rpc(origin, cookie, 'session/prompt', {
    request: {
      sessionId,
      requestId: crypto.randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: `FOUNDATIONS_TOOL foundations_grant ${JSON.stringify(args)}` }],
    },
  })
  function find(value: unknown): any {
    if (typeof value === 'string') {
      try {
        return find(JSON.parse(value))
      } catch {
        return null
      }
    }
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (
      row.ticketId === args.ticketId &&
      (total == null ? row.denied === true : row.maxTokens === total) &&
      row.ok === true
    )
      return row
    for (const child of Object.values(row)) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  for (let i = 0; i < 100; i++) {
    for (const event of await eventsOf(origin, cookie, sessionId)) {
      if (event.type === 'tool/result') {
        const found = find(event.data)
        if (found) return found
      }
    }
    await delay(100)
  }
  throw new Error('Mock main did not return the expected explicit grant result')
}

function toolNamesOf(events: any[]) {
  const names = new Set<string>()
  for (const event of events) {
    const tools = event.data?.tools ?? event.data?.header?.tools ?? event.tools
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (typeof tool === 'string') names.add(tool)
        else if (tool && typeof tool.name === 'string') names.add(tool.name)
      }
    }
  }
  return [...names].sort()
}

function start(env: any, patch: any, port: any, logPath: any) {
  const child = spawn(
    NODE,
    [DSH, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', chunk => writeFileSync(logPath, chunk, { flag: 'a' }))
  child.stderr.on('data', chunk => writeFileSync(logPath, chunk, { flag: 'a' }))
  return Object.assign(child, { logPath })
}

async function waitForToken(child: any, logPath: any) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    if (child.exitCode != null) {
      throw new Error(`dsh exited ${child.exitCode}\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
    }
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const match = /token=([A-Za-z0-9._~+-]+)/.exec(log)
    if (match) return match[1]
    if (/Error|failed to/i.test(log) && /plugin|session-foundations|mock/.test(log)) {
      throw new Error(log.slice(-4000))
    }
    await delay(250)
  }
  throw new Error(`timed out waiting for dsh\n${existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : ''}`)
}

async function exchange(origin: any, token: any) {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ')
  if (cookie === '') throw new Error(`token exchange HTTP ${response.status}`)
  return cookie
}

async function rpc(origin: any, cookie: any, method: any, args: any) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method} HTTP ${response.status} not json: ${text.slice(0, 500)}`)
  }
  if (body?.result?.ok === false) {
    throw new Error(`${method} failed ${JSON.stringify(body.result.error ?? body).slice(0, 800)}`)
  }
  return { status: response.status, result: body?.result }
}

async function plugin(origin: any, cookie: any, path: any, body: any) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie, origin },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${path} HTTP ${response.status} not json: ${text.slice(0, 500)}`)
  }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

async function pluginGet(origin: any, cookie: any, path: any) {
  const response = await fetch(`${origin}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json', cookie, origin },
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${path} HTTP ${response.status} not json: ${text.slice(0, 500)}`)
  }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

async function eventsOf(origin: any, cookie: any, sessionId: any) {
  const page = await rpc(origin, cookie, 'session/events', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 400 },
  })
  const value = page.result?.value ?? page.result
  const records = value?.records ?? value?.events ?? value?.items ?? []
  if (!Array.isArray(records)) return []
  return records.map((record: any) => (record?.type === 'event' && record.event ? record.event : record))
}

async function stop(child: any) {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  const started = Date.now()
  while (child.exitCode == null && Date.now() - started < 8000) await delay(100)
  if (child.exitCode == null) child.kill('SIGKILL')
}
