import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { dshBin, nodeBin } from './dsh-bin.ts'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = nodeBin()
const DSH = dshBin(ROOT)

/**
 * Real DSH 0.2.2-rc.1, mock provider. A worker in a restricted workspace runs
 * official bash: a harmless command with a non-zero exit, then a write outside
 * the workspace that must stay denied. Does not use a paid model.
 */
test('real DSH host: worker bash returns exit code and stays inside workspace-write', {
  timeout: 180000,
}, async () => {
  assert.ok(DSH !== '' && existsSync(DSH), 'set DSH_BIN to the @deepseek-ai/dsh@0.2.2-rc.1 bin.js')
  const home = mkdtempSync(join(tmpdir(), 'sf-bash-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sf-bash-work-'))
  // Official workspace-write allows the session cwd and platform temp dirs
  // (including /tmp). The denial probe must exist, and must not sit in either.
  const probeRoot = outsideWorkspaceProbe(work)
  assert.equal(insideWorkspaceWrite(probeRoot, work), false, `probe ${probeRoot} sits inside a workspace-write root`)
  const outside = join(probeRoot, 'outside.txt')
  const inside = join(work, 'inside.txt')
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
          perBot: 1
          global: 2
          perBotQueue: 2
          globalQueue: 4
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const port = 31995
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', HOME: home, PATH: process.env.PATH }
  delete (env as Record<string, unknown>).DSH_BOT_WORK_BUDGET
  const logPath = join(work, 'dsh.log')
  const child = start(env, patch, port, logPath)
  try {
    const token = await waitForToken(child, logPath)
    const cookie = await exchange(origin, token)
    const created = await rpc(origin, cookie, 'session/create', { request: { cwd: work } })
    const sessionId = created.result?.value?.sessionId
    assert.equal(typeof sessionId, 'string')
    await rpc(origin, cookie, 'session/selectModel', {
      request: { sessionId, provider: 'foundations-mock', model: 'mock-1' },
    })
    await plugin(origin, cookie, '/session-foundations/api/sessions/mark', { sessionId })

    const harmlessArg = JSON.stringify({
      command: "printf 'ok\\n' > ./inside.txt; printf 'ok\\n'; exit 7",
      description: 'write inside the workspace then exit 7',
    })
    const outsideArg = JSON.stringify({
      command: `printf leak > ${JSON.stringify(outside)}; printf done`,
      description: 'attempt a write outside the workspace and /tmp',
    })
    const dispatched = await plugin(origin, cookie, '/session-foundations/api/work/dispatch', {
      sessionId,
      briefing: `[foundations:briefing]
FOUNDATIONS_HOST_TOOL bash ${harmlessArg}
FOUNDATIONS_HOST_TOOL bash ${outsideArg}`,
      idempotencyKey: 'bash-host',
    })
    assert.equal(dispatched.ok, true)
    assert.equal(typeof dispatched.childSessionId, 'string')

    const started = Date.now()
    let events: any[] = []
    let results: any[] = []
    while (Date.now() - started < 45000) {
      events = await eventsOf(origin, cookie, dispatched.childSessionId)
      results = events.filter((event: any) => event.type === 'tool/result' || event.type === 'tool/call-result')
      if (results.length >= 2) break
      await delay(250)
    }
    writeFileSync(
      join(work, 'bash-events.json'),
      JSON.stringify({ events, results, tools: toolNamesOf(events) }, null, 2),
    )
    const tools = toolNamesOf(events)
    assert.equal(tools.includes('bash'), true, `worker tools were ${tools.join(',')}`)
    assert.equal(results.length >= 1, true, 'worker bash produced no tool result')
    const texts = results.map((event: any) => JSON.stringify(event.data ?? event)).join('\n')
    assert.match(texts, /ok/)
    assert.match(texts, /\[exit code: 7\]/)
    assert.equal(existsSync(inside), true, 'bash could not write inside the session workspace')
    assert.equal(
      existsSync(outside),
      false,
      'a write outside the workspace-write root succeeded; bash patch must not land',
    )
    const outsideResult = results
      .slice(1)
      .map((event: any) => JSON.stringify(event.data ?? event))
      .join('\n')
    assert.match(outsideResult, /read-only file system|sandbox|denied|permission/i)
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
    await stop(child)
  }
})

/** Create a writable probe outside session cwd and official temp roots. */
function outsideWorkspaceProbe(sessionCwd: string) {
  const bases = [join(homedir(), 'dsh-bot-plugin-bash-probes'), join(ROOT, '.tmp-bash-probes')]
  for (const base of bases) {
    if (insideWorkspaceWrite(base, sessionCwd)) continue
    mkdirSync(base, { recursive: true, mode: 0o700 })
    const probe = mkdtempSync(join(base, 'sf-bash-outside-'))
    if (insideWorkspaceWrite(probe, sessionCwd)) {
      rmSync(probe, { recursive: true, force: true })
      continue
    }
    return probe
  }
  throw new Error('could not create a probe directory outside workspace-write roots')
}

function insideWorkspaceWrite(path: string, sessionCwd: string) {
  return [sessionCwd, tmpdir(), '/tmp', '/var/tmp', '/dev/shm'].some(root => isInside(path, root))
}

function isInside(path: string, root: string) {
  if (!root) return false
  const resolvedRoot = existingPath(root)
  if (!resolvedRoot) return false
  const relativePath = relative(resolvedRoot, existingPath(path))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function existingPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
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
