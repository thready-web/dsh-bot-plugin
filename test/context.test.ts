import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderPeers, renderSession, renderTickets } from '../src/context.ts'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'

test('frozen view does not change mid-turn and soul is not truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-ctx-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const persona = engine.confirmPersona('Keep it short.')
  engine.bindPersona('session-a', persona.id)
  engine.freeze('session-a', 1)
  const first = renderSession(engine, 'session-a', 128000)
  assert.match(first.texts['foundations:soul'], /Keep it short/)
  assert.match(first.texts['foundations:chat'], /The latest user message is the current intent/)
  assert.match(first.texts['foundations:chat'], /Do not foundations_dispatch a replacement ticket/)
  assert.match(first.texts['foundations:rules'], /When ok is false/)
  assert.doesNotMatch(first.texts['foundations:rules'], /accepted is not enqueued/)
  assert.doesNotMatch(first.texts['foundations:rules'], /foundations_grant/)
  store.db
    .prepare(`
    INSERT INTO facts (
      session_id, content, status, source_type, revision, priority, created_at, updated_at
    ) VALUES ('session-a', 'a new fact', 'active', 'explicit_tool', 1, 100, ?, ?)
  `)
    .run(new Date().toISOString(), new Date().toISOString())
  const second = renderSession(engine, 'session-a', 128000)
  assert.equal(second.viewRevision, first.viewRevision)
  assert.equal(
    second.texts['foundations:user'].includes('a new fact') || second.texts['foundations:facts'].includes('a new fact'),
    false,
  )
  engine.freeze('session-a', 2)
  const third = renderSession(engine, 'session-a', 128000)
  assert.notEqual(third.viewRevision, first.viewRevision)
  assert.ok(
    third.texts['foundations:user'].includes('a new fact') || third.texts['foundations:facts'].includes('a new fact'),
  )
  const huge = engine.confirmPersona('rule'.repeat(20000))
  engine.bindPersona('session-a', huge.id)
  engine.openViews.delete('session-a')
  engine.freeze('session-a', 3)
  const overflow = renderSession(engine, 'session-a', 128000)
  assert.equal(overflow.soulCode, 'BUDGET_OVERFLOW')
  assert.doesNotMatch(overflow.texts['foundations:soul'], /rulerulerule/)
  assert.equal(engine.binding('session-a').status, 'error')
  store.close()
})

test('a declared name is the assistant identity and user facts stay about the user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-name-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  const persona = engine.confirmPersona('Name: Scout\n\nKeep it short.')
  engine.bindPersona('session-a', persona.id)
  const now = new Date().toISOString()
  store.db
    .prepare(`
    INSERT INTO facts (
      session_id, content, status, source_type, revision, priority, created_at, updated_at
    ) VALUES ('session-a', 'The user is called Ada', 'active', 'explicit_tool', 1, 100, ?, ?)
  `)
    .run(now, now)
  engine.freeze('session-a', 1)
  const rendered = renderSession(engine, 'session-a', 128000)
  const soul = rendered.texts['foundations:soul']
  assert.match(soul, /Your name is "Scout"/)
  assert.match(soul, /not the user's name/)
  assert.match(soul, /Do not say you have no name/)
  assert.match(soul, /Keep it short/)
  assert.match(rendered.texts['foundations:user'], /not your name/)
  assert.match(rendered.texts['foundations:user'], /The user is called Ada/)
  assert.doesNotMatch(rendered.texts['foundations:user'], /Your name is/)
  store.close()
})

test('same hash stays present until a removal bumps the internal epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-epoch-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  engine.ensureSession('session-a')
  engine.freeze('session-a', 1)
  const first = renderSession(engine, 'session-a', 128000)
  engine.noteSurface('session-a', 8)
  const again = renderSession(engine, 'session-a', 128000)
  assert.equal(again.snapshotHash, first.snapshotHash)
  assert.equal(
    engine.view(engine.binding('session-a').last_view_revision ? 'session-a' : 'session-a', again.viewRevision)
      .presence,
    'present',
  )
  const removed = engine.noteRemoval('session-a', [8])
  assert.equal(removed, true)
  assert.equal(engine.binding('session-a').compaction_epoch, 1)
  assert.equal(engine.view('session-a', again.viewRevision).presence, 'needs_reinject')
  store.close()
})

test('a bound persona stays in the system prompt after compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-keep-'))
  const dataDir = join(dir, 'data')
  const store = openStore(dataDir)
  const engine = createEngine(store)
  const persona = engine.confirmPersona('Name: Ernie\n\nStyle: wry\n\nTask: stay helpful')
  engine.bindPersona('session-bot', persona.id)
  store.db.prepare(`UPDATE session_bindings SET kind = 'session' WHERE session_id = ?`).run('session-bot')
  engine.ensureSession('session-plain')
  assert.equal(engine.binding('session-plain').persona_version_id, null)
  store.close()

  const sections: any[] = []
  const listeners: any[] = []
  const plugin = await import('../src/index.ts')
  plugin.apply(
    {
      profileContext: { dir },
      systemPrompt: {
        section(entry: any) {
          sections.push(entry)
          return () => {}
        },
        context(entry: any) {
          sections.push(entry)
          return () => {}
        },
      },
      tools: {
        register() {
          return () => {}
        },
      },
      on(name: any, fn: any) {
        listeners.push([name, fn])
        return fn
      },
      effect(fn: any) {
        fn()
      },
      logger: { info() {} },
      webServer: null,
    },
    { dataDir },
  )

  const soul = sections.find(entry => entry.name === 'foundations:soul')
  const text = soul.text({ agent: { id: 'session-bot' } })
  assert.match(text, /Your name is "Ernie"/)
  assert.match(text, /Style: wry/)
  assert.match(text, /Task: stay helpful/)
  assert.equal(soul.text({ agent: { id: 'session-plain' } }), '')
  const onEvent = listeners.find(([name]) => name === 'session/event')[1]
  onEvent({ id: 'session-bot' }, { type: 'compaction/end', seq: 9 })
  const again = soul.text({ agent: { id: 'session-bot' } })
  assert.match(again, /Your name is "Ernie"/)
  assert.match(again, /stay helpful/)
})

test('the peer list names other bots and leaves the current bot out', () => {
  const text = renderPeers(
    [
      { sessionId: 'session-dog', name: 'Scout' },
      { sessionId: 'session-er', name: 'Ernie' },
      { sessionId: 'session-bare', name: '' },
    ],
    'session-dog',
  )
  assert.match(text, /Other bots/)
  assert.match(text, /- Ernie session-er/)
  assert.match(text, /- unnamed session-bare/)
  assert.doesNotMatch(text, /Scout session-dog/)
  assert.match(text, /Do not call foundations_send unless/)
  assert.equal(renderPeers([{ sessionId: 'session-dog', name: 'Scout' }], 'session-dog'), '')
})

test('ticket protocol stays on the ticket block and a private draft is labeled', () => {
  const tickets = renderTickets([
    { id: 't1', status: 'started', briefing_revision: 2, child_session_id: 'worker-t1', summary: 'write the doc' },
  ])
  assert.match(tickets, /accepted is not enqueued/)
  assert.match(tickets, /foundations_grant/)
  assert.match(tickets, /Do not say accepted, enqueued, or publish/)
  assert.equal(renderTickets([]), '')

  const dir = mkdtempSync(join(tmpdir(), 'sf-draft-'))
  const store = openStore(dir)
  const engine = createEngine(store)
  engine.ensureSession('session-a')
  const now = new Date().toISOString()
  store.db
    .prepare(`
    INSERT INTO working_state (session_id, revision, payload_json, updated_at)
    VALUES ('session-a', 1, ?, ?)
  `)
    .run(
      JSON.stringify({
        currentGoal: 'finish the sentence',
        todos: [{ text: 'answer first', status: 'open' }],
        notes: '',
      }),
      now,
    )
  engine.freeze('session-a', 1)
  const rendered = renderSession(engine, 'session-a', 128000)
  assert.match(rendered.texts['foundations:state'], /private draft/)
  assert.match(rendered.texts['foundations:state'], /finish the sentence/)
  store.close()
})

test('other bots are injected for a bot and omitted for an ordinary session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-peers-'))
  const dataDir = join(dir, 'data')
  const store = openStore(dataDir)
  const engine = createEngine(store)
  const dog = engine.confirmPersona('Name: Scout\n\nStyle: private-tone\n\nTask: fetch')
  const er = engine.confirmPersona('Name: Ernie\n\nStyle: wry\n\nTask: stay helpful')
  const bare = engine.confirmPersona('wry')
  engine.bindPersona('session-dog', dog.id)
  engine.bindPersona('session-er', er.id)
  engine.bindPersona('session-bare', bare.id)
  engine.ensureSession('session-plain')
  store.close()

  const sections: any[] = []
  const tools: any[] = []
  const plugin = await import('../src/index.ts')
  plugin.apply(
    {
      profileContext: { dir },
      systemPrompt: {
        section(entry: any) {
          sections.push(entry)
          return () => {}
        },
        context(entry: any) {
          sections.push(entry)
          return () => {}
        },
      },
      tools: {
        register(entry: any) {
          tools.push(entry)
          return () => {}
        },
      },
      agents: {},
      on() {
        return () => {}
      },
      effect(fn: any) {
        fn()
      },
      logger: { info() {} },
      webServer: null,
    },
    { dataDir },
  )

  const peers = sections.find(entry => entry.name === 'foundations:peers')
  assert.equal(peers.order, 42)
  const text = peers.text({ agent: { id: 'session-dog' } })
  assert.match(text, /- Ernie session-er/)
  assert.match(text, /- unnamed session-bare/)
  assert.doesNotMatch(text, /Scout session-dog/)
  assert.doesNotMatch(text, /private-tone/)
  assert.equal(peers.text({ agent: { id: 'session-plain' } }), '')
  const soul = sections.find(entry => entry.name === 'foundations:soul')
  const before = soul.text({ agent: { id: 'session-dog' } })
  assert.match(before, /private-tone/)
  assert.equal(before.includes('Other bots'), false)
  const send = tools.find(entry => entry.name === 'foundations_send')
  const refused = await send.execute({}, { agent: { id: 'session-plain' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'FORBIDDEN')
  const rendered = send.output.render({ targetSessionId: 'session-er' }, { ok: false, code: 'FORBIDDEN' })
  assert.equal(Array.isArray(rendered), true)
  assert.match(rendered[0].text, /FORBIDDEN/)
  assert.doesNotMatch(rendered[0].text, /session-er/)
})

test('plugin does not register a complete section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-plugin-'))
  const sections: any[] = []
  const contexts: any[] = []
  const tools: any[] = []
  const listeners: any[] = []
  const ctx = {
    profileContext: { dir },
    systemPrompt: {
      section(entry: any) {
        sections.push(entry)
        return () => {}
      },
      context(entry: any) {
        contexts.push(entry)
        return () => {}
      },
    },
    tools: {
      register(entry: any) {
        tools.push(entry)
        return () => {}
      },
    },
    on(name: any, fn: any) {
      listeners.push(name)
      return fn
    },
    effect(fn: any) {
      fn()
    },
    logger: { info() {} },
    webServer: null,
  }
  const plugin = await import('../src/index.ts')
  plugin.apply(ctx, { dataDir: join(dir, 'data') })
  assert.equal(
    sections.some(entry => entry.complete === true),
    false,
  )
  assert.equal(listeners.includes('system-prompt/assemble'), false)
  assert.ok(sections.some(entry => entry.name === 'foundations:soul'))
  assert.ok(contexts.some(entry => entry.name === 'foundations:revocation' && entry.required === true))
  assert.ok(tools.some(entry => entry.name === 'foundations_remember'))
})
