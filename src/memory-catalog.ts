import { splitPersona } from './context.ts'
import { toolError } from './errors.ts'
import { assertSessionId, type Engine } from './engine.ts'
import { sha256 } from './fs-safe.ts'

/**
 * Read-only memory catalog for the workbench.
 * Listing and detail never call ensureSession, freeze, or the write tools.
 * Old snapshots have no context manifest, so citation is unknown — an empty
 * memoryIds list is not evidence that a row was absent.
 */

export type MemoryType = 'persona' | 'profile' | 'fact' | 'episodic' | 'procedural' | 'state' | 'skill'
export type MemoryScope = 'user' | 'session' | 'work' | 'skill'
export type MemoryLifecycle = 'active' | 'corrected' | 'forgotten' | 'candidate'
export type MemoryCreator = 'user' | 'model' | 'system' | 'tool' | 'unknown'
export type BodyState = 'visible' | 'hidden' | 'mismatch' | 'absent'

export interface MemoryAttribute {
  name: string
  value: string
}

export interface MemorySource {
  creator: MemoryCreator
  recorded: boolean
  createdAt: string | null
  updatedAt: string | null
  eventId: string | null
}

export interface MemoryChainItem {
  id: string
  lifecycle: MemoryLifecycle
  at: string | null
  summary: string
  tombstone: boolean
}

export interface MemoryChange {
  id: number
  tool: string
  outcome: string
  at: string
}

export interface MemoryEntity {
  id: string
  type: MemoryType
  scope: MemoryScope
  lifecycle: MemoryLifecycle
  title: string
  summary: string
  revision: number | null
  createdAt: string | null
  updatedAt: string | null
  creator: MemoryCreator
  tombstone: boolean
  priority?: number
  attributes?: MemoryAttribute[]
  steps?: string[]
  goal?: string
  blockers?: string[]
  next?: string
  versionLabel?: string
  enabled?: boolean
  bindingScope?: 'public' | 'private'
  body?: string | null
  bodyState?: BodyState
  note?: string | null
  source?: MemorySource
  chain?: MemoryChainItem[]
  changes?: MemoryChange[]
}

export interface MemoryRouteResult {
  status: number
  body: Record<string, unknown>
}

const TYPES = new Set<MemoryType>(['persona', 'profile', 'fact', 'episodic', 'procedural', 'state', 'skill'])
const LIFECYCLES = new Set<MemoryLifecycle>(['active', 'corrected', 'forgotten', 'candidate'])
const SCOPES = new Set<MemoryScope>(['user', 'session', 'work', 'skill'])
const TYPE_ORDER: MemoryType[] = ['persona', 'profile', 'fact', 'episodic', 'procedural', 'state', 'skill']
const READ_CAP = 500
const ENTITY_ID = /^(persona|profile|fact|episodic|procedural|state|skill):([A-Za-z0-9][A-Za-z0-9._-]{0,64})$/
const PREFIX = '/session-foundations/api/memory'

const FACT_LIST = `
  SELECT id, kind,
    CASE WHEN status = 'forgotten' THEN '' ELSE content END AS content,
    status, source_event_id, source_type, supersedes, revision, priority, created_at, updated_at
  FROM facts WHERE session_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
`
const MEMORY_LIST = `
  SELECT id,
    CASE WHEN status = 'forgotten' THEN '' ELSE ifnull(title, '') END AS title,
    CASE WHEN status = 'forgotten' THEN '' ELSE content END AS content,
    status, source_event_id, source_type, supersedes, revision, created_at, updated_at
  FROM memories WHERE session_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
`

interface FactRow {
  id: number
  kind: string
  content: string
  status: string
  source_event_id: string | null
  source_type: string | null
  supersedes: number | null
  revision: number
  priority: number
  created_at: string
  updated_at: string
}

interface MemoryRow {
  id: number
  title: string
  content: string
  status: string
  source_event_id: string | null
  source_type: string | null
  supersedes: number | null
  revision: number
  created_at: string
  updated_at: string
}

/** A missing or unrecognized source is unknown. It is never treated as the user. */
export function creatorFrom(sourceType: unknown): MemoryCreator {
  if (sourceType === 'user_confirm' || sourceType === 'user') return 'user'
  if (sourceType === 'explicit_tool' || sourceType === 'import') return 'tool'
  if (sourceType === 'candidate_extract') return 'model'
  if (sourceType === 'migration' || sourceType === 'system') return 'system'
  return 'unknown'
}

export function handleMemoryRoute(engine: Engine, path: string, url: URL): MemoryRouteResult | null {
  if (
    path !== `${PREFIX}/entities` &&
    path !== `${PREFIX}/frames` &&
    path !== `${PREFIX}/context` &&
    !path.startsWith(`${PREFIX}/entities/`)
  ) {
    return null
  }
  try {
    if (path === `${PREFIX}/entities`) return listRoute(engine, url)
    if (path === `${PREFIX}/frames`) return framesRoute(engine, url)
    if (path === `${PREFIX}/context`) return contextRoute(engine, url)
    return detailRoute(engine, path.slice(`${PREFIX}/entities/`.length), url)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'VALIDATION') {
      return { status: 400, body: toolError('VALIDATION', error instanceof Error ? error.message : 'invalid') }
    }
    if (code === 'NOT_FOUND') {
      return { status: 404, body: toolError('NOT_FOUND', error instanceof Error ? error.message : 'not found') }
    }
    throw error
  }
}

function listRoute(engine: Engine, url: URL): MemoryRouteResult {
  const sessionId = requireSession(url)
  const type = enumParam(url, 'type', TYPES)
  const lifecycle = enumParam(url, 'lifecycle', LIFECYCLES)
  const scope = enumParam(url, 'scope', SCOPES)
  const q = textParam(url, 'q', 200)
  const limit = intParam(url, 'limit', 60, 100)
  const offset = intParam(url, 'cursor', 0, 100000)
  const { entities, capped } = collect(engine, sessionId)
  const filtered = entities.filter(entity => {
    if (type && entity.type !== type) return false
    if (lifecycle && entity.lifecycle !== lifecycle) return false
    if (scope && entity.scope !== scope) return false
    return matchesQuery(entity, q)
  })
  filtered.sort(compareEntities)
  const page = filtered.slice(offset, offset + limit)
  const next = offset + limit < filtered.length ? String(offset + limit) : null
  return {
    status: 200,
    body: { ok: true, sessionId, entities: page, nextCursor: next, capped },
  }
}

function detailRoute(engine: Engine, rawId: string, url: URL): MemoryRouteResult {
  const sessionId = requireSession(url)
  const parsed = parseEntityId(rawId)
  if (!parsed) fail('VALIDATION', 'entity id is invalid.')
  const entity = readEntity(engine, sessionId, parsed.type, parsed.key)
  if (!entity) fail('NOT_FOUND', 'No memory entity was found in this session.')
  return { status: 200, body: { ok: true, entity } }
}

function framesRoute(engine: Engine, url: URL): MemoryRouteResult {
  const sessionId = requireSession(url)
  const limit = intParam(url, 'limit', 20, 50)
  const rows = engine.store.db
    .prepare(
      `SELECT revision, frozen_at, presence FROM view_revisions WHERE session_id = ? ORDER BY revision DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{ revision: number; frozen_at: string; presence: string }>
  return {
    status: 200,
    body: {
      ok: true,
      frames: rows.map(row => ({
        revision: Number(row.revision),
        frozenAt: text(row.frozen_at),
        presence: text(row.presence),
        hasManifest: false,
      })),
    },
  }
}

function contextRoute(engine: Engine, url: URL): MemoryRouteResult {
  const sessionId = requireSession(url)
  const revision = optionalRevision(url)
  const ids = idList(url)
  if (revision == null) {
    return {
      status: 200,
      body: {
        ok: true,
        frame: null,
        citations: ids.map(id => ({ id, form: 'unknown', reason: 'no_frame' })),
      },
    }
  }
  const row = engine.store.db
    .prepare(`SELECT revision, frozen_at, presence FROM view_revisions WHERE session_id = ? AND revision = ?`)
    .get(sessionId, revision) as { revision: number; frozen_at: string; presence: string } | undefined
  if (!row) fail('NOT_FOUND', 'That context frame was not found in this session.')
  return {
    status: 200,
    body: {
      ok: true,
      frame: {
        revision: Number(row.revision),
        frozenAt: text(row.frozen_at),
        presence: text(row.presence),
        hasManifest: false,
      },
      citations: ids.map(id => ({ id, form: 'unknown', reason: 'no_manifest' })),
    },
  }
}

function collect(engine: Engine, sessionId: string): { entities: MemoryEntity[]; capped: boolean } {
  const entities: MemoryEntity[] = []
  let capped = false
  const facts = engine.store.db.prepare(FACT_LIST).all(sessionId, READ_CAP + 1) as FactRow[]
  if (facts.length > READ_CAP) capped = true
  for (const row of facts.slice(0, READ_CAP)) {
    const entity = factEntity(row, false)
    if (entity) entities.push(entity)
  }
  const memories = engine.store.db.prepare(MEMORY_LIST).all(sessionId, READ_CAP + 1) as MemoryRow[]
  if (memories.length > READ_CAP) capped = true
  for (const row of memories.slice(0, READ_CAP)) {
    const entity = memoryEntity(row, false)
    if (entity) entities.push(entity)
  }
  const persona = personaEntity(engine, sessionId, false)
  if (persona) entities.push(persona)
  const state = stateEntity(engine, sessionId, false)
  if (state) entities.push(state)
  const skills = engine.store.db
    .prepare(
      `
      SELECT skill_id, scope, version, content_hash, CASE WHEN revoked = 1 THEN '' ELSE summary END AS summary,
        enabled, revoked, bound_at
      FROM skill_bindings WHERE session_id = ? ORDER BY skill_id LIMIT ?
    `,
    )
    .all(sessionId, READ_CAP + 1) as SkillRow[]
  if (skills.length > READ_CAP) capped = true
  for (const row of skills.slice(0, READ_CAP)) entities.push(skillEntity(row, null))
  return { entities, capped }
}

function readEntity(engine: Engine, sessionId: string, type: MemoryType, key: string): MemoryEntity | null {
  if (type === 'procedural') return null
  if (type === 'persona') return personaDetail(engine, sessionId, key)
  if (type === 'state') return key === 'current' ? stateDetail(engine, sessionId) : null
  if (type === 'skill') return skillDetail(engine, sessionId, key)
  if (type === 'profile' || type === 'fact') return factDetail(engine, sessionId, type, key)
  if (type === 'episodic') return memoryDetail(engine, sessionId, key)
  return null
}

function factDetail(engine: Engine, sessionId: string, type: 'profile' | 'fact', key: string): MemoryEntity | null {
  const id = numberKey(key)
  if (id == null) return null
  const row = factRow(engine, sessionId, id)
  if (!row) return null
  const entity = factEntity(row, true)
  if (!entity || entity.type !== type) return null
  const chain = walkFacts(engine, sessionId, id).map(item => chainItem(factEntity(item, false), item.updated_at))
  return {
    ...entity,
    chain: chain.filter((item): item is MemoryChainItem => item != null),
    changes: changesFor(engine, sessionId, 'fact', key),
  }
}

function memoryDetail(engine: Engine, sessionId: string, key: string): MemoryEntity | null {
  const id = numberKey(key)
  if (id == null) return null
  const row = memoryRow(engine, sessionId, id)
  if (!row) return null
  const entity = memoryEntity(row, true)
  if (!entity) return null
  const chain = walkMemories(engine, sessionId, id).map(item => chainItem(memoryEntity(item, false), item.updated_at))
  return {
    ...entity,
    chain: chain.filter((item): item is MemoryChainItem => item != null),
    changes: changesFor(engine, sessionId, 'memory', key),
  }
}

function personaDetail(engine: Engine, sessionId: string, key: string): MemoryEntity | null {
  const entity = personaEntity(engine, sessionId, true)
  if (!entity || entity.id !== `persona:${key}`) return null
  return { ...entity, chain: [], changes: [] }
}

function stateDetail(engine: Engine, sessionId: string): MemoryEntity | null {
  const entity = stateEntity(engine, sessionId, true)
  if (!entity) return null
  return { ...entity, chain: [], changes: changesFor(engine, sessionId, 'state', 'current') }
}

function skillDetail(engine: Engine, sessionId: string, key: string): MemoryEntity | null {
  const row = engine.store.db
    .prepare(
      `
      SELECT skill_id, scope, version, content_hash, CASE WHEN revoked = 1 THEN '' ELSE summary END AS summary,
        enabled, revoked, bound_at
      FROM skill_bindings WHERE session_id = ? AND skill_id = ?
    `,
    )
    .get(sessionId, key) as SkillRow | undefined
  if (!row) return null
  const revoked = Number(row.revoked) === 1
  let body: string | null = null
  let bodyState: BodyState = 'absent'
  if (revoked) bodyState = 'hidden'
  else {
    const bytes = engine.store.readBlob('skill', text(row.content_hash))
    if (bytes == null || sha256(bytes) !== text(row.content_hash)) bodyState = 'mismatch'
    else {
      body = bytes.toString('utf8')
      bodyState = body.trim() === '' ? 'absent' : 'visible'
    }
  }
  return { ...skillEntity(row, bodyState === 'visible' ? body : null), body, bodyState, chain: [], changes: [] }
}

interface SkillRow {
  skill_id: string
  scope: string
  version: string
  content_hash: string
  summary: string
  enabled: number
  revoked: number
  bound_at: string
}

function factEntity(row: FactRow, withBody: boolean): MemoryEntity | null {
  const lifecycle = lifecycleOf(text(row.status))
  if (!lifecycle) return null
  const type: 'profile' | 'fact' =
    text(row.kind) === 'user_profile' || text(row.kind) === 'profile' ? 'profile' : 'fact'
  const tombstone = lifecycle === 'forgotten'
  const content = tombstone ? '' : text(row.content)
  const creator = creatorFrom(row.source_type)
  const entity: MemoryEntity = {
    id: `${type}:${Number(row.id)}`,
    type,
    scope: 'session',
    lifecycle,
    title: '',
    summary: tombstone ? '' : clip(content),
    revision: Number(row.revision),
    createdAt: text(row.created_at) || null,
    updatedAt: text(row.updated_at) || null,
    creator,
    tombstone,
    priority: Number(row.priority),
  }
  if (type === 'profile' && !tombstone) {
    const attributes = attributesFrom(content)
    if (attributes.length > 0) entity.attributes = attributes
  }
  if (!withBody) return entity
  const bodyState: BodyState = tombstone ? 'hidden' : content.trim() === '' ? 'absent' : 'visible'
  return {
    ...entity,
    body: bodyState === 'visible' ? content : null,
    bodyState,
    source: sourceOf(row.source_type, entity.createdAt, entity.updatedAt, row.source_event_id),
  }
}

function memoryEntity(row: MemoryRow, withBody: boolean): MemoryEntity | null {
  const lifecycle = lifecycleOf(text(row.status))
  if (!lifecycle) return null
  const tombstone = lifecycle === 'forgotten'
  const content = tombstone ? '' : text(row.content)
  const entity: MemoryEntity = {
    id: `episodic:${Number(row.id)}`,
    type: 'episodic',
    scope: 'session',
    lifecycle,
    title: tombstone ? '' : text(row.title).trim(),
    summary: tombstone ? '' : clip(content),
    revision: Number(row.revision),
    createdAt: text(row.created_at) || null,
    updatedAt: text(row.updated_at) || null,
    creator: creatorFrom(row.source_type),
    tombstone,
  }
  if (!withBody) return entity
  const bodyState: BodyState = tombstone ? 'hidden' : content.trim() === '' ? 'absent' : 'visible'
  return {
    ...entity,
    body: bodyState === 'visible' ? content : null,
    bodyState,
    source: sourceOf(row.source_type, entity.createdAt, entity.updatedAt, row.source_event_id),
  }
}

function personaEntity(engine: Engine, sessionId: string, withBody: boolean): MemoryEntity | null {
  const binding = engine.binding(sessionId)
  const personaId = binding?.persona_version_id
  if (personaId == null) return null
  const persona = engine.persona(Number(personaId))
  if (!persona) return null
  const recorded = typeof persona.created_by === 'string' && persona.created_by !== ''
  let body = ''
  let bodyState: BodyState = 'absent'
  if (engine.personaBlobOk(persona)) {
    const bytes = engine.store.readBlob('persona', persona.content_hash)
    body = bytes ? bytes.toString('utf8') : ''
    bodyState = body.trim() === '' ? 'absent' : 'visible'
  } else bodyState = 'mismatch'
  const split = bodyState === 'visible' ? splitPersona(body) : { name: '', body: '' }
  const entity: MemoryEntity = {
    id: `persona:${Number(persona.id)}`,
    type: 'persona',
    scope: 'user',
    lifecycle: 'active',
    title: split.name || clip(split.body, 80),
    summary: clip(split.body || body),
    revision: Number(persona.id),
    createdAt: text(persona.created_at) || null,
    updatedAt: text(persona.created_at) || null,
    creator: creatorFrom(recorded ? persona.created_by : null),
    tombstone: false,
    versionLabel: String(persona.id),
  }
  if (bodyState === 'mismatch') entity.summary = ''
  if (!withBody) return entity
  const note = typeof persona.note === 'string' && persona.note.trim() !== '' ? persona.note : null
  return {
    ...entity,
    body: bodyState === 'visible' ? body : null,
    bodyState,
    note,
    source: {
      creator: entity.creator,
      recorded,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      eventId: null,
    },
  }
}

function stateEntity(engine: Engine, sessionId: string, withBody: boolean): MemoryEntity | null {
  const row = engine.store.db
    .prepare('SELECT revision, payload_json, updated_at FROM working_state WHERE session_id = ?')
    .get(sessionId) as { revision: number; payload_json: string; updated_at: string } | undefined
  if (!row) return null
  let payload: { currentGoal?: unknown; todos?: unknown; notes?: unknown } | null = null
  try {
    const parsed = JSON.parse(text(row.payload_json)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      payload = parsed as { currentGoal?: unknown; todos?: unknown; notes?: unknown }
  } catch {
    payload = null
  }
  const goal = payload && typeof payload.currentGoal === 'string' ? payload.currentGoal.trim() : ''
  const notes = payload && typeof payload.notes === 'string' ? payload.notes.trim() : ''
  const todos = Array.isArray(payload?.todos) ? payload.todos : []
  const blockers = todos
    .map(todo => todoText(todo))
    .filter(
      (todo): todo is { text: string; status: string } =>
        todo != null && (todo.status === 'blocked' || todo.status === 'block'),
    )
    .map(todo => todo.text)
  const nextTodo = todos
    .map(todo => todoText(todo))
    .find(
      (todo): todo is { text: string; status: string } =>
        todo != null && todo.status !== 'done' && todo.status !== 'blocked' && todo.status !== 'block',
    )
  const next = nextTodo?.text ?? ''
  const entity: MemoryEntity = {
    id: 'state:current',
    type: 'state',
    scope: 'session',
    lifecycle: 'active',
    title: '',
    summary: clip([goal, ...blockers, next].filter(part => part !== '').join(' · ')),
    revision: Number(row.revision),
    createdAt: null,
    updatedAt: text(row.updated_at) || null,
    creator: 'unknown',
    tombstone: false,
    goal,
    blockers,
    next,
  }
  if (!withBody) return entity
  const bodyState: BodyState = payload == null ? 'mismatch' : notes === '' ? 'absent' : 'visible'
  return {
    ...entity,
    body: bodyState === 'visible' ? notes : null,
    bodyState,
    source: { creator: 'unknown', recorded: false, createdAt: null, updatedAt: entity.updatedAt, eventId: null },
  }
}

function skillEntity(row: SkillRow, body: string | null): MemoryEntity {
  const revoked = Number(row.revoked) === 1
  const enabled = Number(row.enabled) === 1 && !revoked
  const summary = revoked ? '' : clip(text(row.summary))
  return {
    id: `skill:${text(row.skill_id)}`,
    type: 'skill',
    scope: 'skill',
    lifecycle: revoked ? 'forgotten' : 'active',
    title: text(row.skill_id),
    summary,
    revision: null,
    createdAt: text(row.bound_at) || null,
    updatedAt: text(row.bound_at) || null,
    creator: 'unknown',
    tombstone: revoked,
    versionLabel: text(row.version),
    enabled,
    bindingScope: text(row.scope) === 'private' ? 'private' : 'public',
    ...(body != null ? { body, bodyState: 'visible' as const } : {}),
  }
}

function chainItem(entity: MemoryEntity | null, at: string | null): MemoryChainItem | null {
  if (!entity) return null
  return {
    id: entity.id,
    lifecycle: entity.lifecycle,
    at: at || entity.updatedAt,
    summary: entity.tombstone ? '' : entity.summary,
    tombstone: entity.tombstone,
  }
}

function changesFor(engine: Engine, sessionId: string, kind: 'fact' | 'memory' | 'state', key: string): MemoryChange[] {
  const rows = engine.store.db
    .prepare(
      `
      SELECT id, tool_name, request_json, result_json, outcome, created_at
      FROM mutations WHERE scope = ? ORDER BY id DESC LIMIT 80
    `,
    )
    .all(sessionId) as Array<{
    id: number
    tool_name: string
    request_json: string
    result_json: string
    outcome: string
    created_at: string
  }>
  const changes: MemoryChange[] = []
  for (const row of rows) {
    if (!mutationTouches(row, kind, key)) continue
    changes.push({
      id: Number(row.id),
      tool: text(row.tool_name),
      outcome: text(row.outcome),
      at: text(row.created_at),
    })
    if (changes.length >= 20) break
  }
  return changes
}

function mutationTouches(
  row: { tool_name: string; request_json: string; result_json: string },
  kind: 'fact' | 'memory' | 'state',
  key: string,
): boolean {
  if (kind === 'state') return row.tool_name === 'foundations_state_update'
  const target = kind === 'fact' ? 'fact' : 'memory'
  const id = Number(key)
  if (!Number.isInteger(id)) return false
  return payloadHits(row.request_json, target, id) || payloadHits(row.result_json, target, id)
}

function payloadHits(json: string, target: string, id: number): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return false
  }
  const found = new Set<number>()
  let sawTarget = false
  walkPayload(parsed, (entryKey, value) => {
    if (entryKey === 'target' && value === target) sawTarget = true
    if ((entryKey === 'id' || entryKey === 'supersedes') && value === id) found.add(id)
  })
  return sawTarget && found.has(id)
}

function walkPayload(value: unknown, visit: (key: string, child: unknown) => void) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkPayload(item, visit)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key, child)
    if (child && typeof child === 'object') walkPayload(child, visit)
  }
}

function factRow(engine: Engine, sessionId: string, id: number): FactRow | null {
  return (
    (engine.store.db
      .prepare(
        `
        SELECT id, kind,
          CASE WHEN status = 'forgotten' THEN '' ELSE content END AS content,
          status, source_event_id, source_type, supersedes, revision, priority, created_at, updated_at
        FROM facts WHERE session_id = ? AND id = ?
      `,
      )
      .get(sessionId, id) as FactRow | undefined) ?? null
  )
}

function memoryRow(engine: Engine, sessionId: string, id: number): MemoryRow | null {
  return (
    (engine.store.db
      .prepare(
        `
        SELECT id,
          CASE WHEN status = 'forgotten' THEN '' ELSE ifnull(title, '') END AS title,
          CASE WHEN status = 'forgotten' THEN '' ELSE content END AS content,
          status, source_event_id, source_type, supersedes, revision, created_at, updated_at
        FROM memories WHERE session_id = ? AND id = ?
      `,
      )
      .get(sessionId, id) as MemoryRow | undefined) ?? null
  )
}

function walkFacts(engine: Engine, sessionId: string, start: number): FactRow[] {
  return walk(
    id => factRow(engine, sessionId, id),
    id => linkedIds(engine, 'facts', sessionId, id),
    start,
  )
}

function walkMemories(engine: Engine, sessionId: string, start: number): MemoryRow[] {
  return walk(
    id => memoryRow(engine, sessionId, id),
    id => linkedIds(engine, 'memories', sessionId, id),
    start,
  )
}

function walk<T extends { id: number; supersedes: number | null }>(
  load: (id: number) => T | null,
  children: (id: number) => number[],
  start: number,
): T[] {
  const seen = new Set<number>()
  const rows: T[] = []
  const add = (row: T | null) => {
    if (!row || seen.has(Number(row.id))) return false
    seen.add(Number(row.id))
    rows.push(row)
    return true
  }
  let current = load(start)
  for (let i = 0; i < 8 && current; i++) {
    const next = current.supersedes == null ? null : Number(current.supersedes)
    if (!add(current)) break
    current = next == null ? null : load(next)
  }
  let frontier = [start]
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const id of frontier) {
      for (const child of children(id)) {
        const row = load(child)
        if (row && add(row)) next.push(Number(row.id))
      }
    }
    frontier = next
  }
  rows.sort((a, b) => Number(a.id) - Number(b.id))
  return rows
}

function linkedIds(engine: Engine, table: 'facts' | 'memories', sessionId: string, id: number): number[] {
  const rows = engine.store.db
    .prepare(`SELECT id FROM ${table} WHERE session_id = ? AND supersedes = ?`)
    .all(sessionId, id) as Array<{
    id: number
  }>
  return rows.map(row => Number(row.id))
}

function sourceOf(
  sourceType: string | null | undefined,
  createdAt: string | null,
  updatedAt: string | null,
  eventId: unknown,
): MemorySource {
  const recorded = typeof sourceType === 'string' && sourceType !== ''
  const event = eventId == null || eventId === '' ? null : String(eventId)
  return { creator: creatorFrom(recorded ? sourceType : null), recorded, createdAt, updatedAt, eventId: event }
}

function lifecycleOf(status: string): MemoryLifecycle | null {
  if (status === 'active') return 'active'
  if (status === 'superseded') return 'corrected'
  if (status === 'forgotten') return 'forgotten'
  if (status === 'candidate') return 'candidate'
  return null
}

function attributesFrom(content: string): MemoryAttribute[] {
  const attributes: MemoryAttribute[] = []
  for (const line of content.split('\n')) {
    const match = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(line.trim())
    if (!match) continue
    attributes.push({ name: match[1]?.trim() ?? '', value: match[2]?.trim() ?? '' })
    if (attributes.length >= 12) break
  }
  return attributes.filter(item => item.name !== '' && item.value !== '')
}

function todoText(value: unknown): { text: string; status: string } | null {
  if (!value || typeof value !== 'object') return null
  const textValue = 'text' in value && typeof value.text === 'string' ? value.text.trim() : ''
  if (textValue === '') return null
  const status = 'status' in value && typeof value.status === 'string' ? value.status : ''
  return { text: textValue, status }
}

function matchesQuery(entity: MemoryEntity, q: string): boolean {
  if (q === '') return true
  const needle = q.toLowerCase()
  if (entity.tombstone) return entity.id.toLowerCase().includes(needle)
  const attributes = (entity.attributes ?? []).map(item => `${item.name} ${item.value}`).join('\n')
  const steps = (entity.steps ?? []).join('\n')
  const haystack = [entity.id, entity.title, entity.summary, attributes, steps, entity.goal ?? '', entity.next ?? '']
    .join('\n')
    .toLowerCase()
  return haystack.includes(needle)
}

function compareEntities(a: MemoryEntity, b: MemoryEntity): number {
  const typeDelta = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  if (typeDelta !== 0) return typeDelta
  const time = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  if (time !== 0) return time
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function queryMemory(
  engine: Engine,
  sessionId: string,
  options: { type?: MemoryType | null; limit: number; offset: number },
) {
  assertSessionId(sessionId)
  const { entities, capped } = collect(engine, sessionId)
  const filtered = entities.filter(entity => !options.type || entity.type === options.type)
  filtered.sort(compareEntities)
  const page = filtered.slice(options.offset, options.offset + options.limit)
  const next = options.offset + options.limit < filtered.length ? String(options.offset + options.limit) : null
  return { entities: page.map(briefMemory), nextCursor: next, capped }
}

export function readMemoryEntity(engine: Engine, sessionId: string, id: string): MemoryEntity | null {
  assertSessionId(sessionId)
  const parsed = parseEntityId(id)
  if (!parsed) return null
  return readEntity(engine, sessionId, parsed.type, parsed.key)
}

function briefMemory(entity: MemoryEntity) {
  return {
    id: entity.id,
    type: entity.type,
    scope: entity.scope,
    lifecycle: entity.lifecycle,
    title: entity.title,
    summary: entity.summary,
    revision: entity.revision,
    updatedAt: entity.updatedAt,
    tombstone: entity.tombstone,
    ...(entity.priority != null ? { priority: entity.priority } : {}),
  }
}

function parseEntityId(raw: string): { type: MemoryType; key: string } | null {
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const match = ENTITY_ID.exec(decoded)
  if (!match) return null
  const type = match[1] as MemoryType
  const key = match[2] ?? ''
  if (!TYPES.has(type) || key === '') return null
  return { type, key }
}

function idList(url: URL): string[] {
  const raw = url.searchParams.get('ids') ?? ''
  if (raw.trim() === '') return []
  const ids = raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
  if (ids.length > 100) fail('VALIDATION', 'ids accepts at most 100 entries.')
  const unique: string[] = []
  for (const id of ids) {
    const parsed = parseEntityId(id)
    if (!parsed) fail('VALIDATION', 'entity id is invalid.')
    const canonical = `${parsed.type}:${parsed.key}`
    if (!unique.includes(canonical)) unique.push(canonical)
  }
  return unique
}

function requireSession(url: URL): string {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') fail('VALIDATION', 'sessionId is required.')
  assertSessionId(sessionId)
  return sessionId
}

function enumParam<T extends string>(url: URL, name: string, allowed: Set<T>): T | null {
  const value = url.searchParams.get(name)
  if (value == null || value === '') return null
  if (!allowed.has(value as T)) fail('VALIDATION', `${name} is invalid.`)
  return value as T
}

function textParam(url: URL, name: string, max: number): string {
  const value = (url.searchParams.get(name) ?? '').trim()
  if (value.length > max) fail('VALIDATION', `${name} is too long.`)
  return value
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) fail('VALIDATION', `${name} is invalid.`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) fail('VALIDATION', `${name} is invalid.`)
  return Math.min(max, value)
}

function optionalRevision(url: URL): number | null {
  const raw = url.searchParams.get('revision')
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(raw)) fail('VALIDATION', 'revision is invalid.')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) fail('VALIDATION', 'revision is invalid.')
  return value
}

function numberKey(key: string): number | null {
  if (!/^\d+$/.test(key)) return null
  const value = Number(key)
  return Number.isInteger(value) ? value : null
}

function clip(value: string, max = 240): string {
  const flat = value
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : ''
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}
