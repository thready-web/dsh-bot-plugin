import { createHash } from 'node:crypto'
import { toolError, asStoreFailure, type ToolPayload } from './errors.ts'
import { syncFactFts, syncMemoryFts, EMPTY_STATE } from './engine.ts'
import { queryMemory, readMemoryEntity, type MemoryEntity, type MemoryType } from './memory-catalog.ts'

const SHARED = ' A worker uses the main bot memory, not a private copy.'
const TYPES = ['persona', 'profile', 'fact', 'episodic', 'procedural', 'state', 'skill'] as const

const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  render(_args: unknown, value: unknown) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  },
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {() => number} [viewRevision]
 */
export function toolDefinitions(engine: import('./engine.ts').Engine, viewRevision: () => number = () => 0) {
  const revision = (hostId: string) => {
    const injected = viewRevision()
    return injected > 0 ? injected : currentRevision(engine, hostId)
  }
  return [
    tool(
      'foundations_recall',
      `Search facts and long-term memories that are still active in this session. Forgotten, superseded, and unconfirmed rows are omitted.${SHARED}`,
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'integer', description: 'Default 5, maximum 20' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['query'],
      },
      async (args, hostId) => {
        const requested = args.limit
        const limit = Math.min(
          20,
          Math.max(1, typeof requested === 'number' && Number.isInteger(requested) ? requested : 5),
        )
        if (typeof args.query !== 'string' || args.query.trim() === '')
          return toolError('VALIDATION', 'query is required.')
        const found = engine.recall(hostId, args.query.trim(), limit)
        return ok(revision(hostId), 0, found)
      },
    ),
    tool(
      'foundations_remember',
      `Store one fact or long-term memory as active. An idempotency key is required.${SHARED}`,
      {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['fact', 'memory'] },
          content: { type: 'string' },
          title: { type: 'string' },
          priority: { type: 'integer' },
          sourceEventId: { type: 'string' },
          idempotencyKey: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['target', 'content', 'idempotencyKey'],
      },
      async (args, hostId) =>
        write(
          engine,
          hostId,
          'foundations_remember',
          args,
          () => revision(hostId),
          () => {
            if (args.target !== 'fact' && args.target !== 'memory')
              return toolError('VALIDATION', 'target must be fact or memory.')
            if (typeof args.content !== 'string' || args.content.trim() === '')
              return toolError('VALIDATION', 'content is required.')
            const sourceError = engine.checkSource(hostId, args.sourceEventId)
            if (sourceError) return sourceError
            const created = nowIso()
            if (args.target === 'fact') {
              const priority = Number.isInteger(args.priority) ? args.priority : 100
              const info = engine.store.db
                .prepare(`
          INSERT INTO facts (
            session_id, kind, content, status, source_event_id, source_type, revision, priority, created_at, updated_at
          ) VALUES (?, 'user_fact', ?, 'active', ?, 'explicit_tool', 1, ?, ?, ?)
        `)
                .run(hostId, args.content, args.sourceEventId ?? null, priority, created, created)
              const id = Number(info.lastInsertRowid)
              syncFactFts(engine.store.db, id, args.content, true)
              return ok(revision(hostId), 1, { id, target: 'fact', revision: 1 })
            }
            const info = engine.store.db
              .prepare(`
        INSERT INTO memories (
          session_id, title, content, status, source_event_id, source_type, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, 'explicit_tool', 1, ?, ?)
      `)
              .run(
                hostId,
                typeof args.title === 'string' ? args.title : null,
                args.content,
                args.sourceEventId ?? null,
                created,
                created,
              )
            const id = Number(info.lastInsertRowid)
            syncMemoryFts(engine.store.db, id, typeof args.title === 'string' ? args.title : '', args.content, true)
            return ok(revision(hostId), 1, { id, target: 'memory', revision: 1 })
          },
        ),
    ),
    tool(
      'foundations_correct',
      `Replace one still-active fact or memory with a new row. expectedRevision is required.${SHARED}`,
      {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['fact', 'memory'] },
          id: { type: 'integer' },
          content: { type: 'string' },
          title: { type: 'string' },
          expectedRevision: { type: 'integer' },
          idempotencyKey: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['target', 'id', 'content', 'expectedRevision', 'idempotencyKey'],
      },
      async (args, hostId) =>
        write(
          engine,
          hostId,
          'foundations_correct',
          args,
          () => revision(hostId),
          () => correct(engine, hostId, args),
        ),
    ),
    tool(
      'foundations_forget',
      `Mark one fact or memory forgotten and drop it from search. The original log is not deleted.${SHARED}`,
      {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['fact', 'memory'] },
          id: { type: 'integer' },
          expectedRevision: { type: 'integer' },
          idempotencyKey: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['target', 'id', 'expectedRevision', 'idempotencyKey'],
      },
      async (args, hostId) =>
        write(
          engine,
          hostId,
          'foundations_forget',
          args,
          () => revision(hostId),
          () => forget(engine, hostId, args),
        ),
    ),
    tool(
      'foundations_state_update',
      `Patch the working draft for this session. expectedRevision is required.${SHARED}`,
      {
        type: 'object',
        properties: {
          expectedRevision: { type: 'integer' },
          patch: { type: 'object' },
          idempotencyKey: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['expectedRevision', 'patch', 'idempotencyKey'],
      },
      async (args, hostId) =>
        write(
          engine,
          hostId,
          'foundations_state_update',
          args,
          () => revision(hostId),
          () => updateState(engine, hostId, args),
        ),
    ),
    tool(
      'foundations_skill_load',
      `Read the text of an enabled, non-revoked skill in this session. This does not grant tools.${SHARED}`,
      {
        type: 'object',
        properties: {
          skillId: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['skillId'],
      },
      async (args, hostId) => {
        if (typeof args.skillId !== 'string') return toolError('VALIDATION', 'skillId is invalid.')
        const loaded = engine.loadSkill(hostId, args.skillId)
        if (loaded.ok === false) return loaded
        return {
          ok: true,
          outcome: 'applied',
          viewRevisionFrozen: revision(hostId),
          storeRevision: 0,
          data: loaded.data,
        }
      },
    ),
    tool(
      'foundations_memory_list',
      `List persona, profile, facts, episodes, working state, and skills in this session. Forgotten rows are tombstones without their text. This is not a search; use foundations_recall to find active facts and memories by words.${SHARED}`,
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...TYPES], description: 'Omit to list every type.' },
          limit: { type: 'integer', description: 'Default 20, maximum 50' },
          cursor: { type: 'string', description: 'Offset returned as nextCursor.' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
      },
      async (args, hostId) => {
        const type = args.type == null || args.type === '' ? null : args.type
        if (type != null && (typeof type !== 'string' || !TYPES.includes(type as MemoryType))) {
          return toolError('VALIDATION', 'type is invalid.')
        }
        const requested = args.limit
        const limit = Math.min(
          50,
          Math.max(1, typeof requested === 'number' && Number.isInteger(requested) ? requested : 20),
        )
        const cursor = args.cursor == null || args.cursor === '' ? 0 : Number(args.cursor)
        if (!Number.isInteger(cursor) || cursor < 0) return toolError('VALIDATION', 'cursor is invalid.')
        const page = queryMemory(engine, hostId, { type: type as MemoryType | null, limit, offset: cursor })
        return ok(revision(hostId), 0, page)
      },
    ),
    tool(
      'foundations_memory_read',
      `Read one memory entity by id, such as fact:1, episodic:2, persona:1, state:current, or skill:guide. Forgotten text stays hidden.${SHARED}`,
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string', description: 'Ignored. The host binds the session.' },
        },
        required: ['id'],
      },
      async (args, hostId) => {
        if (typeof args.id !== 'string' || args.id.trim() === '') return toolError('VALIDATION', 'id is required.')
        const entity = readMemoryEntity(engine, hostId, args.id.trim())
        if (!entity) return toolError('NOT_FOUND', 'No memory entity was found in this session.')
        return ok(revision(hostId), 0, { entity: publicEntity(entity) })
      },
    ),
  ]
}

/**
 * The bot's own session, or the main bot that owns this worker. Anyone else has no memory.
 * @param {(sessionId: string) => boolean} isBot
 * @param {string} sessionId
 * @param {(sessionId: string) => string | null} ownerOf
 */
export function memorySessionFor(
  isBot: (sessionId: string) => boolean,
  sessionId: string,
  ownerOf: (sessionId: string) => string | null,
): string | null {
  if (isBot(sessionId)) return sessionId
  const owner = ownerOf(sessionId)
  if (!owner || owner === sessionId || !isBot(owner)) return null
  return owner
}

/**
 * Run a memory tool against the resolved session. Workers are forwarded to the main bot.
 * @param {(args: Record<string, unknown>, exec: { agent?: { id?: string } } | null | undefined) => Promise<ToolPayload>} execute
 * @param {Record<string, unknown>} args
 * @param {{ agent?: { id?: string } } | null | undefined} exec
 * @param {(sessionId: string) => string | null} resolve
 */
export async function callMemoryTool(
  execute: (
    args: Record<string, unknown>,
    exec: { agent?: { id?: string } } | null | undefined,
  ) => Promise<ToolPayload>,
  args: Record<string, unknown>,
  exec: { agent?: { id?: string } } | null | undefined,
  resolve: (sessionId: string) => string | null,
): Promise<ToolPayload> {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId === '')
    return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
  const memoryId = resolve(sessionId)
  if (!memoryId)
    return toolError(
      'FORBIDDEN',
      'This session is not a bot and not a worker of one, so persona and memory do not apply here.',
    )
  const forwarded = memoryId === sessionId ? exec : { ...exec, agent: { ...(exec?.agent ?? {}), id: memoryId } }
  const result = await execute(args, forwarded)
  if (result?.ok === true && memoryId !== sessionId) return { ...result, memorySessionId: memoryId }
  return result
}

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} parameters
 * @param {(args: Record<string, unknown>, hostId: string) => Promise<ToolPayload>} run
 */
function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, hostId: string) => Promise<ToolPayload>,
) {
  return {
    name,
    description,
    parameters,
    output: OUTPUT,
    async execute(
      args: Record<string, unknown> | null | undefined,
      exec: { agent?: { id?: string }; signal?: AbortSignal } | null | undefined,
    ): Promise<ToolPayload> {
      const hostId = exec?.agent?.id
      if (typeof hostId !== 'string' || hostId === '')
        return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
      try {
        return publish(await run(args ?? {}, hostId))
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'BUSY') {
          return toolError('BUSY', 'The write lock was not acquired, so nothing was written.')
        }
        return asStoreFailure(error)
      }
    },
  }
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} hostId
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {() => number} viewRevision
 * @param {() => ToolPayload} apply
 */
async function write(
  engine: import('./engine.ts').Engine,
  hostId: string,
  name: string,
  args: Record<string, unknown>,
  viewRevision: () => number,
  apply: () => ToolPayload,
): Promise<ToolPayload> {
  const binding = engine.ensureSession(hostId)
  if (binding.status === 'error') return toolError('UNAVAILABLE', `Binding is ${binding.error_code ?? 'error'}.`)
  const idempotencyKey = args.idempotencyKey
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return toolError('VALIDATION', 'idempotencyKey is required.')
  }
  const payloadHash = createHash('sha256').update(stable(args)).digest('hex')
  const result = await engine.store.write(hostId, () =>
    engine.mutate(hostId, idempotencyKey, payloadHash, name, args, apply, viewRevision()),
  )
  if (result.ok === true && result.outcome === 'applied') {
    const exported = await engine.exportOne({ id: result.mutationId, session_id: hostId, attempts: 0 })
    const final = {
      ...result,
      export: exported.ok ? 'done' : 'failed',
      ...(exported.ok ? {} : { exportError: exported.error }),
    }
    engine.store.db
      .prepare('UPDATE mutations SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(final), result.mutationId)
    return final
  }
  return result
}

/**
 * @param {Record<string, unknown>} result
 */
function publish(result: ToolPayload): ToolPayload {
  if (result.ok === false) return result
  return {
    ok: true,
    outcome: result.outcome ?? 'applied',
    viewRevisionFrozen: result.viewRevisionFrozen ?? result.viewRevision ?? 0,
    storeRevision: result.storeRevision ?? 0,
    data: result.data,
    ...(result.export ? { export: result.export } : {}),
    ...(result.exportError ? { exportError: result.exportError } : {}),
  }
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} hostId
 * @param {Record<string, unknown>} args
 */
function correct(engine: import('./engine.ts').Engine, hostId: string, args: Record<string, unknown>) {
  if (
    (args.target !== 'fact' && args.target !== 'memory') ||
    typeof args.content !== 'string' ||
    !Number.isInteger(args.id) ||
    !Number.isInteger(args.expectedRevision)
  ) {
    return toolError('VALIDATION', 'correct arguments are incomplete.')
  }
  const table = args.target === 'fact' ? 'facts' : 'memories'
  const row = engine.store.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND session_id = ?`).get(args.id, hostId)
  if (!row || row.status !== 'active') return toolError('NOT_FOUND', 'No still-active row was found.')
  if (row.revision !== args.expectedRevision) {
    return toolError('CAS_CONFLICT', 'The revision has changed.', { actualRevision: row.revision })
  }
  const created = nowIso()
  let inserted
  if (args.target === 'fact') {
    inserted = engine.store.db
      .prepare(`
      INSERT INTO facts (
        session_id, kind, content, status, source_type, supersedes, revision, priority, created_at, updated_at
      ) VALUES (?, 'user_fact', ?, 'active', 'explicit_tool', ?, 1, ?, ?, ?)
    `)
      .run(hostId, args.content, row.id, row.priority, created, created)
    engine.store.db
      .prepare(`UPDATE facts SET status = 'superseded', revision = ?, updated_at = ? WHERE id = ?`)
      .run(row.revision + 1, created, row.id)
    syncFactFts(engine.store.db, row.id, row.content, false)
    syncFactFts(engine.store.db, Number(inserted.lastInsertRowid), args.content, true)
  } else {
    const title = typeof args.title === 'string' ? args.title : row.title
    inserted = engine.store.db
      .prepare(`
      INSERT INTO memories (
        session_id, title, content, status, source_type, supersedes, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', 'explicit_tool', ?, 1, ?, ?)
    `)
      .run(hostId, title, args.content, row.id, created, created)
    engine.store.db
      .prepare(`UPDATE memories SET status = 'superseded', revision = ?, updated_at = ? WHERE id = ?`)
      .run(row.revision + 1, created, row.id)
    syncMemoryFts(engine.store.db, row.id, row.title, row.content, false)
    syncMemoryFts(engine.store.db, Number(inserted.lastInsertRowid), title, args.content, true)
  }
  return ok(0, 1, { id: Number(inserted.lastInsertRowid), target: args.target, revision: 1, supersedes: row.id })
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} hostId
 * @param {Record<string, unknown>} args
 */
function forget(engine: import('./engine.ts').Engine, hostId: string, args: Record<string, unknown>) {
  if (
    (args.target !== 'fact' && args.target !== 'memory') ||
    !Number.isInteger(args.id) ||
    !Number.isInteger(args.expectedRevision)
  ) {
    return toolError('VALIDATION', 'forget arguments are incomplete.')
  }
  const table = args.target === 'fact' ? 'facts' : 'memories'
  const row = engine.store.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND session_id = ?`).get(args.id, hostId)
  if (!row || row.status !== 'active') return toolError('NOT_FOUND', 'No still-active row was found.')
  if (row.revision !== args.expectedRevision)
    return toolError('CAS_CONFLICT', 'The revision has changed.', { actualRevision: row.revision })
  const updated = nowIso()
  engine.store.db
    .prepare(`UPDATE ${table} SET status = 'forgotten', revision = ?, updated_at = ? WHERE id = ?`)
    .run(row.revision + 1, updated, row.id)
  if (args.target === 'fact') syncFactFts(engine.store.db, row.id, row.content, false)
  else syncMemoryFts(engine.store.db, row.id, row.title, row.content, false)
  return ok(0, row.revision + 1, { id: row.id, target: args.target, revision: row.revision + 1, forgotten: true })
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} hostId
 * @param {Record<string, unknown>} args
 */
function updateState(engine: import('./engine.ts').Engine, hostId: string, args: Record<string, unknown>) {
  if (
    !Number.isInteger(args.expectedRevision) ||
    args.patch == null ||
    typeof args.patch !== 'object' ||
    Array.isArray(args.patch)
  ) {
    return toolError('VALIDATION', 'state_update arguments are incomplete.')
  }
  const current = engine.statePayload(hostId)
  if (current.revision !== args.expectedRevision) {
    return toolError('CAS_CONFLICT', 'The working-draft revision has changed.', { actualRevision: current.revision })
  }
  const patch = args.patch
  const next = {
    currentGoal: current.payload.currentGoal ?? '',
    todos: current.payload.todos ?? [],
    pointers: current.payload.pointers ?? [],
    notes: current.payload.notes ?? '',
  }
  if ('currentGoal' in patch) {
    if (typeof patch.currentGoal !== 'string') return toolError('VALIDATION', 'currentGoal must be a string.')
    next.currentGoal = patch.currentGoal
  }
  if ('notes' in patch) {
    if (typeof patch.notes !== 'string') return toolError('VALIDATION', 'notes must be a string.')
    next.notes = patch.notes
  }
  if ('todos' in patch) {
    if (!Array.isArray(patch.todos)) return toolError('VALIDATION', 'todos must be an array.')
    next.todos = patch.todos
  }
  if ('pointers' in patch) {
    if (!Array.isArray(patch.pointers)) return toolError('VALIDATION', 'pointers must be an array.')
    next.pointers = patch.pointers
  }
  const revision = current.revision + 1
  const updated = nowIso()
  if (current.revision === 0) {
    engine.store.db
      .prepare(`
      INSERT INTO working_state (session_id, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)
    `)
      .run(hostId, revision, JSON.stringify(next), updated)
  } else {
    engine.store.db
      .prepare(`
      UPDATE working_state SET revision = ?, payload_json = ?, updated_at = ? WHERE session_id = ?
    `)
      .run(revision, JSON.stringify(next), updated, hostId)
  }
  return ok(0, revision, { revision, payload: next })
}

/**
 * @param {number} viewRevision
 * @param {number} storeRevision
 * @param {unknown} data
 */
function publicEntity(entity: MemoryEntity) {
  const visible = entity.bodyState === 'visible' && !entity.tombstone
  return {
    ...entity,
    title: entity.tombstone && entity.type !== 'skill' ? '' : entity.title,
    summary: entity.tombstone ? '' : entity.summary,
    body: visible ? (entity.body ?? null) : null,
  }
}

function ok(viewRevision: number, storeRevision: number, data: unknown) {
  return { ok: true, viewRevision, storeRevision, data }
}

/**
 * @param {unknown} value
 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} sessionId
 */
function currentRevision(engine: import('./engine.ts').Engine, sessionId: string) {
  return engine.currentView(sessionId)?.revision ?? engine.binding(sessionId)?.last_view_revision ?? 0
}

export { EMPTY_STATE }
