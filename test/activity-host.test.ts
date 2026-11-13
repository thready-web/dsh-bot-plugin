/** Real rc.1 host, real bash, mock model, local HTTP API only (no browser or external service). */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { dshBin, nodeBin } from './dsh-bin.ts'
import { applyLogEvent, turnPieces } from '../ui/src/follow.ts'
import { emptyThread, type ToolSegment } from '../ui/src/types.ts'
import { toolPresentation } from '../ui/src/activity.ts'
import { currentActivity } from '../ui/src/current-activity.ts'

const ROOT = new URL('..', import.meta.url).pathname

test('activity: real shell commands, no-output, failure, background acknowledgement and todo replay', {
  timeout: 90000,
}, async () => {
  const bin = dshBin(ROOT)
  assert.ok(bin && existsSync(bin), 'set DSH_BIN to the rc.1 host')
  const home = mkdtempSync(join(tmpdir(), 'activity-home-'))
  const work = mkdtempSync(join(tmpdir(), 'activity-work-'))
  const patch = join(work, 'patch.yml')
  const logPath = join(work, 'host.log')
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
    - id: session-foundations-http
      name: ${JSON.stringify(join(ROOT, 'dist/http-plugin.js'))}
`,
  )
  const port = 31989
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(
    nodeBin(),
    [bin, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      env: { ...process.env, DSH_HOME: home, HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', c => writeFileSync(logPath, c, { flag: 'a' }))
  child.stderr.on('data', c => writeFileSync(logPath, c, { flag: 'a' }))
  try {
    let token = ''
    for (let i = 0; i < 120 && !token; i += 1) {
      assert.equal(child.exitCode, null, 'host exited before ready (log withheld to avoid credential disclosure)')
      const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
      token = /token=([A-Za-z0-9._~+-]+)/.exec(text)?.[1] ?? ''
      if (!token) await delay(250)
    }
    assert.ok(token, 'host readiness timeout (log withheld)')
    const exchanged = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const cookie = exchanged.headers
      .getSetCookie()
      .map(c => c.split(';', 1)[0])
      .join('; ')
    assert.ok(cookie, 'owner session exchange failed')
    const rpc = async (method: string, args: unknown): Promise<any> => {
      const response = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
      })
      assert.equal(response.status, 200, method)
      const body = (await response.json()) as any
      assert.notEqual(body.result?.ok, false, method)
      return body.result?.value ?? body.result
    }
    const { sessionId } = await rpc('session/create', { request: { cwd: work } })
    await rpc('session/selectModel', { request: { sessionId, provider: 'foundations-mock', model: 'mock-1' } })
    const run = async (name: string, args: unknown) => {
      await rpc('session/prompt', {
        request: {
          sessionId,
          requestId: crypto.randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: `FOUNDATIONS_TOOL ${name} ${JSON.stringify(args)}` }],
        },
      })
      const waited = await rpc('session/wait', { request: { sessionId, timeoutMs: 10000 } })
      assert.notEqual(waited.reason, 'timeout')
    }
    await run('bash', { command: "printf 'activity-ok\\n'", description: 'Print activity marker', workdir: work })
    await run('bash', { command: ':', description: 'Return no output', workdir: work })
    await run('bash', { command: 'exit 7', description: 'Return explicit failure', workdir: work })
    await run('bash', {
      command: "sleep 0.1; printf 'job-ok\\n'",
      description: 'Start a short background job',
      workdir: work,
      run_in_background: true,
    })
    await run('todo_write', {
      todos: [
        { content: 'Scaffold tea', status: 'completed' },
        { content: 'Verify tea', status: 'in_progress' },
      ],
    })
    const page = await rpc('session/events', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 2000 },
    })
    const events = (page.records as any[]).map(r => r.event ?? r).sort((a, b) => a.seq - b.seq)
    let state = emptyThread()
    for (const event of events) {
      const before = state.segments.filter((s): s is ToolSegment => s.kind === 'tool').map(s => [s.callId, s.seq])
      state = applyLogEvent(state, event)
      if (event.type === 'tool/result') {
        assert.deepEqual(
          state.segments.filter((s): s is ToolSegment => s.kind === 'tool').map(s => [s.callId, s.seq]),
          before,
          'a real result updates its call in place',
        )
      }
    }
    const tools = state.segments.filter((s): s is ToolSegment => s.kind === 'tool')
    const shell = tools.filter(t => t.name === 'bash')
    assert.equal(shell.length, 4, 'real bash tools must be available in the local host profile')
    const views = shell.map(t => toolPresentation(t, work))
    assert.ok(views[0]!.output.includes('activity-ok'))
    assert.equal(views[0]!.command, "printf 'activity-ok\\n'")
    assert.equal(views[0]!.description, 'Print activity marker')
    assert.equal(views[0]!.cwd, work)
    assert.equal(views[0]!.status, 'succeeded')
    assert.equal(views[1]!.status, 'succeeded')
    assert.equal(views[1]!.output, '(no output)')
    assert.equal(views[2]!.status, 'failed')
    assert.equal(views[2]!.exitCode, 7)
    assert.equal(views[3]!.status, 'background', 'acknowledgement must not report process completion')
    assert.ok(views[3]!.jobId)
    const todo = tools.find(t => t.name === 'todo_write')
    assert.ok(todo)
    assert.equal(toolPresentation(todo).todos.length, 2)
    assert.ok(shell.every(t => t.resultReceived && t.requestedAt != null && t.settledAt != null))
    // Same journal replay after refresh is identical, including calls whose output was empty.
    let replay = emptyThread()
    for (const event of events) replay = applyLogEvent(replay, event)
    assert.deepEqual(replay.segments, state.segments)
    const process = state.segments.filter(s => s.kind !== 'user')
    const pieces = turnPieces(process)
    assert.deepEqual(
      pieces.flatMap(piece => (piece.type === 'activity' ? piece.segments.map(s => s.id) : [piece.segment.id])),
      process.map(s => s.id),
      'real API journal ordering survives grouping without moving a call across text',
    )
    assert.deepEqual(turnPieces(replay.segments.filter(s => s.kind !== 'user')), pieces)
    assert.equal(
      currentActivity({ segments: state.segments, drafting: false, currentTurn: state.turn }),
      null,
      'a settled real journal, including a background acknowledgement without later exit evidence, must not stay pending',
    )
    assert.equal(currentActivity({ segments: replay.segments, drafting: false, currentTurn: replay.turn }), null)
    const positions = state.segments.map(s => s.id)
    for (const shellTool of shell) {
      const index = positions.indexOf(shellTool.id)
      assert.ok(
        state.segments.slice(index + 1).some(s => s.kind === 'assistant' && s.turn === shellTool.turn),
        'each real shell call precedes its follow-up assistant answer',
      )
    }
  } finally {
    child.kill('SIGTERM')
    for (let i = 0; i < 40 && child.exitCode == null; i += 1) await delay(50)
    if (child.exitCode == null) {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
