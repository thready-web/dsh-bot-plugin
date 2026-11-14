import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './fs-safe.ts'
import type { SqlDatabase } from './store.ts'

export const ACTIVE_TICKET = Object.freeze(['accepted', 'enqueued', 'started', 'needs_user'])
/** Tickets that occupy a running execution slot, plus reserved starts stored as slot=held. */
export const SLOT_TICKET = Object.freeze(['enqueued', 'started'])
/** Cap on how long an accepted/needs_user ticket may occupy a reserved start slot. */
export const RESERVE_WALL_MS = 10 * 60 * 1000
const TERMINAL_KIND = new Set(['question', 'result', 'failure'])
const OPEN_NOTICE_FLUSH = new Set(['intent', 'flushing', 'ambiguous'])

/**
 * Ticket protocol tables. Callers own transactions when they need several statements together.
 * This module does not call a model and does not touch the native inbox.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} root
 * @param {() => Date} [now]
 */
export function createTicketBook(db: SqlDatabase, root: string, now: () => Date = () => new Date()) {
  const iso = () => now().toISOString()
  const SLOT_SQL = `status IN ('enqueued','started')
      OR (status IN ('accepted','needs_user') AND json_extract(budget_json, '$.slot') = 'held')`
  const QUEUE_SQL = `status = 'accepted'
      AND (json_extract(budget_json, '$.slot') IS NULL OR json_extract(budget_json, '$.slot') != 'held')`

  return {
    iso,
    countActive,
    countGlobal,
    countSlots,
    countGlobalSlots,
    countQueued,
    countGlobalQueued,
    slotHeld,
    reserveSlot,
    releaseSlot,
    nextPromotable,
    heldStarts,
    ticket: (id: string) => row('SELECT * FROM work_tickets WHERE id = ?', id),
    attempt: (id: string) => row('SELECT * FROM work_attempts WHERE id = ?', id),
    byIdempotency,
    attemptForChild,
    input: (id: string) => row('SELECT * FROM work_inputs WHERE id = ?', id),
    inputByNative,
    currentInput,
    event: (id: string) => row('SELECT * FROM work_events WHERE event_id = ?', id),
    writeBriefing,
    readBriefing,
    insertAccepted,
    setChildIfEmpty,
    insertInput,
    markEnqueued,
    markStarted,
    advanceGeneration,
    markCancelled,
    insertRetry,
    insertEvent,
    applyTerminal,
    touchLease,
    markExtensionOpen,
    extendBudget,
    failRunning,
    expireQuiet,
    insertDelivery,
    deliveryForEvent,
    abandonOpenDeliveries,
    setReview,
    bindDelivery,
    summaries,
    detail,
    liveStamp,
    liveBoard,
    liveBoardAll,
    pendingWake,
    openNotice,
    openDelivery,
    backgroundIds,
    latestNoticeAt,
    flushInputs,
    flushNotices,
    markInputFlush,
    markNoticeGroup,
    noteInputAccepted,
    setNoticeObserve,
    intentsFor,
    noticeIds,
    eventsWithoutNotice,
    insertNotices,
    attemptsOf,
    ownerIds,
    childIds,
  }

  /**
   * @param {string} sql
   * @param {unknown} arg
   */
  function row(sql: string, arg: unknown) {
    return db.prepare(sql).get(arg) ?? null
  }

  /**
   * @param {string} owner
   */
  function countActive(owner: string) {
    return db
      .prepare(`
      SELECT COUNT(*) AS n FROM work_tickets
      WHERE owner_session_id = ? AND status IN ('accepted','enqueued','started','needs_user')
    `)
      .get(owner).n
  }

  function countGlobal() {
    return db
      .prepare(`
      SELECT COUNT(*) AS n FROM work_tickets
      WHERE status IN ('accepted','enqueued','started','needs_user')
    `)
      .get().n
  }

  /**
   * Running execution slots for one bot. needs_user does not count unless a
   * resume has already reserved a slot.
   * @param {string} owner
   */
  function countSlots(owner: string) {
    return db.prepare(`SELECT COUNT(*) AS n FROM work_tickets WHERE owner_session_id = ? AND (${SLOT_SQL})`).get(owner)
      .n
  }

  function countGlobalSlots() {
    return db.prepare(`SELECT COUNT(*) AS n FROM work_tickets WHERE ${SLOT_SQL}`).get().n
  }

  /**
   * Accepted tickets waiting for a slot. A reserved start is not queued.
   * @param {string} owner
   */
  function countQueued(owner: string) {
    return db.prepare(`SELECT COUNT(*) AS n FROM work_tickets WHERE owner_session_id = ? AND ${QUEUE_SQL}`).get(owner).n
  }

  function countGlobalQueued() {
    return db.prepare(`SELECT COUNT(*) AS n FROM work_tickets WHERE ${QUEUE_SQL}`).get().n
  }

  /**
   * @param {{ budget_json?: string } | null | undefined} ticket
   */
  function slotHeld(ticket: { budget_json?: string } | null | undefined) {
    return budgetObject(ticket ?? {}).slot === 'held'
  }

  /**
   * Reserve a running slot on an accepted or needs_user ticket. Returns null
   * when the ticket is missing or already terminal.
   * @param {string} ticketId
   */
  function reserveSlot(ticketId: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return null
    if (ticket.status === 'cancelled' || ticket.status === 'failed' || ticket.status === 'delivered') return ticket
    if (ticket.status === 'enqueued' || ticket.status === 'started' || slotHeld(ticket)) return ticket
    const budget = { ...budgetObject(ticket), slot: 'held' }
    db.prepare(`UPDATE work_tickets SET budget_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(budget),
      iso(),
      ticketId,
    )
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  /**
   * @param {string} ticketId
   */
  function releaseSlot(ticketId: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket || !slotHeld(ticket)) return ticket
    const budget = budgetObject(ticket)
    delete budget.slot
    db.prepare(`UPDATE work_tickets SET budget_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(budget),
      iso(),
      ticketId,
    )
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  /**
   * Oldest ticket that can take a newly freed slot: a queued accept, a reserved
   * start that has not reached enqueued, or a needs_user resume with unflushed input.
   * FIFO is created_at, then SQLite rowid (insertion order), not ticket id.
   * The caller still checks per-bot and global slot caps before reserveSlot.
   */
  function nextPromotable() {
    return db
      .prepare(
        `
      SELECT t.* FROM work_tickets t
      LEFT JOIN work_attempts a ON a.id = t.active_attempt_id
      LEFT JOIN work_inputs i ON i.id = a.current_input_id
      WHERE t.status = 'accepted'
         OR (t.status IN ('accepted','needs_user') AND json_extract(t.budget_json, '$.slot') = 'held')
         OR (
           t.status = 'needs_user'
           AND t.child_session_id IS NOT NULL
           AND i.flush_status IN ('intent','ambiguous')
         )
      ORDER BY t.created_at ASC, t.rowid ASC
    `,
      )
      .all()
  }

  /**
   * Reserved starts that still need create/flush after a crash or a mid-start return.
   */
  function heldStarts() {
    return db
      .prepare(
        `
      SELECT * FROM work_tickets
      WHERE status IN ('accepted','needs_user') AND json_extract(budget_json, '$.slot') = 'held'
      ORDER BY created_at ASC, rowid ASC
    `,
      )
      .all()
  }

  /**
   * @param {string} owner
   * @param {string | null} key
   */
  function byIdempotency(owner: string, key: string | null) {
    if (key == null) return null
    return (
      db
        .prepare(`
      SELECT * FROM work_tickets WHERE owner_session_id = ? AND idempotency_key = ?
    `)
        .get(owner, key) ?? null
    )
  }

  /**
   * @param {string} sessionId
   */
  function attemptForChild(sessionId: string) {
    return (
      db
        .prepare(`
      SELECT * FROM work_attempts WHERE child_session_id = ? ORDER BY fencing_token DESC LIMIT 1
    `)
        .get(sessionId) ?? null
    )
  }

  /**
   * @param {string} nativeId
   */
  function inputByNative(nativeId: string) {
    return db.prepare('SELECT * FROM work_inputs WHERE native_message_id = ?').get(nativeId) ?? null
  }

  /**
   * @param {{ current_input_id?: string | null }} attempt
   */
  function currentInput(attempt: { current_input_id?: string | null }) {
    if (!attempt?.current_input_id) return null
    return row('SELECT * FROM work_inputs WHERE id = ?', attempt.current_input_id)
  }

  /**
   * @param {string} text
   */
  function writeBriefing(text: string) {
    const hash = sha256(text)
    const dir = join(root, 'blobs', 'work')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${hash}.txt`)
    if (!existsSync(file)) writeFileSync(file, text, { mode: 0o600 })
    return hash
  }

  /**
   * @param {string} hash
   */
  function readBriefing(hash: string) {
    const file = join(root, 'blobs', 'work', `${hash}.txt`)
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  }

  /**
   * @param {{
   *   owner: string,
   *   briefing: string,
   *   idempotencyKey: string | null,
   *   correlationId: string,
   *   budget: Record<string, number>,
   * }} input
   */
  function insertAccepted(input: {
    owner: string
    briefing: string
    idempotencyKey: string | null
    correlationId: string
    budget: Record<string, number>
  }) {
    const ticketId = randomUUID()
    const attemptId = randomUUID()
    const stamp = iso()
    const hash = writeBriefing(input.briefing)
    db.prepare(`
      INSERT INTO work_attempts (
        id, ticket_id, child_session_id, fencing_token, briefing_revision, current_input_id, status,
        lease_until, lease_observed_seq, started_at, ended_at
      ) VALUES (?, ?, NULL, 1, 1, NULL, 'starting', NULL, NULL, NULL, NULL)
    `).run(attemptId, ticketId)
    db.prepare(`
      INSERT INTO work_tickets (
        id, owner_session_id, child_session_id, revision, briefing_revision, status, review_status,
        active_attempt_id, briefing_hash, correlation_id, idempotency_key, parent_ticket_id, budget_json,
        cancel_requested_revision, created_at, updated_at
      ) VALUES (?, ?, NULL, 1, 1, 'accepted', 'none', ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    `).run(
      ticketId,
      input.owner,
      attemptId,
      hash,
      input.correlationId ?? '',
      input.idempotencyKey,
      JSON.stringify(input.budget),
      stamp,
      stamp,
    )
    return {
      ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId),
      attempt: row('SELECT * FROM work_attempts WHERE id = ?', attemptId),
    }
  }

  /**
   * @param {string} ticketId
   * @param {string} childSessionId
   */
  function setChildIfEmpty(
    ticketId: string,
    childSessionId: string,
    expected?: { attemptId?: string; fencingToken?: number },
  ) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return { ticket: null, attached: false }
    if (ticket.status === 'cancelled' || ticket.status === 'failed' || ticket.status === 'delivered') {
      return { ticket, attached: false }
    }
    if (ticket.child_session_id) {
      return { ticket, attached: ticket.child_session_id === childSessionId }
    }
    const attempt = ticket.active_attempt_id
      ? row('SELECT * FROM work_attempts WHERE id = ?', ticket.active_attempt_id)
      : null
    if (expected?.attemptId && attempt?.id !== expected.attemptId) return { ticket, attached: false }
    if (expected?.fencingToken != null && attempt && attempt.fencing_token !== expected.fencingToken) {
      return { ticket, attached: false }
    }
    db.prepare(`
      UPDATE work_tickets SET child_session_id = ?, updated_at = ? WHERE id = ? AND child_session_id IS NULL
    `).run(childSessionId, iso(), ticketId)
    if (ticket.active_attempt_id) {
      db.prepare(`
        UPDATE work_attempts SET child_session_id = ? WHERE id = ? AND child_session_id IS NULL
      `).run(childSessionId, ticket.active_attempt_id)
    }
    const fresh = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    return { ticket: fresh, attached: fresh?.child_session_id === childSessionId }
  }

  /**
   * @param {{
   *   ticketId: string,
   *   attemptId: string,
   *   revision: number,
   *   kind: 'briefing' | 'supply' | 'redirect' | 'cancel_note',
   *   text: string,
   * }} input
   */
  function insertInput(input: {
    ticketId: string
    attemptId: string
    revision: number
    kind: 'briefing' | 'supply' | 'redirect' | 'cancel_note'
    text: string
  }) {
    const id = randomUUID()
    const native = randomUUID()
    const stamp = iso()
    const hash = sha256(input.text)
    writeBriefing(input.text)
    db.prepare(`
      INSERT INTO work_inputs (
        id, ticket_id, attempt_id, briefing_revision, kind, native_message_id, payload_hash,
        flush_status, flush_pid, flush_attempts, last_error, log_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', NULL, 0, '', NULL, ?, ?)
    `).run(id, input.ticketId, input.attemptId, input.revision, input.kind, native, hash, stamp, stamp)
    db.prepare(`
      UPDATE work_attempts SET current_input_id = ?, briefing_revision = ? WHERE id = ?
    `).run(id, input.revision, input.attemptId)
    return row('SELECT * FROM work_inputs WHERE id = ?', id)
  }

  /**
   * Flush of the current input confirmed. Status becomes enqueued. Revision is not a command.
   * @param {string} ticketId
   */
  function markEnqueued(ticketId: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket || ticket.status === 'cancelled' || ticket.status === 'failed' || ticket.status === 'delivered')
      return ticket
    db.prepare(`UPDATE work_tickets SET status = 'enqueued', updated_at = ? WHERE id = ?`).run(iso(), ticketId)
    db.prepare(`
      UPDATE work_attempts
      SET status = 'enqueued', started_at = NULL, ended_at = NULL
      WHERE id = ? AND status IN ('starting','enqueued','started','succeeded')
    `).run(ticket.active_attempt_id)
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  /**
   * @param {string} ticketId
   * @param {string} nativeMessageId
   */
  function markStarted(ticketId: string, nativeMessageId: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    const attempt = ticket ? row('SELECT * FROM work_attempts WHERE id = ?', ticket.active_attempt_id) : null
    const input = attempt ? currentInput(attempt) : null
    if (!ticket || !attempt || !input) return null
    if (input.native_message_id !== nativeMessageId) return ticket
    if (input.briefing_revision !== ticket.briefing_revision) return ticket
    if (ticket.status !== 'accepted' && ticket.status !== 'enqueued' && ticket.status !== 'started') return ticket
    const stamp = iso()
    if (ticket.status !== 'started') {
      db.prepare(`UPDATE work_tickets SET status = 'started', updated_at = ? WHERE id = ?`).run(stamp, ticketId)
    }
    db.prepare(`
      UPDATE work_attempts
      SET status = 'started', started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(stamp, attempt.id)
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  /**
   * redirect or supply. Revision and briefing_revision both increment before flush.
   * Ticket status stays until flush confirms. Returns null on CAS conflict.
   * @param {string} ticketId
   * @param {number | null} expectedRevision
   * @param {'supply' | 'redirect'} kind
   * @param {string} text
   */
  function advanceGeneration(
    ticketId: string,
    expectedRevision: number | null,
    kind: 'supply' | 'redirect',
    text: string,
  ) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return { error: 'NOT_FOUND' }
    const allowed =
      kind === 'supply'
        ? ticket.status === 'needs_user' || ticket.status === 'enqueued'
        : ticket.status === 'accepted' ||
          ticket.status === 'enqueued' ||
          ticket.status === 'started' ||
          ticket.status === 'needs_user' ||
          ticket.status === 'ready'
    if (!allowed)
      return {
        error: 'VALIDATION',
        message: `Ticket status ${ticket.status} cannot ${kind === 'supply' ? 'supply' : 'redirect'}.`,
      }
    if (!ticket.child_session_id)
      return {
        error: 'VALIDATION',
        message: 'The worker session does not exist yet, so this generation cannot be changed.',
      }
    const expected = expectedRevision == null ? ticket.revision : expectedRevision
    if (expected !== ticket.revision) return { error: 'CAS_CONFLICT' }
    const nextRevision = ticket.revision + 1
    const nextBrief = ticket.briefing_revision + 1
    const hash = writeBriefing(text)
    const info = db
      .prepare(`
      UPDATE work_tickets
      SET revision = ?, briefing_revision = ?, briefing_hash = ?, review_status = 'none', updated_at = ?
      WHERE id = ? AND revision = ?
    `)
      .run(nextRevision, nextBrief, hash, iso(), ticketId, expected)
    if (info.changes !== 1) return { error: 'CAS_CONFLICT' }
    abandonOpenDeliveries(ticketId, nextBrief)
    const input = insertInput({
      ticketId,
      attemptId: ticket.active_attempt_id,
      revision: nextBrief,
      kind,
      text,
    })
    db.prepare(`
      UPDATE work_events SET apply_status = 'stale'
      WHERE ticket_id = ? AND briefing_revision < ? AND apply_status != 'stale'
    `).run(ticketId, nextBrief)
    return { ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId), input }
  }

  /**
   * @param {string} ticketId
   * @param {number | null} expectedRevision
   * @param {string} [note]
   */
  function markCancelled(ticketId: string, expectedRevision: number | null, note?: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return { error: 'NOT_FOUND' }
    if (ticket.status === 'delivered')
      return { error: 'VALIDATION', message: 'A delivered ticket cannot be cancelled.' }
    if (ticket.status === 'cancelled') return { ticket, input: null, already: true }
    const expected = expectedRevision == null ? ticket.revision : expectedRevision
    if (expected !== ticket.revision) return { error: 'CAS_CONFLICT' }
    const next = ticket.revision + 1
    const info = db
      .prepare(`
      UPDATE work_tickets
      SET revision = ?, status = 'cancelled', cancel_requested_revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `)
      .run(next, next, iso(), ticketId, expected)
    if (info.changes !== 1) return { error: 'CAS_CONFLICT' }
    db.prepare(`
      UPDATE work_attempts SET status = 'cancelled', ended_at = ? WHERE id = ? AND status != 'superseded'
    `).run(iso(), ticket.active_attempt_id)
    db.prepare(`
      UPDATE work_events SET apply_status = 'stale'
      WHERE ticket_id = ? AND apply_status != 'stale'
    `).run(ticketId)
    abandonOpenDeliveries(ticketId, 1_000_000)
    let input = null
    if (typeof note === 'string' && note.trim() !== '' && ticket.child_session_id) {
      input = insertInput({
        ticketId,
        attemptId: ticket.active_attempt_id,
        revision: ticket.briefing_revision,
        kind: 'cancel_note',
        text: note,
      })
    }
    return { ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId), input, already: false }
  }

  /**
   * Explicit retry from failed or cancelled. Same child id, new fencing token.
   * @param {string} ticketId
   * @param {number | null} expectedRevision
   */
  function insertRetry(ticketId: string, expectedRevision: number | null) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return { error: 'NOT_FOUND' }
    if (ticket.status !== 'failed' && ticket.status !== 'cancelled') {
      return { error: 'VALIDATION', message: 'Only a failed or cancelled ticket can be retried.' }
    }
    const expected = expectedRevision == null ? ticket.revision : expectedRevision
    if (expected !== ticket.revision) return { error: 'CAS_CONFLICT' }
    const previous = row('SELECT * FROM work_attempts WHERE id = ?', ticket.active_attempt_id)
    const token = (previous?.fencing_token ?? 0) + 1
    const attemptId = randomUUID()
    const next = ticket.revision + 1
    const retryBudget = budgetObject(ticket)
    delete retryBudget.quota
    delete retryBudget.extension
    const info = db
      .prepare(`
      UPDATE work_tickets
      SET budget_json = ?, revision = ?, briefing_revision = 1, status = 'accepted', review_status = 'none',
          active_attempt_id = ?, cancel_requested_revision = NULL, updated_at = ?
      WHERE id = ? AND revision = ?
    `)
      .run(JSON.stringify(retryBudget), next, attemptId, iso(), ticketId, expected)
    if (info.changes !== 1) return { error: 'CAS_CONFLICT' }
    if (previous) {
      db.prepare(`UPDATE work_attempts SET status = 'superseded', ended_at = COALESCE(ended_at, ?) WHERE id = ?`).run(
        iso(),
        previous.id,
      )
    }
    db.prepare(`
      INSERT INTO work_attempts (
        id, ticket_id, child_session_id, fencing_token, briefing_revision, current_input_id, status,
        lease_until, lease_observed_seq, started_at, ended_at
      ) VALUES (?, ?, ?, ?, 1, NULL, 'starting', NULL, NULL, NULL, NULL)
    `).run(attemptId, ticketId, ticket.child_session_id, token)
    const briefing = readBriefing(ticket.briefing_hash)
    const input = insertInput({
      ticketId,
      attemptId,
      revision: 1,
      kind: 'briefing',
      text: briefing,
    })
    return {
      ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId),
      attempt: row('SELECT * FROM work_attempts WHERE id = ?', attemptId),
      input,
    }
  }

  /**
   * @param {{
   *   ticketId: string,
   *   attemptId: string,
   *   fencingToken: number,
   *   briefingRevision: number,
   *   kind: string,
   *   text: string,
   *   applyStatus: 'pending_completion' | 'applied' | 'stale',
   * }} input
   */
  function insertEvent(input: {
    ticketId: string
    attemptId: string
    fencingToken: number
    briefingRevision: number
    kind: string
    text: string
    applyStatus: 'pending_completion' | 'applied' | 'stale'
  }) {
    const eventId = randomUUID()
    const hash = writeBriefing(input.text)
    try {
      db.prepare(`
        INSERT INTO work_events (
          event_id, ticket_id, attempt_id, fencing_token, briefing_revision, kind, apply_status,
          turn_end_reason, payload_hash, notice_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
      `).run(
        eventId,
        input.ticketId,
        input.attemptId,
        input.fencingToken,
        input.briefingRevision,
        input.kind,
        input.applyStatus,
        hash,
        iso(),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('UNIQUE') || message.includes('PRIMARY')) return { duplicate: true, event: null }
      throw error
    }
    return { duplicate: false, event: row('SELECT * FROM work_events WHERE event_id = ?', eventId) }
  }

  /**
   * @param {string} eventId
   * @param {string} reasonKind
   */
  function applyTerminal(eventId: string, reasonKind: string) {
    const found = row('SELECT * FROM work_events WHERE event_id = ?', eventId)
    if (!found || !TERMINAL_KIND.has(found.kind)) return null
    if (found.apply_status === 'stale') {
      db.prepare(`UPDATE work_events SET turn_end_reason = ? WHERE event_id = ?`).run(reasonKind, eventId)
      return row('SELECT * FROM work_events WHERE event_id = ?', eventId)
    }
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', found.ticket_id)
    const attempt = row('SELECT * FROM work_attempts WHERE id = ?', found.attempt_id)
    const matches = Boolean(
      ticket &&
        attempt &&
        ticket.active_attempt_id === found.attempt_id &&
        attempt.fencing_token === found.fencing_token &&
        ticket.briefing_revision === found.briefing_revision &&
        ticket.status !== 'cancelled' &&
        ticket.status !== 'failed' &&
        ticket.status !== 'delivered',
    )
    if (!matches || reasonKind !== 'completed') {
      db.prepare(`UPDATE work_events SET apply_status = 'stale', turn_end_reason = ? WHERE event_id = ?`).run(
        reasonKind || '',
        eventId,
      )
      return row('SELECT * FROM work_events WHERE event_id = ?', eventId)
    }
    db.prepare(`UPDATE work_events SET apply_status = 'applied', turn_end_reason = ? WHERE event_id = ?`).run(
      reasonKind,
      eventId,
    )
    const stamp = iso()
    if (found.kind === 'question') {
      const budget = budgetObject(ticket)
      delete budget.slot
      db.prepare(`UPDATE work_tickets SET status = 'needs_user', budget_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(budget),
        stamp,
        ticket.id,
      )
    } else if (found.kind === 'result') {
      const review = ticket.review_status === 'rejected' ? 'rejected' : 'candidate'
      db.prepare(`
        UPDATE work_tickets SET status = 'ready', review_status = ?, updated_at = ? WHERE id = ?
      `).run(review, stamp, ticket.id)
      db.prepare(`UPDATE work_attempts SET status = 'succeeded', ended_at = ? WHERE id = ?`).run(stamp, attempt.id)
    } else if (found.kind === 'failure') {
      db.prepare(`UPDATE work_tickets SET status = 'failed', updated_at = ? WHERE id = ?`).run(stamp, ticket.id)
      db.prepare(`UPDATE work_attempts SET status = 'failed', ended_at = ? WHERE id = ?`).run(stamp, attempt.id)
    }
    return row('SELECT * FROM work_events WHERE event_id = ?', eventId)
  }

  /**
   * @param {string} attemptId
   * @param {string} until
   * @param {number | null} seq
   */
  function touchLease(attemptId: string, until: string, seq: number | null) {
    db.prepare(`
      UPDATE work_attempts
      SET lease_until = ?, lease_observed_seq = COALESCE(?, lease_observed_seq)
      WHERE id = ?
    `).run(until, seq, attemptId)
  }

  /**
   * One open extension request per ticket. A second ask does not insert another notice.
   * @param {string} ticketId
   */
  function markExtensionOpen(ticketId: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return null
    const budget = budgetObject(ticket)
    if (budget.extension === 'open') return { ticket, already: true }
    budget.extension = 'open'
    db.prepare(`UPDATE work_tickets SET budget_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(budget),
      iso(),
      ticketId,
    )
    return { ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId), already: false }
  }

  /**
   * Add granted runtime or tokens and close the request when the new totals
   * exceed current usage. There is no cumulative ceiling and no grant-count cap.
   * @param {string} ticketId
   * @param {{ wallMs?: number, maxTokens?: number }} add
   * @param {{ wallMs: number, maxTokens: number }} [baseline]
   */
  function extendBudget(
    ticketId: string,
    add: { wallMs?: number; maxTokens?: number },
    baseline?: { wallMs: number; maxTokens: number },
  ) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return { error: 'NOT_FOUND', message: 'No such ticket.' }
    if (ticket.status === 'failed' || ticket.status === 'cancelled' || ticket.status === 'delivered') {
      return { error: 'VALIDATION', message: 'This ticket has finished and cannot be granted more budget.' }
    }
    const budget = budgetObject(ticket)
    const beforeWall = Number(budget.wallMs) || baseline?.wallMs || 0
    const beforeTokens = Number(budget.maxTokens) || baseline?.maxTokens || 0
    const wallAdd = Number(add.wallMs)
    const tokenAdd = Number(add.maxTokens)
    const wallMs = Number.isFinite(wallAdd) && wallAdd > 0 ? beforeWall + Math.floor(wallAdd) : beforeWall
    const maxTokens = Number.isFinite(tokenAdd) && tokenAdd > 0 ? beforeTokens + Math.floor(tokenAdd) : beforeTokens
    if (wallMs === beforeWall && maxTokens === beforeTokens) {
      return { error: 'VALIDATION', message: 'Pass wallMs or maxTokens to add.' }
    }
    const quota = budget.quota
    const enough = !quota?.waiting || (maxTokens > quota.tokens && wallMs > quota.activeMs)
    const next = {
      ...budget,
      wallMs,
      maxTokens,
      extension: enough ? null : 'open',
      // Only actual loop admission clears durable waiting. A crash after this
      // grant transaction must not remove expiry protection before resumption.
    }
    db.prepare(`UPDATE work_tickets SET budget_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(next),
      iso(),
      ticketId,
    )
    return { ticket: row('SELECT * FROM work_tickets WHERE id = ?', ticketId), budget: next }
  }

  /**
   * @param {{ budget_json?: string }} ticket
   */
  function budgetObject(ticket: { budget_json?: string }) {
    try {
      const parsed = JSON.parse(ticket.budget_json ?? '')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * Lease or enqueue-wall or step budget. Does not open another attempt.
   * @param {string} ticketId
   * @param {string} reason
   */
  function failRunning(ticketId: string, reason: string) {
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
    if (!ticket) return null
    if (ticket.status === 'delivered' || ticket.status === 'cancelled' || ticket.status === 'failed') return ticket
    const stamp = iso()
    db.prepare(`UPDATE work_tickets SET status = 'failed', updated_at = ? WHERE id = ?`).run(stamp, ticketId)
    db.prepare(`
      UPDATE work_attempts SET status = 'failed', ended_at = ? WHERE id = ? AND status != 'superseded'
    `).run(stamp, ticket.active_attempt_id)
    db.prepare(`
      UPDATE work_events SET apply_status = 'stale'
      WHERE ticket_id = ? AND apply_status = 'pending_completion'
    `).run(ticketId)
    const attempt = row('SELECT * FROM work_attempts WHERE id = ?', ticket.active_attempt_id)
    if (attempt) {
      insertEvent({
        ticketId,
        attemptId: attempt.id,
        fencingToken: attempt.fencing_token,
        briefingRevision: ticket.briefing_revision,
        kind: 'failure',
        text: hostFailureText(reason),
        applyStatus: 'applied',
      })
    }
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  function extensionIsOpen(budgetJson: string) {
    try {
      return JSON.parse(budgetJson ?? '')?.extension === 'open'
    } catch {
      return false
    }
  }

  function expireQuiet() {
    const failed = []
    const running = db
      .prepare(`
      SELECT t.id AS ticket_id, t.budget_json, t.status AS ticket_status, t.child_session_id,
             a.id AS attempt_id, a.status AS attempt_status,
             a.lease_until, a.current_input_id
      FROM work_tickets t
      JOIN work_attempts a ON a.id = t.active_attempt_id
      WHERE t.status IN ('enqueued','started')
    `)
      .all()
    for (const item of running) {
      if (budgetObject(item).quota?.waiting) continue
      if (
        item.ticket_status === 'started' &&
        item.attempt_status === 'started' &&
        item.lease_until &&
        Date.parse(item.lease_until) <= now().getTime()
      ) {
        // The host already asked main to grant, not to mark the ticket failed.
        if (extensionIsOpen(item.budget_json)) continue
        failRunning(item.ticket_id, 'lease')
        failed.push({ ticketId: item.ticket_id, reason: 'lease', childSessionId: item.child_session_id ?? null })
        continue
      }
      if (item.ticket_status === 'enqueued' && item.attempt_status === 'enqueued' && item.current_input_id) {
        const input = row('SELECT * FROM work_inputs WHERE id = ?', item.current_input_id)
        let wall = 10 * 60 * 1000
        try {
          wall = JSON.parse(item.budget_json).wallMs ?? wall
        } catch {
          /* host default */
        }
        if (input && input.flush_status === 'accepted' && Date.parse(input.updated_at) + wall <= now().getTime()) {
          failRunning(item.ticket_id, 'enqueue-wall')
          failed.push({
            ticketId: item.ticket_id,
            reason: 'enqueue-wall',
            childSessionId: item.child_session_id ?? null,
          })
        }
      }
    }
    const reserved = db
      .prepare(`
      SELECT t.id AS ticket_id, t.budget_json, t.updated_at, t.child_session_id
      FROM work_tickets t
      WHERE t.status IN ('accepted','needs_user')
        AND json_extract(t.budget_json, '$.slot') = 'held'
    `)
      .all()
    for (const item of reserved) {
      let wall = RESERVE_WALL_MS
      try {
        const parsed = JSON.parse(item.budget_json)
        const ticketWall = Number(parsed?.wallMs)
        if (Number.isFinite(ticketWall) && ticketWall > 0) wall = Math.min(ticketWall, RESERVE_WALL_MS)
      } catch {
        /* host default */
      }
      if (Date.parse(item.updated_at) + wall <= now().getTime()) {
        failRunning(item.ticket_id, 'reserve-wall')
        failed.push({
          ticketId: item.ticket_id,
          reason: 'reserve-wall',
          childSessionId: item.child_session_id ?? null,
        })
      }
    }
    return failed
  }

  /**
   * @param {{
   *   ticketId: string,
   *   eventId: string,
   *   owner: string,
   *   attemptId: string,
   *   fencingToken: number,
   *   briefingRevision: number,
   *   text: string,
   *   turn: string | null,
   * }} input
   */
  function insertDelivery(input: {
    ticketId: string
    eventId: string
    owner: string
    attemptId: string
    fencingToken: number
    briefingRevision: number
    text: string
    turn: string | null
  }) {
    const existing = db
      .prepare(`
      SELECT * FROM user_deliveries WHERE ticket_id = ? AND result_event_id = ?
    `)
      .get(input.ticketId, input.eventId)
    if (existing) return { row: existing, already: true }
    const id = randomUUID()
    db.prepare(`
      INSERT INTO user_deliveries (
        publish_id, ticket_id, result_event_id, owner_session_id, attempt_id, fencing_token, briefing_revision,
        text_hash, status, assistant_seq, turn_native_id, client_ack_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intent', NULL, ?, NULL, ?)
    `).run(
      id,
      input.ticketId,
      input.eventId,
      input.owner,
      input.attemptId,
      input.fencingToken,
      input.briefingRevision,
      sha256(input.text),
      input.turn,
      iso(),
    )
    return { row: db.prepare('SELECT * FROM user_deliveries WHERE publish_id = ?').get(id), already: false }
  }

  /**
   * @param {string} ticketId
   * @param {string} eventId
   */
  function deliveryForEvent(ticketId: string, eventId: string) {
    return (
      db
        .prepare(`
      SELECT * FROM user_deliveries WHERE ticket_id = ? AND result_event_id = ?
    `)
        .get(ticketId, eventId) ?? null
    )
  }

  /**
   * @param {string} ticketId
   * @param {number} briefingRevision
   */
  function abandonOpenDeliveries(ticketId: string, briefingRevision: number) {
    db.prepare(`
      UPDATE user_deliveries SET status = 'abandoned'
      WHERE ticket_id = ? AND status = 'intent' AND briefing_revision < ?
    `).run(ticketId, briefingRevision)
  }

  /**
   * @param {string} ticketId
   * @param {'none' | 'candidate' | 'rejected'} review
   */
  function setReview(ticketId: string, review: 'none' | 'candidate' | 'rejected') {
    db.prepare(`UPDATE work_tickets SET review_status = ?, updated_at = ? WHERE id = ?`).run(review, iso(), ticketId)
    return row('SELECT * FROM work_tickets WHERE id = ?', ticketId)
  }

  /**
   * @param {string} publishId
   * @param {number} seq
   */
  function bindDelivery(publishId: string, seq: number) {
    const delivery = db.prepare('SELECT * FROM user_deliveries WHERE publish_id = ?').get(publishId)
    if (!delivery || delivery.status !== 'intent') return delivery
    db.prepare(`
      UPDATE user_deliveries SET status = 'log_bound', assistant_seq = ? WHERE publish_id = ? AND status = 'intent'
    `).run(seq, publishId)
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', delivery.ticket_id)
    if (ticket && ticket.status === 'ready' && ticket.briefing_revision === delivery.briefing_revision) {
      db.prepare(`UPDATE work_tickets SET status = 'delivered', updated_at = ? WHERE id = ? AND status = 'ready'`).run(
        iso(),
        ticket.id,
      )
    }
    return db.prepare('SELECT * FROM user_deliveries WHERE publish_id = ?').get(publishId)
  }

  /**
   * @param {string} owner
   */
  function visibleTickets(owner: string) {
    const rows = db
      .prepare(`
      SELECT * FROM work_tickets WHERE owner_session_id = ? ORDER BY updated_at DESC
    `)
      .all(owner)
    const open = rows.filter(
      item => item.status !== 'delivered' && item.status !== 'cancelled' && item.status !== 'failed',
    )
    const closed = rows.filter(item => !open.includes(item)).slice(0, 8)
    return [...open, ...closed]
  }

  /**
   * @param {string} owner
   */
  function summaries(owner: string) {
    return visibleTickets(owner).map(item => ({
      id: item.id,
      status: item.status,
      waiting_budget:
        (item.status === 'started' || item.status === 'enqueued') && budgetObject(item).quota?.waiting === true,
      briefing_revision: item.briefing_revision,
      child_session_id: item.child_session_id,
      summary: readBriefing(item.briefing_hash).replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
  }

  /** Stable across unchanged rows. Lease touches are not part of it. */
  function liveStamp() {
    const tickets = db
      .prepare(`
      SELECT id, status, briefing_revision, IFNULL(child_session_id, '') AS child_session_id,
             IFNULL(active_attempt_id, '') AS active_attempt_id, briefing_hash, updated_at
      FROM work_tickets ORDER BY id
    `)
      .all()
    const events = db
      .prepare(`
      SELECT event_id, apply_status, payload_hash FROM work_events ORDER BY event_id
    `)
      .all()
    const attempts = db
      .prepare(`
      SELECT id, IFNULL(started_at, '') AS started_at FROM work_attempts ORDER BY id
    `)
      .all()
    return JSON.stringify([tickets, events, attempts])
  }

  /** Delivered and cancelled tickets do not light a bot, so they stay out of signals. */
  function signalMap() {
    const rows = db
      .prepare(`
      SELECT owner_session_id, status, budget_json FROM work_tickets
      WHERE status != 'delivered' AND status != 'cancelled'
      ORDER BY updated_at DESC
    `)
      .all()
    /** @type {Record<string, string[]>} */
    const signals: Record<string, string[]> = {}
    for (const item of rows) {
      const owner = item.owner_session_id
      const list = signals[owner] ?? []
      list.push(
        (item.status === 'started' || item.status === 'enqueued') && budgetObject(item).quota?.waiting
          ? 'waiting_budget'
          : item.status,
      )
      signals[owner] = list
    }
    return signals
  }

  /**
   * Sidebar statuses for every owner, plus card bodies for one session.
   * Delivered and cancelled tickets do not light a bot, so they stay out of signals.
   * @param {string} sessionId
   */
  function liveBoard(sessionId: string) {
    return {
      ok: true,
      sessionId,
      signals: signalMap(),
      cards: sessionId === '' ? [] : cardBodies(sessionId),
    }
  }

  /** Cards for every owner, so one stream can follow a session switch. */
  function liveBoardAll() {
    const owners = db.prepare(`SELECT DISTINCT owner_session_id AS id FROM work_tickets`).all()
    /** @type {Record<string, ReturnType<typeof cardBodies>>} */
    const cards: Record<string, ReturnType<typeof cardBodies>> = {}
    for (const owner of owners) cards[owner.id] = cardBodies(owner.id)
    return { signals: signalMap(), cards }
  }

  /**
   * The same rows the ticket list shows, with the fields a card reads.
   * @param {string} owner
   */
  function cardBodies(owner: string) {
    const picked = visibleTickets(owner)
    if (picked.length === 0) return []
    const ids = picked.map(item => item.id)
    const marks = ids.map(() => '?').join(',')
    const attempts = db
      .prepare(`
      SELECT id, ticket_id, started_at FROM work_attempts WHERE ticket_id IN (${marks})
    `)
      .all(...ids)
    const events = db
      .prepare(`
      SELECT * FROM work_events WHERE ticket_id IN (${marks}) ORDER BY created_at
    `)
      .all(...ids)
    /** @type {Map<string, Array<{ id: string, started_at: string | null }>>} */
    const byAttempt: Map<string, Array<{ id: string; started_at: string | null }>> = new Map()
    for (const attempt of attempts) {
      const list = byAttempt.get(attempt.ticket_id) ?? []
      list.push({ id: attempt.id, started_at: attempt.started_at ?? null })
      byAttempt.set(attempt.ticket_id, list)
    }
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    const byEvent: Map<string, Array<Record<string, unknown>>> = new Map()
    for (const event of events) {
      const list = byEvent.get(event.ticket_id) ?? []
      list.push({
        event_id: event.event_id,
        kind: event.kind,
        apply_status: event.apply_status,
        briefing_revision: event.briefing_revision,
        text: readBriefing(event.payload_hash),
      })
      byEvent.set(event.ticket_id, list)
    }
    return picked.map(item => ({
      summary: readBriefing(item.briefing_hash).replace(/\s+/g, ' ').trim().slice(0, 80),
      ticket: {
        id: item.id,
        status: item.status,
        waiting_budget:
          (item.status === 'started' || item.status === 'enqueued') && budgetObject(item).quota?.waiting === true,
        briefing_revision: item.briefing_revision,
        child_session_id: item.child_session_id,
        active_attempt_id: item.active_attempt_id,
      },
      attempts: byAttempt.get(item.id) ?? [],
      events: byEvent.get(item.id) ?? [],
    }))
  }

  /**
   * @param {string} id
   */
  function detail(id: string) {
    const found = row('SELECT * FROM work_tickets WHERE id = ?', id)
    if (!found) return null
    return {
      ticket: found,
      attempts: db.prepare('SELECT * FROM work_attempts WHERE ticket_id = ? ORDER BY fencing_token').all(id),
      inputs: db.prepare('SELECT * FROM work_inputs WHERE ticket_id = ? ORDER BY created_at').all(id),
      events: db
        .prepare('SELECT * FROM work_events WHERE ticket_id = ? ORDER BY created_at')
        .all(id)
        .map(event => ({
          ...event,
          text: readBriefing(event.payload_hash),
        })),
      notices: db.prepare('SELECT * FROM work_notices WHERE ticket_id = ? ORDER BY created_at').all(id),
      deliveries: db.prepare('SELECT * FROM user_deliveries WHERE ticket_id = ? ORDER BY created_at').all(id),
    }
  }

  /**
   * @param {string} owner
   */
  function eventsWithoutNotice(owner: string) {
    return db
      .prepare(`
      SELECT e.* FROM work_events e
      JOIN work_tickets t ON t.id = e.ticket_id
      WHERE t.owner_session_id = ? AND e.notice_id IS NULL AND e.apply_status != 'stale'
      ORDER BY e.created_at
    `)
      .all(owner)
  }

  /**
   * @param {string} owner
   */
  function pendingWake(owner: string) {
    const events = eventsWithoutNotice(owner)
    const cancels = db
      .prepare(`
      SELECT * FROM work_tickets t
      WHERE t.owner_session_id = ? AND t.status = 'cancelled' AND t.cancel_requested_revision IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM work_notices n
          WHERE n.ticket_id = t.id AND n.event_id = 'cancel:' || t.cancel_requested_revision
        )
    `)
      .all(owner)
    return { events, cancels }
  }

  /**
   * @param {string} owner
   */
  function openNotice(owner: string) {
    const rows = db
      .prepare(`SELECT flush_status, observe_status FROM work_notices WHERE owner_session_id = ?`)
      .all(owner)
    return rows.some(
      item =>
        OPEN_NOTICE_FLUSH.has(item.flush_status) ||
        (item.flush_status === 'accepted' && item.observe_status !== 'completed'),
    )
  }

  /**
   * @param {string} owner
   */
  function openDelivery(owner: string) {
    const found = db
      .prepare(`
      SELECT 1 AS ok FROM deliveries
      WHERE target_session_id = ? AND kind IN ('message','timer','webhook')
        AND status IN ('intent','flushing','accepted','claimed','started')
      LIMIT 1
    `)
      .get(owner)
    return found != null
  }

  /**
   * @param {string} owner
   */
  function backgroundIds(owner: string) {
    const notices = db.prepare(`SELECT native_message_id FROM work_notices WHERE owner_session_id = ?`).all(owner)
    const deliveries = db.prepare(`SELECT id FROM deliveries WHERE target_session_id = ?`).all(owner)
    return [...notices.map(item => item.native_message_id), ...deliveries.map(item => item.id)]
  }

  /**
   * @param {string} owner
   */
  function latestNoticeAt(owner: string) {
    const found = db
      .prepare(`
      SELECT created_at FROM work_notices WHERE owner_session_id = ? ORDER BY created_at DESC LIMIT 1
    `)
      .get(owner)
    return found ? Date.parse(found.created_at) : null
  }

  function flushInputs() {
    return db
      .prepare(`
      SELECT * FROM work_inputs WHERE flush_status IN ('intent','flushing','ambiguous') ORDER BY created_at
    `)
      .all()
  }

  function flushNotices() {
    return db
      .prepare(`
      SELECT * FROM work_notices WHERE flush_status IN ('intent','flushing','ambiguous') ORDER BY created_at
    `)
      .all()
  }

  /**
   * @param {string} id
   * @param {string} status
   * @param {number | null} pid
   * @param {string} error
   * @param {number | null} seq
   * @param {boolean} bump
   */
  function markInputFlush(
    id: string,
    status: string,
    pid: number | null,
    error: string,
    seq: number | null,
    bump: boolean,
  ) {
    if (bump) {
      db.prepare(`
        UPDATE work_inputs
        SET flush_status = ?, flush_pid = ?, flush_attempts = flush_attempts + 1, last_error = ?, log_seq = COALESCE(?, log_seq), updated_at = ?
        WHERE id = ?
      `).run(status, pid, error, seq, iso(), id)
    } else {
      db.prepare(`
        UPDATE work_inputs
        SET flush_status = ?, flush_pid = COALESCE(?, flush_pid), last_error = ?, log_seq = COALESCE(?, log_seq), updated_at = ?
        WHERE id = ?
      `).run(status, pid, error, seq, iso(), id)
    }
    return row('SELECT * FROM work_inputs WHERE id = ?', id)
  }

  /**
   * @param {string} nativeId
   * @param {string} status
   * @param {number | null} pid
   * @param {string} error
   * @param {number | null} seq
   * @param {boolean} bump
   */
  function markNoticeGroup(
    nativeId: string,
    status: string,
    pid: number | null,
    error: string,
    seq: number | null,
    bump: boolean,
  ) {
    if (bump) {
      db.prepare(`
        UPDATE work_notices
        SET flush_status = ?, flush_pid = ?, flush_attempts = flush_attempts + 1, last_error = ?, log_seq = COALESCE(?, log_seq), updated_at = ?
        WHERE native_message_id = ?
      `).run(status, pid, error, seq, iso(), nativeId)
    } else {
      db.prepare(`
        UPDATE work_notices
        SET flush_status = ?, flush_pid = COALESCE(?, flush_pid), last_error = ?, log_seq = COALESCE(?, log_seq), updated_at = ?
        WHERE native_message_id = ?
      `).run(status, pid, error, seq, iso(), nativeId)
    }
  }

  /**
   * @param {import('node:sqlite').StatementResultRow} input
   * @param {number | null} seq
   */
  function noteInputAccepted(input: Record<string, any>, seq: number | null) {
    markInputFlush(input.id, 'accepted', input.flush_pid ?? null, '', seq, false)
    const ticket = row('SELECT * FROM work_tickets WHERE id = ?', input.ticket_id)
    if (!ticket || ticket.active_attempt_id !== input.attempt_id) return
    if (ticket.briefing_revision !== input.briefing_revision) return
    if (input.kind === 'cancel_note') return
    markEnqueued(ticket.id)
  }

  /**
   * @param {string} nativeId
   * @param {'claimed' | 'started' | 'completed'} status
   */
  function setNoticeObserve(nativeId: string, status: 'claimed' | 'started' | 'completed') {
    const rank: Record<string, number> = { none: 0, claimed: 1, started: 2, completed: 3 }
    const rows = db.prepare(`SELECT id, observe_status FROM work_notices WHERE native_message_id = ?`).all(nativeId)
    for (const item of rows) {
      if ((rank[item.observe_status] ?? 0) >= rank[status]) continue
      db.prepare(`UPDATE work_notices SET observe_status = ?, updated_at = ? WHERE id = ?`).run(status, iso(), item.id)
    }
  }

  /**
   * @param {string} owner
   */
  function intentsFor(owner: string) {
    return db
      .prepare(`
      SELECT * FROM user_deliveries WHERE owner_session_id = ? AND status = 'intent' ORDER BY created_at
    `)
      .all(owner)
  }

  /**
   * One native wake id shared by every event in the merged notice.
   * @param {string} nativeId
   * @param {string} owner
   * @param {Array<{ ticketId: string, eventId: string }>} items
   */
  function insertNotices(nativeId: string, owner: string, items: ReadonlyArray<{ ticketId: string; eventId: string }>) {
    const stamp = iso()
    /** @type {string[]} */
    const ids: string[] = []
    for (const item of items) {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO work_notices (
          id, ticket_id, event_id, owner_session_id, native_message_id, flush_status, flush_pid,
          flush_attempts, last_error, log_seq, observe_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'intent', NULL, 0, '', NULL, 'none', ?, ?)
      `).run(id, item.ticketId, item.eventId, owner, nativeId, stamp, stamp)
      if (!item.eventId.startsWith('cancel:')) {
        db.prepare(`UPDATE work_events SET notice_id = ? WHERE event_id = ? AND notice_id IS NULL`).run(
          id,
          item.eventId,
        )
      }
      ids.push(id)
    }
    return ids
  }

  function attemptsOf(ticketId: string) {
    return db.prepare('SELECT * FROM work_attempts WHERE ticket_id = ? ORDER BY fencing_token').all(ticketId)
  }

  function ownerIds() {
    return db
      .prepare(`SELECT DISTINCT owner_session_id AS id FROM work_tickets`)
      .all()
      .map(item => item.id)
  }

  function childIds() {
    return db
      .prepare(`
      SELECT DISTINCT child_session_id AS id FROM work_attempts
      WHERE child_session_id IS NOT NULL
    `)
      .all()
      .map(item => item.id)
  }

  /**
   * @param {string} owner
   */
  function noticeIds(owner: string) {
    return new Set(
      db
        .prepare(`SELECT native_message_id FROM work_notices WHERE owner_session_id = ?`)
        .all(owner)
        .map(item => item.native_message_id),
    )
  }
}

/**
 * @param {string} reason
 */
function hostFailureText(reason: string) {
  if (reason === 'wall') return 'The worker hit its time limit and this round has stopped.'
  if (reason === 'tokens') return 'The worker hit its token limit and this round has stopped.'
  if (reason === 'grant-denied') return 'The main session refused more budget and this round has stopped.'
  if (reason === 'lease') return 'The worker lease expired and this round has stopped.'
  if (reason === 'enqueue-wall') return 'The task entered the queue and did not start before the time limit.'
  if (reason === 'reserve-wall')
    return 'The reserved start did not create a worker before the time limit, so the slot was released.'
  if (reason === 'steps') return 'The worker hit its step limit and this round has stopped.'
  return 'The worker has stopped.'
}
