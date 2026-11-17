import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEngine } from '../src/engine.ts'
import { creatorFrom, handleMemoryRoute, type MemoryEntity } from '../src/memory-catalog.ts'
import { openStore } from '../src/store.ts'

const PREFIX = '/session-foundations/api/memory'

test('a missing source is unknown and is never the user', () => {
  assert.equal(creatorFrom(null), 'unknown')
  assert.equal(creatorFrom(undefined), 'unknown')
  assert.equal(creatorFrom(''), 'unknown')
  assert.equal(creatorFrom('garbage'), 'unknown')
  assert.equal(creatorFrom('user_confirm'), 'user')
  assert.equal(creatorFrom('user'), 'user')
  assert.equal(creatorFrom('explicit_tool'), 'tool')
  assert.equal(creatorFrom('candidate_extract'), 'model')
  assert.equal(creatorFrom('migration'), 'system')
})

test('reading memory does not create a session or a snapshot', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'sf-mem-')))
  const engine = createEngine(store)
  const beforeBindings = count(engine, 'SELECT COUNT(*) AS n FROM session_bindings')
  const beforeViews = count(engine, 'SELECT COUNT(*) AS n FROM view_revisions')
  const listed = ask(engine, `${PREFIX}/entities`, 'sessionId=orphan-session')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.entities, [])
  assert.equal(count(engine, 'SELECT COUNT(*) AS n FROM session_bindings'), beforeBindings)
  assert.equal(count(engine, 'SELECT COUNT(*) AS n FROM view_revisions'), beforeViews)
  const missing = ask(engine, `${PREFIX}/entities`, '')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'VALIDATION')
  store.close()
})

test('the catalog keeps types, sources, forgotten text, and snapshot citation honest', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'sf-mem-')))
  const engine = createEngine(store)
  const now = '2026-11-17T01:00:00.000Z'
  const later = '2026-11-17T02:00:00.000Z'
  const persona = engine.confirmPersona('Name: Scout\n\nKeep it short.')
  engine.bindPersona('session-a', persona.id)
  engine.ensureSession('session-b')
  const older = insertFact(engine, {
    sessionId: 'session-a',
    content: 'older-fact',
    status: 'superseded',
    sourceType: 'user_confirm',
    at: now,
  })
  const hidden = insertFact(engine, {
    sessionId: 'session-a',
    content: 'hidden-fact',
    status: 'forgotten',
    sourceType: 'explicit_tool',
    supersedes: older,
    at: later,
  })
  insertFact(engine, {
    sessionId: 'session-a',
    content: 'The user prefers short replies.',
    status: 'active',
    sourceType: 'explicit_tool',
    at: later,
  })
  insertFact(engine, {
    sessionId: 'session-a',
    kind: 'user_profile',
    content: '称呼: Ada\n偏好: 短句',
    status: 'active',
    sourceType: 'user_confirm',
    at: later,
  })
  insertFact(engine, {
    sessionId: 'session-a',
    content: 'maybe later',
    status: 'candidate',
    sourceType: 'candidate_extract',
    at: later,
  })
  insertFact(engine, {
    sessionId: 'session-b',
    content: 'other-session-fact',
    status: 'active',
    sourceType: 'explicit_tool',
    at: later,
  })
  engine.store.db
    .prepare(
      `
      INSERT INTO memories (
        session_id, title, content, status, source_type, revision, created_at, updated_at
      ) VALUES ('session-a', 'Tuesday', 'met on the platform', 'active', 'explicit_tool', 1, ?, ?)
    `,
    )
    .run(later, later)
  engine.store.db
    .prepare(`INSERT INTO working_state (session_id, revision, payload_json, updated_at) VALUES ('session-a', 2, ?, ?)`)
    .run(
      JSON.stringify({
        currentGoal: 'ship the panel',
        todos: [
          { text: 'wait for manifest', status: 'blocked' },
          { text: 'draw cards', status: 'open' },
        ],
        notes: 'draft note',
      }),
      later,
    )
  engine.registerSkill('session-a', 'public', 'notes', '1.0.0', 'short summary', Buffer.from('SKILL BODY SECRET'))
  engine.registerSkill('session-a', 'private', 'guide', '1.0.0', 'guide summary', Buffer.from('GUIDE BODY'))
  engine.setSkillFlags('session-a', 'notes', { revoked: true })
  engine.store.db
    .prepare(
      `
      INSERT INTO mutations (
        scope, idempotency_key, payload_hash, tool_name, request_json, result_json, outcome, created_at
      ) VALUES ('session-a', 'k-hidden', 'hash', 'foundations_remember', ?, ?, 'applied', ?)
    `,
    )
    .run(
      JSON.stringify({ target: 'fact', id: hidden, content: 'hidden-fact' }),
      JSON.stringify({ data: { id: hidden, target: 'fact' } }),
      later,
    )
  engine.freeze('session-a', 1)
  const bindings = count(engine, 'SELECT COUNT(*) AS n FROM session_bindings')
  const views = count(engine, 'SELECT COUNT(*) AS n FROM view_revisions')
  const facts = count(engine, 'SELECT COUNT(*) AS n FROM facts')

  const listed = ask(engine, `${PREFIX}/entities`, 'sessionId=session-a')
  assert.equal(listed.status, 200)
  const entities = listed.body.entities as MemoryEntity[]
  const types = entities.map(entity => entity.type)
  assert.ok(types.includes('persona'))
  assert.ok(types.includes('profile'))
  assert.ok(types.includes('fact'))
  assert.ok(types.includes('episodic'))
  assert.ok(types.includes('state'))
  assert.ok(types.includes('skill'))
  assert.equal(types.includes('procedural'), false)
  assert.equal(JSON.stringify(entities).includes('hidden-fact'), false)
  assert.equal(JSON.stringify(entities).includes('other-session-fact'), false)
  assert.equal(JSON.stringify(entities).includes('SKILL BODY SECRET'), false)
  assert.equal(JSON.stringify(entities).includes('short summary'), false)

  const personaCard = entities.find(entity => entity.type === 'persona')
  assert.equal(personaCard?.title, 'Scout')
  assert.equal(personaCard?.scope, 'user')
  assert.equal(personaCard?.creator, 'user')
  assert.match(personaCard?.summary ?? '', /Keep it short/)

  const profile = entities.find(entity => entity.type === 'profile')
  assert.equal(profile?.creator, 'user')
  assert.deepEqual(profile?.attributes, [
    { name: '称呼', value: 'Ada' },
    { name: '偏好', value: '短句' },
  ])
  const activeFact = entities.find(entity => entity.type === 'fact' && entity.lifecycle === 'active')
  assert.equal(activeFact?.creator, 'tool')
  assert.equal(activeFact?.scope, 'session')
  const candidate = entities.find(entity => entity.lifecycle === 'candidate')
  assert.equal(candidate?.creator, 'model')
  const state = entities.find(entity => entity.type === 'state')
  assert.equal(state?.goal, 'ship the panel')
  assert.deepEqual(state?.blockers, ['wait for manifest'])
  assert.equal(state?.next, 'draw cards')
  assert.equal(state?.creator, 'unknown')
  const episode = entities.find(entity => entity.type === 'episodic')
  assert.equal(episode?.title, 'Tuesday')
  assert.match(episode?.summary ?? '', /platform/)
  const guide = entities.find(entity => entity.id === 'skill:guide')
  assert.equal(guide?.scope, 'skill')
  assert.equal(guide?.bindingScope, 'private')
  assert.equal(guide?.creator, 'unknown')
  const revoked = entities.find(entity => entity.id === 'skill:notes')
  assert.equal(revoked?.tombstone, true)
  assert.equal(revoked?.summary, '')

  const searched = ask(engine, `${PREFIX}/entities`, 'sessionId=session-a&q=hidden-fact')
  assert.deepEqual(searched.body.entities, [])
  const foundOld = ask(engine, `${PREFIX}/entities`, 'sessionId=session-a&q=older-fact')
  assert.equal(
    (foundOld.body.entities as MemoryEntity[]).some(entity => entity.summary === 'older-fact'),
    true,
  )
  const procedural = ask(engine, `${PREFIX}/entities`, 'sessionId=session-a&type=procedural')
  assert.deepEqual(procedural.body.entities, [])
  const work = ask(engine, `${PREFIX}/entities`, 'sessionId=session-a&scope=work')
  assert.deepEqual(work.body.entities, [])
  const other = ask(engine, `${PREFIX}/entities`, 'sessionId=session-b')
  assert.equal(JSON.stringify(other.body.entities).includes('Scout'), false)
  assert.equal(JSON.stringify(other.body.entities).includes('other-session-fact'), true)

  const hiddenDetail = ask(engine, `${PREFIX}/entities/fact:${hidden}`, 'sessionId=session-a')
  assert.equal(hiddenDetail.status, 200)
  const hiddenEntity = hiddenDetail.body.entity as MemoryEntity
  assert.equal(hiddenEntity.body, null)
  assert.equal(hiddenEntity.bodyState, 'hidden')
  assert.equal(JSON.stringify(hiddenEntity).includes('hidden-fact'), false)
  assert.equal(
    hiddenEntity.chain?.some(item => item.summary === 'older-fact'),
    true,
  )
  assert.equal(
    hiddenEntity.changes?.some(change => change.tool === 'foundations_remember'),
    true,
  )
  assert.equal(JSON.stringify(hiddenEntity.changes).includes('hidden-fact'), false)

  const olderDetail = ask(engine, `${PREFIX}/entities/fact:${older}`, 'sessionId=session-a')
  const olderEntity = olderDetail.body.entity as MemoryEntity
  assert.equal(olderEntity.lifecycle, 'corrected')
  assert.equal(olderEntity.body, 'older-fact')
  assert.equal(olderEntity.source?.creator, 'user')
  assert.equal(olderEntity.source?.recorded, true)

  const stateDetail = ask(engine, `${PREFIX}/entities/state:current`, 'sessionId=session-a')
  const stateEntity = stateDetail.body.entity as MemoryEntity
  assert.equal(stateEntity.source?.recorded, false)
  assert.equal(stateEntity.source?.creator, 'unknown')
  assert.equal(stateEntity.body, 'draft note')

  const skillDetail = ask(engine, `${PREFIX}/entities/skill:notes`, 'sessionId=session-a')
  assert.equal(JSON.stringify(skillDetail.body).includes('SKILL BODY SECRET'), false)
  assert.equal(JSON.stringify(skillDetail.body).includes('short summary'), false)
  const guideDetail = ask(engine, `${PREFIX}/entities/skill:guide`, 'sessionId=session-a')
  assert.equal((guideDetail.body.entity as MemoryEntity).body, 'GUIDE BODY')

  const wrongType = ask(
    engine,
    `${PREFIX}/entities/fact:${entities.find(entity => entity.type === 'profile')?.id.split(':')[1]}`,
    'sessionId=session-a',
  )
  assert.equal(wrongType.status, 404)
  const leaked = ask(engine, `${PREFIX}/entities/fact:${hidden}`, 'sessionId=session-b')
  assert.equal(leaked.status, 404)

  const frames = ask(engine, `${PREFIX}/frames`, 'sessionId=session-a')
  const frameList = frames.body.frames as Array<{ revision: number; hasManifest: boolean }>
  assert.equal(frameList[0]?.hasManifest, false)
  const uncited = ask(
    engine,
    `${PREFIX}/context`,
    `sessionId=session-a&revision=${frameList[0]?.revision}&ids=fact:${hidden},episodic:1,fact:999,skill:guide`,
  )
  const citations = uncited.body.citations as Array<{ form: string; reason: string }>
  assert.equal(citations.length, 4)
  assert.ok(citations.every(item => item.form === 'unknown' && item.reason === 'no_manifest'))
  assert.equal(JSON.stringify(citations).includes('absent'), false)
  assert.equal(JSON.stringify(citations).includes('full'), false)
  const noFrame = ask(engine, `${PREFIX}/context`, 'sessionId=session-a&ids=fact:1')
  assert.equal((noFrame.body.citations as Array<{ reason: string }>)[0]?.reason, 'no_frame')
  assert.equal(noFrame.body.frame, null)
  const missingFrame = ask(engine, `${PREFIX}/context`, 'sessionId=session-a&revision=99999&ids=fact:1')
  assert.equal(missingFrame.status, 404)

  assert.equal(count(engine, 'SELECT COUNT(*) AS n FROM session_bindings'), bindings)
  assert.equal(count(engine, 'SELECT COUNT(*) AS n FROM view_revisions'), views)
  assert.equal(count(engine, 'SELECT COUNT(*) AS n FROM facts'), facts)
  store.close()
})

function ask(
  engine: ReturnType<typeof createEngine>,
  path: string,
  query: string,
): { status: number; body: Record<string, unknown> } {
  const url = new URL(`http://127.0.0.1${path}${query === '' ? '' : `?${query}`}`)
  const result = handleMemoryRoute(engine, url.pathname, url)
  assert.ok(result)
  return result
}

function count(engine: ReturnType<typeof createEngine>, sql: string): number {
  const row = engine.store.db.prepare(sql).get() as { n: number }
  return Number(row.n)
}

function insertFact(
  engine: ReturnType<typeof createEngine>,
  input: {
    sessionId: string
    content: string
    status: string
    sourceType: string
    at: string
    kind?: string
    supersedes?: number
  },
): number {
  const info = engine.store.db
    .prepare(
      `
      INSERT INTO facts (
        session_id, kind, content, status, source_type, supersedes, revision, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 100, ?, ?)
    `,
    )
    .run(
      input.sessionId,
      input.kind ?? 'user_fact',
      input.content,
      input.status,
      input.sourceType,
      input.supersedes ?? null,
      input.at,
      input.at,
    )
  return Number(info.lastInsertRowid)
}
