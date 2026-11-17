import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256, readContained, ensureDir } from './fs-safe.ts'
import { now, type SqlDatabase } from './store.ts'
import { splitPersona } from './context.ts'
import { toolError, type ToolPayload } from './errors.ts'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,64}$/
const EMPTY_STATE = { currentGoal: '', todos: [], pointers: [], notes: '' }

/**
 * @param {import('./store.js').Store} store
 */
export function createEngine(store: import('./store.ts').Store) {
  return new Engine(store)
}

export class Engine {
  store: import('./store.ts').Store
  openViews: Map<string, { revision: number; turn: number | null }>
  surface: Map<string, { seq: number | null; textIncludes: boolean }>

  /**
   * @param {import('./store.js').Store} store
   */
  constructor(store: import('./store.ts').Store) {
    this.store = store
    /** @type {Map<string, { revision: number, turn: number | null }>} */
    this.openViews = new Map()
    /** @type {Map<string, { seq: number | null, textIncludes: boolean }>} */
    this.surface = new Map()
  }

  /**
   * @param {string} sessionId
   * @param {{ parentSessionId?: string | null, seeded?: boolean }} [fork]
   */
  ensureSession(sessionId: string, fork: { parentSessionId?: string | null; seeded?: boolean } = {}) {
    assertSessionId(sessionId)
    const existing = this.binding(sessionId)
    if (existing) return existing
    const created = now()
    this.store.db
      .prepare(`
      INSERT INTO session_bindings (
        session_id, kind, status, schema_version, persona_version_id, fork_parent_session_id,
        fork_seeded, last_view_revision, compaction_epoch, error_code, created_at, updated_at
      ) VALUES (?, 'session', 'active', 1, NULL, ?, ?, 0, 0, NULL, ?, ?)
    `)
      .run(sessionId, fork.parentSessionId ?? null, fork.seeded ? 1 : 0, created, created)
    return this.binding(sessionId)
  }

  /**
   * @param {string} sessionId
   */
  binding(sessionId: string) {
    return this.store.db.prepare('SELECT * FROM session_bindings WHERE session_id = ?').get(sessionId) ?? null
  }

  /**
   * Ordinary sessions stay kind `session`. A bound persona is an assistant identity,
   * so binding one marks the session as a BOT. Startup also promotes older rows
   * that already had a persona and were left as `session` by the kind default.
   * @param {string} sessionId
   */
  isBot(sessionId: string) {
    return this.binding(sessionId)?.kind === 'bot'
  }

  /**
   * @param {string} sessionId
   */
  markBot(sessionId: string) {
    assertSessionId(sessionId)
    const existing = this.binding(sessionId)
    const stamped = now()
    if (existing) {
      if (existing.kind !== 'bot') {
        this.store.db
          .prepare(`UPDATE session_bindings SET kind = 'bot', updated_at = ? WHERE session_id = ?`)
          .run(stamped, sessionId)
      }
      return this.binding(sessionId)
    }
    this.store.db
      .prepare(`
      INSERT INTO session_bindings (
        session_id, kind, status, schema_version, persona_version_id, fork_parent_session_id,
        fork_seeded, last_view_revision, compaction_epoch, error_code, created_at, updated_at
      ) VALUES (?, 'bot', 'active', 1, NULL, NULL, 0, 0, 0, NULL, ?, ?)
    `)
      .run(sessionId, stamped, stamped)
    return this.binding(sessionId)
  }

  listBots() {
    return this.store.db
      .prepare(`
      SELECT session_id, persona_version_id FROM session_bindings WHERE kind = 'bot' ORDER BY created_at
    `)
      .all()
      .map(row => {
        const persona = row.persona_version_id == null ? null : this.persona(row.persona_version_id)
        const bytes = persona ? this.store.readBlob('persona', persona.content_hash) : null
        const name = bytes ? splitPersona(bytes.toString('utf8')).name : ''
        return { sessionId: row.session_id, name }
      })
  }

  latestPersona() {
    return this.store.db.prepare('SELECT * FROM persona_versions ORDER BY id DESC LIMIT 1').get() ?? null
  }

  /**
   * @param {number} id
   */
  persona(id: number) {
    return this.store.db.prepare('SELECT * FROM persona_versions WHERE id = ?').get(id) ?? null
  }

  /**
   * @param {{ id: number, content_hash: string }} persona
   */
  personaBlobOk(persona: { id: number; content_hash: string }) {
    const bytes = this.store.readBlob('persona', persona.content_hash)
    return bytes != null && sha256(bytes) === persona.content_hash
  }

  /**
   * User-confirmed SOUL. The model cannot call this.
   * @param {string} text
   * @param {string} [note]
   */
  confirmPersona(text: string, note?: string) {
    const bytes = Buffer.from(text, 'utf8')
    const hash = sha256(bytes)
    this.store.writeBlob('persona', hash, bytes)
    const existing = this.store.db.prepare('SELECT * FROM persona_versions WHERE content_hash = ?').get(hash)
    if (existing) return existing
    const created = now()
    this.store.db
      .prepare(`
      INSERT INTO persona_versions (content_hash, byte_length, note, created_by, created_at)
      VALUES (?, ?, ?, 'user', ?)
    `)
      .run(hash, bytes.length, note ?? null, created)
    return this.store.db.prepare('SELECT * FROM persona_versions WHERE content_hash = ?').get(hash)
  }

  /**
   * @param {string} sessionId
   * @param {number | null} personaId
   */
  bindPersona(sessionId: string, personaId: number | null) {
    if (personaId != null) this.markBot(sessionId)
    else this.ensureSession(sessionId)
    if (personaId == null) {
      this.store.db
        .prepare(`
        UPDATE session_bindings
        SET persona_version_id = NULL, status = 'active', error_code = NULL, updated_at = ?
        WHERE session_id = ?
      `)
        .run(now(), sessionId)
      return this.binding(sessionId)
    }
    const persona = this.persona(personaId)
    if (!persona) throw Object.assign(new Error('persona not found'), { code: 'NOT_FOUND' })
    if (!this.personaBlobOk(persona)) {
      this.markError(sessionId, 'HASH_MISMATCH')
      throw Object.assign(new Error('persona blob does not match its hash'), { code: 'HASH_MISMATCH' })
    }
    this.store.db
      .prepare(`
      UPDATE session_bindings
      SET persona_version_id = ?, status = 'active', error_code = NULL, updated_at = ?
      WHERE session_id = ?
    `)
      .run(personaId, now(), sessionId)
    return this.binding(sessionId)
  }

  /**
   * @param {string} sessionId
   * @param {string} code
   */
  markError(sessionId: string, code: string) {
    this.store.db
      .prepare(`
      UPDATE session_bindings SET status = 'error', error_code = ?, updated_at = ? WHERE session_id = ?
    `)
      .run(code, now(), sessionId)
  }

  /**
   * @param {string} sessionId
   * @param {string | null} watermark
   */
  noteWatermark(sessionId: string, watermark: string | null) {
    if (!this.binding(sessionId) || watermark == null) return
    const current = this.binding(sessionId).last_event_watermark
    if (current != null && BigInt(current) >= BigInt(watermark)) return
    this.store.db
      .prepare(`
      UPDATE session_bindings SET last_event_watermark = ?, updated_at = ? WHERE session_id = ?
    `)
      .run(watermark, now(), sessionId)
  }

  /**
   * @param {string} sessionId
   * @param {string | undefined} sourceEventId
   */
  checkSource(sessionId: string, sourceEventId: unknown) {
    if (sourceEventId == null || sourceEventId === '') return null
    const sourceText = typeof sourceEventId === 'string' ? sourceEventId : String(sourceEventId)
    if (!/^\d+$/.test(sourceText))
      return toolError('VALIDATION', 'sourceEventId must be an event sequence number in this session.')
    const watermark = this.binding(sessionId)?.last_event_watermark
    if (watermark == null || BigInt(sourceText) > BigInt(watermark)) {
      return toolError('VALIDATION', 'sourceEventId is outside the events this session has observed.')
    }
    return null
  }

  /**
   * @param {string} sessionId
   * @param {number} turn
   */
  /**
   * Active facts, persona, state, and skills as freeze would select them.
   * Does not insert a view revision.
   * @param {string} sessionId
   */
  liveSelection(sessionId: string) {
    const binding = this.ensureSession(sessionId)
    const state = this.stateRow(sessionId)
    const facts = this.store.db
      .prepare(`
      SELECT id FROM facts WHERE session_id = ? AND status = 'active'
      ORDER BY priority DESC, updated_at DESC, id DESC
    `)
      .all(sessionId)
      .map(row => row.id)
    const skills = this.store.db
      .prepare(`
      SELECT skill_id, version, summary, enabled, revoked, scope
      FROM skill_bindings WHERE session_id = ? ORDER BY skill_id
    `)
      .all(sessionId)
    return {
      binding,
      selected: {
        factIds: facts,
        memoryIds: [] as number[],
        personaVersionId: binding.persona_version_id,
        workingStateRev: state?.revision ?? 0,
        skills,
      },
    }
  }

  freeze(sessionId: string, turn: number) {
    const { binding, selected } = this.liveSelection(sessionId)
    const revision = binding.last_view_revision + 1
    const frozenAt = now()
    this.store.db
      .prepare(`
      INSERT INTO view_revisions (
        session_id, revision, frozen_at, event_watermark, persona_version_id, working_state_rev,
        snapshot_hash, compaction_epoch, presence, selected_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)
    `)
      .run(
        sessionId,
        revision,
        frozenAt,
        binding.last_event_watermark,
        binding.persona_version_id,
        selected.workingStateRev,
        'pending',
        binding.compaction_epoch,
        JSON.stringify(selected),
      )
    this.store.db
      .prepare(`
      UPDATE session_bindings SET last_view_revision = ?, updated_at = ? WHERE session_id = ?
    `)
      .run(revision, frozenAt, sessionId)
    this.openViews.set(sessionId, { revision, turn })
    return this.view(sessionId, revision)
  }

  /**
   * @param {string} sessionId
   * @param {number} [turn]
   */
  viewForTurn(sessionId: string, turn?: number) {
    const open = this.openViews.get(sessionId)
    if (open && (turn == null || open.turn === turn)) return this.view(sessionId, open.revision)
    return this.freeze(sessionId, turn ?? -1)
  }

  /**
   * @param {string} sessionId
   * @param {number} revision
   */
  view(sessionId: string, revision: number) {
    const row = this.store.db
      .prepare(`
      SELECT * FROM view_revisions WHERE session_id = ? AND revision = ?
    `)
      .get(sessionId, revision)
    if (!row) return null
    return { ...row, selected: JSON.parse(row.selected_json) }
  }

  /**
   * @param {string} sessionId
   */
  currentView(sessionId: string) {
    const open = this.openViews.get(sessionId)
    if (open) return this.view(sessionId, open.revision)
    const binding = this.binding(sessionId)
    if (!binding || binding.last_view_revision === 0) return null
    return this.view(sessionId, binding.last_view_revision)
  }

  /**
   * @param {string} sessionId
   * @param {number} revision
   * @param {string} hash
   * @param {'present' | 'unknown' | 'needs_reinject'} presence
   */
  recordSnapshot(
    sessionId: string,
    revision: number,
    hash: string,
    presence: 'present' | 'unknown' | 'needs_reinject',
  ) {
    this.store.db
      .prepare(`
      UPDATE view_revisions SET snapshot_hash = ?, presence = ? WHERE session_id = ? AND revision = ?
    `)
      .run(hash, presence, sessionId, revision)
  }

  /**
   * Adapter-internal counter. Not a DSH field.
   * @param {string} sessionId
   * @param {'needs_reinject' | 'unknown'} presence
   */
  bumpEpoch(sessionId: string, presence: 'needs_reinject' | 'unknown') {
    const binding = this.binding(sessionId)
    if (!binding) return
    const epoch = binding.compaction_epoch + 1
    this.store.db
      .prepare(`
      UPDATE session_bindings SET compaction_epoch = ?, updated_at = ? WHERE session_id = ?
    `)
      .run(epoch, now(), sessionId)
    this.store.db
      .prepare(`
      UPDATE view_revisions
      SET compaction_epoch = ?, presence = ?
      WHERE session_id = ? AND revision = ?
    `)
      .run(epoch, presence, sessionId, binding.last_view_revision)
  }

  /**
   * @param {string} sessionId
   * @param {number | null} seq
   */
  noteSurface(sessionId: string, seq: number | null) {
    this.surface.set(sessionId, { seq, textIncludes: true })
    const binding = this.binding(sessionId)
    if (!binding) return
    this.store.db
      .prepare(`
      UPDATE view_revisions SET presence = 'present'
      WHERE session_id = ? AND revision = ? AND snapshot_hash != 'pending'
    `)
      .run(sessionId, binding.last_view_revision)
  }

  /**
   * @param {string} sessionId
   * @param {number[]} sourceSeqs
   */
  noteRemoval(sessionId: string, sourceSeqs: number[]) {
    const retained = this.surface.get(sessionId)
    if (retained?.seq != null && sourceSeqs.includes(retained.seq)) {
      this.surface.set(sessionId, { seq: null, textIncludes: false })
      this.bumpEpoch(sessionId, 'needs_reinject')
      return true
    }
    return false
  }

  /**
   * @param {string} sessionId
   */
  stateRow(sessionId: string) {
    return this.store.db.prepare('SELECT * FROM working_state WHERE session_id = ?').get(sessionId) ?? null
  }

  /**
   * @param {string} sessionId
   */
  statePayload(sessionId: string) {
    const row = this.stateRow(sessionId)
    if (!row) return { revision: 0, payload: { ...EMPTY_STATE, todos: [], pointers: [] } }
    return { revision: row.revision, payload: JSON.parse(row.payload_json) }
  }

  /**
   * @param {string} sessionId
   */
  revokedSkills(sessionId: string) {
    return this.store.db
      .prepare(`
      SELECT skill_id, version FROM skill_bindings
      WHERE session_id = ? AND revoked = 1 ORDER BY skill_id
    `)
      .all(sessionId)
  }

  /**
   * @param {number[]} ids
   */
  factsByIds(ids: number[]) {
    if (ids.length === 0) return []
    const rows = this.store.db.prepare(`SELECT * FROM facts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    const byId = new Map(rows.map(row => [row.id, row]))
    return ids.map(id => byId.get(id)).filter(Boolean)
  }

  /**
   * @param {string} sessionId
   * @param {string} idempotencyKey
   * @param {string} payloadHash
   * @param {string} toolName
   * @param {unknown} request
   * @param {() => Record<string, unknown>} apply
   * @param {number} viewRevision
   */
  mutate(
    sessionId: string,
    idempotencyKey: string,
    payloadHash: string,
    toolName: string,
    request: unknown,
    apply: () => ToolPayload,
    viewRevision: number,
  ): ToolPayload {
    const prior = this.store.db
      .prepare(`
      SELECT * FROM mutations WHERE scope = ? AND idempotency_key = ?
    `)
      .get(sessionId, idempotencyKey)
    if (prior) {
      if (prior.payload_hash !== payloadHash)
        return toolError('IDEMPOTENCY_KEY_REUSE', 'The same idempotency key was reused for different content.')
      const stored = JSON.parse(prior.result_json)
      return { ...stored, outcome: 'replayed', viewRevisionFrozen: viewRevision }
    }
    const data = apply()
    if (data.ok === false) return data
    const result = {
      ok: true,
      outcome: 'applied',
      viewRevisionFrozen: viewRevision,
      storeRevision: data.storeRevision,
      data: data.data,
      export: 'pending',
    }
    const info = this.store.db
      .prepare(`
      INSERT INTO mutations (
        scope, idempotency_key, payload_hash, tool_name, request_json, result_json, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?)
    `)
      .run(sessionId, idempotencyKey, payloadHash, toolName, JSON.stringify(request), JSON.stringify(result), now())
    this.store.db
      .prepare(`
      INSERT INTO export_outbox (session_id, mutation_id, status, attempts, updated_at)
      VALUES (?, ?, 'pending', 0, ?)
    `)
      .run(sessionId, Number(info.lastInsertRowid), now())
    return { ...result, mutationId: Number(info.lastInsertRowid) }
  }

  /**
   * @param {string} sessionId
   */
  async flushExport(sessionId: string) {
    const rows = this.store.db
      .prepare(`
      SELECT * FROM export_outbox WHERE session_id = ? AND status IN ('pending','failed') ORDER BY id
    `)
      .all(sessionId)
    for (const row of rows) await this.exportOne(row)
  }

  /**
   * @param {{ id: number, session_id: string, attempts: number }} row
   */
  async exportOne(row: { id: number; session_id: string; attempts: number }) {
    try {
      const text = this.exportMarkdown(row.session_id)
      const dir = join(this.store.root, 'export', row.session_id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'memory.md'), text, { mode: 0o600 })
      this.store.db
        .prepare(`
        UPDATE export_outbox SET status = 'done', attempts = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `)
        .run(row.attempts + 1, now(), row.id)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.db
        .prepare(`
        UPDATE export_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?
      `)
        .run(row.attempts + 1, message, now(), row.id)
      return { ok: false, error: message }
    }
  }

  /**
   * @param {string} sessionId
   */
  exportMarkdown(sessionId: string) {
    const facts = this.store.db
      .prepare(`
      SELECT id, revision, content, status FROM facts WHERE session_id = ? ORDER BY id
    `)
      .all(sessionId)
    const memories = this.store.db
      .prepare(`
      SELECT id, revision, title, content, status FROM memories WHERE session_id = ? ORDER BY id
    `)
      .all(sessionId)
    const state = this.statePayload(sessionId)
    const lines = [`# session ${sessionId}`, '', '## facts']
    for (const fact of facts) {
      lines.push(
        fact.status === 'forgotten'
          ? `- forgotten:${fact.id}`
          : `- ${fact.id} rev ${fact.revision} (${fact.status}): ${fact.content}`,
      )
    }
    lines.push('', '## memories')
    for (const memory of memories) {
      lines.push(
        memory.status === 'forgotten'
          ? `- forgotten:${memory.id}`
          : `- ${memory.id} rev ${memory.revision} (${memory.status}) ${memory.title ?? ''}: ${memory.content}`,
      )
    }
    lines.push('', '## working state', '```json', JSON.stringify(state.payload), '```', '')
    return lines.join('\n')
  }

  /**
   * @param {string} sessionId
   * @param {string} query
   * @param {number} limit
   */
  recall(sessionId: string, query: string, limit: number) {
    const ftsFacts = searchFts(this.store.db, 'facts_fts', 'content', sessionId, 'facts', query, limit)
    const ftsMemories = searchFts(this.store.db, 'memories_fts', 'title, content', sessionId, 'memories', query, limit)
    let strategy = 'fts'
    let facts = ftsFacts
    let memories = ftsMemories
    if (facts.length === 0 && memories.length === 0 && query.length <= 32) {
      strategy = 'substring'
      const like = `%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`
      facts = this.store.db
        .prepare(`
        SELECT id, content, revision, priority FROM facts
        WHERE session_id = ? AND status = 'active' AND content LIKE ? ESCAPE '\\'
        ORDER BY priority DESC, updated_at DESC LIMIT ?
      `)
        .all(sessionId, like, limit)
      memories = this.store.db
        .prepare(`
        SELECT id, title, content, revision FROM memories
        WHERE session_id = ? AND status = 'active' AND (content LIKE ? ESCAPE '\\' OR ifnull(title,'') LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC LIMIT ?
      `)
        .all(sessionId, like, like, limit)
    }
    return { strategy, facts, memories }
  }

  /**
   * @param {string} sessionId
   * @param {'private' | 'public'} scope
   * @param {string} skillId
   * @param {string} version
   * @param {string} summary
   * @param {Buffer} bytes
   */
  registerSkill(
    sessionId: string,
    scope: 'private' | 'public',
    skillId: string,
    version: string,
    summary: string,
    bytes: Buffer,
  ) {
    assertSessionId(sessionId)
    if (!SKILL_ID.test(skillId)) throw Object.assign(new Error('invalid skill id'), { code: 'VALIDATION' })
    this.ensureSession(sessionId)
    const existing = this.skillRow(sessionId, skillId)
    if (existing && existing.scope === 'private' && scope === 'public') {
      throw Object.assign(new Error('private skill keeps this id'), { code: 'FORBIDDEN' })
    }
    const hash = sha256(bytes)
    this.store.writeBlob('skill', hash, bytes)
    const reread = this.store.readBlob('skill', hash)
    if (reread == null || sha256(reread) !== hash) {
      throw Object.assign(new Error('skill blob mismatch'), { code: 'HASH_MISMATCH' })
    }
    const boundAt = now()
    this.store.db
      .prepare(`
      INSERT INTO skill_bindings (
        session_id, skill_id, scope, version, content_hash, summary, enabled, revoked, bound_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT(session_id, skill_id) DO UPDATE SET
        scope = excluded.scope,
        version = excluded.version,
        content_hash = excluded.content_hash,
        summary = excluded.summary,
        enabled = 1,
        revoked = 0,
        bound_at = excluded.bound_at
    `)
      .run(sessionId, skillId, scope, version, hash, summary, boundAt)
    return this.skillRow(sessionId, skillId)
  }

  /**
   * @param {string} sessionId
   * @param {string} skillId
   */
  skillRow(sessionId: string, skillId: string) {
    return (
      this.store.db
        .prepare(`
      SELECT * FROM skill_bindings WHERE session_id = ? AND skill_id = ?
    `)
        .get(sessionId, skillId) ?? null
    )
  }

  /**
   * @param {string} sessionId
   * @param {string} skillId
   * @param {{ enabled?: boolean, revoked?: boolean }} patch
   */
  setSkillFlags(sessionId: string, skillId: string, patch: { enabled?: boolean; revoked?: boolean }) {
    const row = this.skillRow(sessionId, skillId)
    if (!row) throw Object.assign(new Error('skill not bound'), { code: 'NOT_FOUND' })
    const enabled = patch.enabled == null ? row.enabled : patch.enabled ? 1 : 0
    const revoked = patch.revoked == null ? row.revoked : patch.revoked ? 1 : 0
    this.store.db
      .prepare(`
      UPDATE skill_bindings SET enabled = ?, revoked = ?, bound_at = ? WHERE session_id = ? AND skill_id = ?
    `)
      .run(enabled, revoked, now(), sessionId, skillId)
    return this.skillRow(sessionId, skillId)
  }

  /**
   * @param {string} sessionId
   * @param {string} skillId
   */
  loadSkill(sessionId: string, skillId: string) {
    const binding = this.binding(sessionId)
    if (!binding) return toolError('NOT_FOUND', 'This session has no binding yet.')
    if (binding.status === 'error') return toolError('UNAVAILABLE', `Binding is ${binding.error_code ?? 'error'}.`)
    const row = this.skillRow(sessionId, skillId)
    if (!row) return toolError('NOT_FOUND', 'This session has no binding for that skill.')
    if (row.revoked === 1) return toolError('REVOKED', 'That skill is revoked.')
    if (row.enabled !== 1) return toolError('FORBIDDEN', 'That skill is not enabled.')
    const bytes = this.store.readBlob('skill', row.content_hash)
    if (bytes == null || sha256(bytes) !== row.content_hash) {
      return toolError('HASH_MISMATCH', 'The skill text hash does not match the binding.')
    }
    return {
      ok: true,
      outcome: 'applied',
      data: {
        skillId: row.skill_id,
        version: row.version,
        scope: row.scope,
        contentHash: row.content_hash,
        body: bytes.toString('utf8'),
        grantsTools: false,
      },
    }
  }

  /**
   * Read a user-managed source file and register its bytes.
   * @param {string} sessionId
   * @param {'private' | 'public'} scope
   * @param {string} skillId
   */
  registerSkillFromDisk(sessionId: string, scope: 'private' | 'public', skillId: string) {
    assertSessionId(sessionId)
    if (!SKILL_ID.test(skillId)) throw Object.assign(new Error('invalid skill id'), { code: 'VALIDATION' })
    const root =
      scope === 'public'
        ? join(this.store.root, 'src', 'skills', 'public')
        : join(this.store.root, 'src', 'skills', 'private', sessionId)
    ensureDir(root)
    const file = join(root, skillId, 'SKILL.md')
    if (!existsSync(file)) throw Object.assign(new Error('SKILL.md not found'), { code: 'NOT_FOUND' })
    const bytes = readContained(root, file)
    const text = bytes.toString('utf8')
    const version = /^\s*version:\s*(\S+)/m.exec(text)?.[1] ?? '0.0.0'
    const summary = /^\s*description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    return this.registerSkill(sessionId, scope, skillId, version, summary.slice(0, 240), bytes)
  }

  recover() {
    const report: { bindings: number; errors: any[]; promoted: any[]; ftsRebuilt: boolean; exports: any[] } = {
      bindings: 0,
      errors: [],
      promoted: [],
      ftsRebuilt: false,
      exports: [],
    }
    const personas = this.store.db.prepare('SELECT * FROM persona_versions').all()
    for (const persona of personas) {
      if (!this.personaBlobOk(persona)) report.errors.push({ persona: persona.id, code: 'HASH_MISMATCH' })
    }
    const bindings = this.store.db.prepare('SELECT * FROM session_bindings').all()
    for (const binding of bindings) {
      report.bindings += 1
      if (binding.persona_version_id != null) {
        const persona = this.persona(binding.persona_version_id)
        if (!persona || !this.personaBlobOk(persona)) this.markError(binding.session_id, 'HASH_MISMATCH')
        else if (binding.kind !== 'bot') {
          this.markBot(binding.session_id)
          report.promoted.push(binding.session_id)
        }
      }
      const skills = this.store.db
        .prepare(`
        SELECT * FROM skill_bindings WHERE session_id = ? AND enabled = 1 AND revoked = 0
      `)
        .all(binding.session_id)
      for (const skill of skills) {
        const bytes = this.store.readBlob('skill', skill.content_hash)
        if (bytes == null || sha256(bytes) !== skill.content_hash) {
          this.markError(binding.session_id, 'HASH_MISMATCH')
          report.errors.push({ sessionId: binding.session_id, skillId: skill.skill_id, code: 'HASH_MISMATCH' })
        }
      }
      if (binding.last_view_revision > 0) {
        this.store.db
          .prepare(`
          UPDATE view_revisions SET presence = 'unknown'
          WHERE session_id = ? AND revision = ? AND presence = 'present'
        `)
          .run(binding.session_id, binding.last_view_revision)
      }
    }
    report.ftsRebuilt = rebuildFtsIfNeeded(this.store.db)
    return report
  }
}

/**
 * @param {string} sessionId
 */
export function assertSessionId(sessionId: string) {
  if (!SESSION_ID.test(sessionId)) {
    throw Object.assign(new Error('session id rejected'), { code: 'VALIDATION' })
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} fts
 * @param {string} columns
 * @param {string} sessionId
 * @param {'facts' | 'memories'} table
 * @param {string} query
 * @param {number} limit
 */
function searchFts(
  db: SqlDatabase,
  fts: string,
  columns: string,
  sessionId: string,
  table: 'facts' | 'memories',
  query: string,
  limit: number,
) {
  const match = `"${query.replaceAll('"', ' ')}"`
  try {
    if (table === 'facts') {
      return db
        .prepare(`
        SELECT f.id, f.content, f.revision, f.priority
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        WHERE facts_fts MATCH ? AND f.session_id = ? AND f.status = 'active'
        LIMIT ?
      `)
        .all(match, sessionId, limit)
    }
    return db
      .prepare(`
      SELECT m.id, m.title, m.content, m.revision
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.session_id = ? AND m.status = 'active'
      LIMIT ?
    `)
      .all(match, sessionId, limit)
  } catch {
    return []
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function rebuildFtsIfNeeded(db: SqlDatabase) {
  const factCount = db.prepare(`SELECT count(*) AS n FROM facts WHERE status = 'active'`).get().n
  const memoryCount = db.prepare(`SELECT count(*) AS n FROM memories WHERE status = 'active'`).get().n
  let ftsFacts = 0
  let ftsMemories = 0
  try {
    ftsFacts = db.prepare('SELECT count(*) AS n FROM facts_fts').get().n
    ftsMemories = db.prepare('SELECT count(*) AS n FROM memories_fts').get().n
  } catch {
    ftsFacts = -1
  }
  if (ftsFacts === factCount && ftsMemories === memoryCount) return false
  db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('delete-all')`)
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('delete-all')`)
  const facts = db.prepare(`SELECT id, content FROM facts WHERE status = 'active'`).all()
  const insertFact = db.prepare('INSERT INTO facts_fts(rowid, content) VALUES (?, ?)')
  for (const fact of facts) insertFact.run(fact.id, fact.content)
  const memories = db.prepare(`SELECT id, title, content FROM memories WHERE status = 'active'`).all()
  const insertMemory = db.prepare('INSERT INTO memories_fts(rowid, title, content) VALUES (?, ?, ?)')
  for (const memory of memories) insertMemory.run(memory.id, memory.title ?? '', memory.content)
  return true
}

export function syncFactFts(db: SqlDatabase, id: number, content: string, active: boolean) {
  if (active) db.prepare('INSERT INTO facts_fts(rowid, content) VALUES (?, ?)').run(id, content)
  else db.prepare(`INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', ?, ?)`).run(id, content)
}

export function syncMemoryFts(db: SqlDatabase, id: number, title: string, content: string, active: boolean) {
  if (active)
    db.prepare('INSERT INTO memories_fts(rowid, title, content) VALUES (?, ?, ?)').run(id, title ?? '', content)
  else
    db.prepare(`INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', ?, ?, ?)`).run(
      id,
      title ?? '',
      content,
    )
}

export { EMPTY_STATE, SKILL_ID }

/**
 * @param {string} file
 * @returns {string}
 */
export function readText(file: string): string {
  return readFileSync(file, 'utf8')
}
