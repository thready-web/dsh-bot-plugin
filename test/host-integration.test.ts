import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { dshBin, nodeBin } from './dsh-bin.ts'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = nodeBin()
const DSH = dshBin(ROOT)

test('real DSH 0.2.2-rc.1 host: section, tools, isolation, restart, compaction', { timeout: 180000 }, async () => {
  assert.equal(
    NODE.includes('v24') || process.env.DSH_NODE != null || Number(process.versions.node.split('.')[0]) >= 24,
    true,
  )
  const version = await run(NODE, ['-p', 'process.versions.node'])
  assert.ok(
    Number(version.stdout.trim().split('.')[0]) >= 24,
    `host integration needs Node >= 24.9, got ${version.stdout}`,
  )
  assert.ok(DSH !== '' && existsSync(DSH), 'set DSH_BIN to the @deepseek-ai/dsh@0.2.2-rc.1 bin.js')
  const pkg = JSON.parse(readFileSync(join(DSH, '../../package.json'), 'utf8'))
  assert.equal(pkg.version, '0.2.2-rc.1')

  const home = mkdtempSync(join(tmpdir(), 'sf-dsh-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sf-dsh-work-'))
  const pathFile = join(work, 'sf-host-paths.txt')
  writeFileSync(pathFile, `${home}\n${work}\n`, { mode: 0o600 })
  console.log(`HOST_PATHS ${pathFile}`)
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
        traceEvents: true
        contextWindow: 128000
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const port = 31991
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    HOME: home,
    PATH: process.env.PATH,
  }
  const evidence: {
    mock: boolean
    realLlm: boolean
    dsh: string
    node: string
    baseChecks: string[]
    started?: boolean
    catalog?: unknown
    personaId?: string
    memoryA?: { facts: Array<{ content?: string }> }
    memoryB?: unknown
    contextMessagesBeforeCompact?: number
    sameMaterialContextCount?: number
    compactCommand?: unknown
    compactionEvents?: unknown
    epochAfterCompact?: unknown
    presenceAfterCompact?: unknown
    compactionNote?: string
    contextMessagesAfterCompact?: number
    contextMessagesAfterReinject?: number
    presenceAfterReinject?: unknown
    resumedSessions?: unknown
    sessionA?: string
    sessionFromStatus?: unknown
    sandbox?: boolean
    mnemon?: boolean
  } = { mock: true, realLlm: false, dsh: pkg.version, node: version.stdout.trim(), baseChecks: [] }
  let child = start(env, patch, port, join(work, 'dsh-1.log'))
  try {
    const token = await waitForToken(child, join(work, 'dsh-1.log'))
    const cookie = await exchange(origin, token)
    evidence.started = true
    const catalog = await rpc(origin, cookie, 'session/modelCatalog', {})
    evidence.catalog = catalog.result
    const createdA = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
    const createdB = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
    const sessionA = createdA.result?.value?.sessionId
    const sessionB = createdB.result?.value?.sessionId
    assert.equal(typeof sessionA, 'string')
    assert.notEqual(sessionA, sessionB)
    await rpc(origin, cookie, 'session/selectModel', {
      request: { sessionId: sessionA, provider: 'foundations-mock', model: 'mock-1' },
    })
    await rpc(origin, cookie, 'session/selectModel', {
      request: { sessionId: sessionB, provider: 'foundations-mock', model: 'mock-1' },
    })
    await plugin(origin, cookie, '/session-foundations/api/sessions/mark', { sessionId: sessionA })

    const persona = await plugin(origin, cookie, '/session-foundations/api/persona/confirm', {
      text: 'You are the local test persona. Do not claim permissions you were not granted.',
      sessionId: sessionA,
    })
    assert.equal(persona.ok, true)
    evidence.personaId = persona.persona.id

    const skillDir = join(home, 'profiles', 'web', 'session-foundations', 'src', 'skills', 'private', sessionA, 'taste')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nversion: 0.1.0\ndescription: session A only\n---\nDo not grant tools.\n',
    )
    const registered = await plugin(origin, cookie, '/session-foundations/api/skills/register', {
      sessionId: sessionA,
      scope: 'private',
      skillId: 'taste',
    })
    assert.equal(registered.ok, true)

    await promptAndWait(
      origin,
      cookie,
      sessionA,
      `FOUNDATIONS_TOOL foundations_remember ${JSON.stringify({
        target: 'fact',
        content: 'The user is called Ada',
        idempotencyKey: 'host-remember',
        sessionId: sessionB,
      })}`,
    )
    const statusA = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/status?sessionId=${encodeURIComponent(sessionA)}`,
    )
    const memoryA = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/memory?sessionId=${encodeURIComponent(sessionA)}`,
    )
    const memoryB = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/memory?sessionId=${encodeURIComponent(sessionB)}`,
    )
    evidence.memoryA = memoryA
    evidence.memoryB = memoryB
    const adaActive = memoryA.facts.some(
      (fact: any) => fact.content === 'The user is called Ada' && fact.status === 'active',
    )
    assert.equal(adaActive, true, `sessionA has no active Ada fact; facts=${JSON.stringify(memoryA.facts ?? null)}`)
    assert.equal(memoryB.facts.length, 0)
    evidence.baseChecks.push('A5-foreign-session-ignored')

    await promptAndWait(
      origin,
      cookie,
      sessionB,
      `FOUNDATIONS_TOOL foundations_skill_load ${JSON.stringify({ skillId: 'taste', sessionId: sessionA })}`,
    )
    const eventsB = await eventsOf(origin, cookie, sessionB)
    const loadText = JSON.stringify(eventsB)
    assert.match(loadText, /NOT_FOUND|FORBIDDEN/)
    evidence.baseChecks.push('A4-skill-not-shared')

    await promptAndWait(origin, cookie, sessionA, 'hello')
    await promptAndWait(origin, cookie, sessionA, 'hello')
    let eventsA = await eventsOf(origin, cookie, sessionA)
    const contextMessages = eventsA.filter(isRuntimeContext)
    evidence.contextMessagesBeforeCompact = contextMessages.length
    assert.ok(
      eventsA.some(
        event =>
          textOfEvent(event).includes('You are the local test persona') ||
          textOfEvent(event).includes('foundations:rules') ||
          textOfEvent(event).includes('[foundations:'),
      ),
    )
    evidence.baseChecks.push('A1-prompt-visible')
    const sameHashDup = contextMessages.filter(
      event =>
        textOfEvent(event).includes('[foundations:user]') || textOfEvent(event).includes('The user is called Ada'),
    )
    evidence.sameMaterialContextCount = sameHashDup.length

    const compact = await rpc(origin, cookie, 'commands/execute', {
      agentId: sessionA,
      line: '/compact',
      submittedAttachments: [],
    })
    evidence.compactCommand = compact.result
    eventsA = await eventsOf(origin, cookie, sessionA)
    const compactTypes = eventsA.map(event => event.type).filter(type => String(type).startsWith('compaction/'))
    evidence.compactionEvents = compactTypes
    const statusAfter = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/status?sessionId=${encodeURIComponent(sessionA)}`,
    )
    evidence.epochAfterCompact = statusAfter.binding?.compaction_epoch ?? null
    evidence.presenceAfterCompact = statusAfter.view?.presence ?? null
    if (compactTypes.includes('compaction/end')) evidence.baseChecks.push('A6-compaction-observed')
    else evidence.compactionNote = 'host did not record compaction/end for commands/execute /compact'
    evidence.contextMessagesAfterCompact = eventsA.filter(isRuntimeContext).length

    await promptAndWait(origin, cookie, sessionA, 'after compact')
    eventsA = await eventsOf(origin, cookie, sessionA)
    const reinjected = eventsA.filter(isRuntimeContext)
    evidence.contextMessagesAfterReinject = reinjected.length
    assert.ok(reinjected.some(event => textOfEvent(event).includes('The user is called Ada')))
    assert.ok(reinjected.length > evidence.contextMessagesAfterCompact)
    const statusReinject = await pluginGet(
      origin,
      cookie,
      `/session-foundations/api/status?sessionId=${encodeURIComponent(sessionA)}`,
    )
    evidence.presenceAfterReinject = statusReinject.view?.presence ?? null
    assert.equal(statusReinject.view?.presence, 'present')
    evidence.baseChecks.push('A2-reinject-after-compact')
  } finally {
    await stop(child)
  }

  child = start(env, patch, port, join(work, 'dsh-2.log'))
  try {
    const token = await waitForToken(child, join(work, 'dsh-2.log'))
    const cookie = await exchange(origin, token)
    const sessionA = evidence.memoryA ? undefined : undefined
    const listed = await rpc(origin, cookie, 'session/list', { _request: {} })
    const ids = JSON.stringify(listed.result)
    assert.match(ids, /session-/)
    const remembered = evidence.memoryA!.facts.find(fact => fact.content === 'The user is called Ada')
    const sessionFromStatus = remembered ? undefined : undefined
    const sessions = extractIds(listed.result)
    evidence.resumedSessions = sessions
    let restored = null
    for (const sessionId of sessions) {
      const memory = await pluginGet(
        origin,
        cookie,
        `/session-foundations/api/memory?sessionId=${encodeURIComponent(sessionId)}`,
      )
      if (memory.facts?.some((fact: any) => fact.content === 'The user is called Ada')) restored = memory
    }
    assert.ok(restored, 'fact survived process restart')
    evidence.baseChecks.push('restart-memory')
    evidence.sessionA = sessionA
    evidence.sessionFromStatus = sessionFromStatus
  } finally {
    await stop(child)
  }
  evidence.sandbox = false
  evidence.mnemon = false
  console.log(`HOST_EVIDENCE ${JSON.stringify(evidence)}`)
  assert.ok(evidence.baseChecks.includes('A1-prompt-visible'))
  assert.ok(evidence.baseChecks.includes('A5-foreign-session-ignored'))
  assert.ok(evidence.baseChecks.includes('A4-skill-not-shared'))
  assert.ok(evidence.baseChecks.includes('A6-compaction-observed'))
  assert.ok(evidence.baseChecks.includes('A2-reinject-after-compact'))
  assert.ok(evidence.baseChecks.includes('restart-memory'))
})

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} patch
 * @param {number} port
 * @param {string} logPath
 */
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

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} logPath
 */
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

/**
 * @param {string} origin
 * @param {string} token
 */
async function exchange(origin: any, token: any) {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ')
  if (cookie === '') throw new Error(`token exchange HTTP ${response.status}`)
  return cookie
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} method
 * @param {Record<string, unknown>} args
 */
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

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} path
 * @param {unknown} body
 */
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

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} path
 */
async function pluginGet(origin: any, cookie: any, path: any) {
  const response = await fetch(`${origin}${path}`, { headers: { accept: 'application/json', cookie, origin } })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 * @param {string} text
 */
async function promptAndWait(origin: any, cookie: any, sessionId: any, text: any) {
  await rpc(origin, cookie, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
  const waited = await rpc(origin, cookie, 'session/wait', { request: { sessionId, timeoutMs: 20000 } })
  if (waited.result?.value?.reason === 'timeout') throw new Error(`turn timed out for ${text.slice(0, 80)}`)
  return waited
}

/**
 * @param {string} origin
 * @param {string} cookie
 * @param {string} sessionId
 */
async function eventsOf(origin: any, cookie: any, sessionId: any) {
  const page = await rpc(origin, cookie, 'session/events', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 400 },
  })
  const value = page.result?.value ?? page.result
  const records = value?.records ?? value?.events ?? value?.items ?? []
  if (!Array.isArray(records)) return []
  return records.map(record => (record?.type === 'event' && record.event ? record.event : record))
}

/**
 * @param {{ type?: string, data?: unknown }} event
 */
function isRuntimeContext(event: any) {
  return event.type === 'user/message' && textOfEvent(event).includes('[foundations:')
}

/**
 * @param {{ data?: { message?: { content?: unknown }, content?: unknown } }} event
 */
function textOfEvent(event: any) {
  return JSON.stringify(event.data ?? {})
}

/**
 * @param {unknown} value
 */
function extractIds(value: any) {
  const text = JSON.stringify(value)
  return [...text.matchAll(/session-[A-Za-z0-9-]+/g)].map(match => match[0])
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, stdout, stderr }))
  })
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
async function stop(child: any) {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  const started = Date.now()
  while (child.exitCode == null && Date.now() - started < 8000) await delay(100)
  if (child.exitCode == null) child.kill('SIGKILL')
}
