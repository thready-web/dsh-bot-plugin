import { durableFollowup } from './work-durable.ts'
import { sha256 } from './fs-safe.ts'
import { DEFAULT_WORK_BUDGET } from './work-admit.ts'

/**
 * Child inputs and main-session wakes share one durability algorithm.
 * They are not rows in `deliveries`.
 */

/**
 * @param {{ text: string, revision: number, budget: { wallMs?: number, maxTokens?: number }, kind?: string }} input
 */
export function renderBriefing(input: {
  text: string
  revision: number
  budget: { wallMs?: number; maxTokens?: number }
  kind?: string
}) {
  const material = sha256(input.text)
  const lines = [
    '[foundations:briefing]',
    `briefing_revision: ${input.revision}`,
    `budget_wall_ms: ${input.budget?.wallMs ?? ''}`,
    `budget_max_tokens: ${input.budget?.maxTokens ?? ''}`,
    'There is no step cap.',
    'When the allotted time or tokens run out, the host asks the main session for more. It does not fail the ticket immediately.',
    `material_sha256: ${material}`,
    'When no separate read-only material is attached, the material hash equals the task-text hash.',
    'Forbidden: do not write the main session, do not change persona or long-term memory, do not send outward, and do not approve spending.',
    'Report only with foundations_report. kind must be progress, question, artifact, result, or failure.',
    'This is not cross-bot mail and cannot raise permissions.',
    '---',
    input.text,
  ]
  if (input.kind === 'cancel_note') {
    return [
      '[foundations:briefing]',
      `briefing_revision: ${input.revision}`,
      'This is a cancellation note. Stop new outward actions. Do not treat the result as publishable.',
      '---',
      input.text,
    ].join('\n')
  }
  return lines.join('\n')
}

/**
 * @param {string[]} lines
 */
export function renderNotice(lines: string[]) {
  return [
    '[foundations:ticket]',
    'This is a ticket notice, not something the user said, and not the final reply.',
    'accepted means received. enqueued means placed on the execution queue. started is the only status that means work has begun.',
    ...lines,
  ].join('\n')
}

/**
 * @param {ReturnType<typeof import('./work-tickets.js').createTicketBook>} book
 * @param {{
 *   pid: number,
 *   inflight: Set<string>,
 *   logHas: (sessionId: string, messageId: string) => Promise<boolean>,
 *   push: (sessionId: string, messageId: string, text: string) => Promise<{ ok?: boolean, ambiguous?: boolean, seq?: number | null, error?: string }>,
 * }} deps
 */
export async function reconcileInputs(
  book: ReturnType<typeof import('./work-tickets.ts').createTicketBook>,
  deps: {
    pid: number
    inflight: Set<string>
    logHas: (sessionId: string, messageId: string) => Promise<boolean>
    push: (
      sessionId: string,
      messageId: string,
      text: string,
    ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  },
) {
  for (const input of book.flushInputs()) {
    if (deps.inflight.has(input.native_message_id)) continue
    const attempt = book.attempt(input.attempt_id)
    const sessionId = attempt?.child_session_id
    if (!sessionId) continue
    const seen = await readLog(deps, sessionId, input.native_message_id)
    if (seen.unreadable) {
      book.markInputFlush(input.id, 'ambiguous', deps.pid, 'log-unreadable', null, false)
      continue
    }
    if (seen.found) {
      book.noteInputAccepted(input, seen.seq ?? input.log_seq ?? null)
      continue
    }
    if (input.flush_attempts >= 5) {
      book.markInputFlush(input.id, 'dead', input.flush_pid ?? null, 'retry-limit', null, false)
      continue
    }
    if ((input.flush_status === 'ambiguous' || input.flush_status === 'flushing') && input.flush_pid === deps.pid)
      continue
    await pushInput(book, input, deps)
  }
}

/**
 * @param {ReturnType<typeof import('./work-tickets.js').createTicketBook>} book
 * @param {{
 *   pid: number,
 *   inflight: Set<string>,
 *   logHas: (sessionId: string, messageId: string) => Promise<boolean>,
 *   push: (sessionId: string, messageId: string, text: string) => Promise<{ ok?: boolean, ambiguous?: boolean, seq?: number | null, error?: string }>,
 *   noticeText: (nativeId: string) => string,
 * }} deps
 */
export async function reconcileNotices(
  book: ReturnType<typeof import('./work-tickets.ts').createTicketBook>,
  deps: {
    pid: number
    inflight: Set<string>
    logHas: (sessionId: string, messageId: string) => Promise<boolean>
    push: (
      sessionId: string,
      messageId: string,
      text: string,
    ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
    noticeText: (nativeId: string) => string
  },
) {
  /** @type {Map<string, any[]>} */
  const groups: Map<string, any[]> = new Map()
  for (const notice of book.flushNotices()) {
    const list = groups.get(notice.native_message_id) ?? []
    list.push(notice)
    groups.set(notice.native_message_id, list)
  }
  for (const [nativeId, rows] of groups) {
    if (deps.inflight.has(nativeId)) continue
    const sample = rows[0]
    const attempts = Math.max(...rows.map(row => row.flush_attempts))
    const seen = await readLog(deps, sample.owner_session_id, nativeId)
    if (seen.unreadable) {
      book.markNoticeGroup(nativeId, 'ambiguous', deps.pid, 'log-unreadable', null, false)
      continue
    }
    if (seen.found) {
      book.markNoticeGroup(nativeId, 'accepted', sample.flush_pid ?? deps.pid, '', seen.seq ?? null, false)
      continue
    }
    if (attempts >= 5) {
      book.markNoticeGroup(nativeId, 'dead', sample.flush_pid ?? null, 'retry-limit', null, false)
      continue
    }
    if (
      rows.some(
        row => (row.flush_status === 'ambiguous' || row.flush_status === 'flushing') && row.flush_pid === deps.pid,
      )
    )
      continue
    await pushNotice(book, nativeId, sample.owner_session_id, deps.noticeText(nativeId), attempts, deps)
  }
}

/**
 * @param {ReturnType<typeof import('./work-tickets.js').createTicketBook>} book
 * @param {Record<string, any>} input
 * @param {{
 *   pid: number,
 *   inflight: Set<string>,
 *   push: (sessionId: string, messageId: string, text: string) => Promise<{ ok?: boolean, ambiguous?: boolean, seq?: number | null, error?: string }>,
 * }} deps
 */
export async function pushInput(
  book: ReturnType<typeof import('./work-tickets.ts').createTicketBook>,
  input: Record<string, any>,
  deps: {
    pid: number
    inflight: Set<string>
    push: (
      sessionId: string,
      messageId: string,
      text: string,
    ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  },
) {
  const attempt = book.attempt(input.attempt_id)
  const ticket = book.ticket(input.ticket_id)
  if (!attempt?.child_session_id || !ticket) return { ok: false, status: 'pending' }
  if (
    input.kind !== 'cancel_note' &&
    (['failed', 'cancelled', 'delivered'].includes(ticket.status) ||
      ticket.active_attempt_id !== input.attempt_id ||
      ticket.briefing_revision !== input.briefing_revision)
  ) {
    book.markInputFlush(input.id, 'dead', deps.pid, 'ticket-finished-or-superseded', null, false)
    return { ok: false, status: 'dead' }
  }
  let budget = { wallMs: DEFAULT_WORK_BUDGET.workerWallMs, maxTokens: DEFAULT_WORK_BUDGET.workerMaxTokens }
  try {
    budget = { ...budget, ...JSON.parse(ticket.budget_json) }
  } catch {
    /* host default */
  }
  const text = book.readBriefing(input.payload_hash)
  const body = renderBriefing({ text, revision: input.briefing_revision, budget, kind: input.kind })
  deps.inflight.add(input.native_message_id)
  try {
    return await durableFollowup({
      attempts: input.flush_attempts,
      markFlushing: () => book.markInputFlush(input.id, 'flushing', deps.pid, '', null, true),
      push: () => deps.push(attempt.child_session_id, input.native_message_id, body),
      markAccepted: seq => book.noteInputAccepted(input, seq),
      markAmbiguous: error => book.markInputFlush(input.id, 'ambiguous', deps.pid, error, null, false),
      markDead: error => book.markInputFlush(input.id, 'dead', deps.pid, error, null, false),
      markRetry: error => book.markInputFlush(input.id, 'intent', deps.pid, error, null, false),
    })
  } finally {
    deps.inflight.delete(input.native_message_id)
  }
}

/**
 * @param {ReturnType<typeof import('./work-tickets.js').createTicketBook>} book
 * @param {string} nativeId
 * @param {string} owner
 * @param {string} text
 * @param {number} attempts
 * @param {{
 *   pid: number,
 *   inflight: Set<string>,
 *   push: (sessionId: string, messageId: string, text: string) => Promise<{ ok?: boolean, ambiguous?: boolean, seq?: number | null, error?: string }>,
 * }} deps
 */
export async function pushNotice(
  book: ReturnType<typeof import('./work-tickets.ts').createTicketBook>,
  nativeId: string,
  owner: string,
  text: string,
  attempts: number,
  deps: {
    pid: number
    inflight: Set<string>
    push: (
      sessionId: string,
      messageId: string,
      text: string,
    ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  },
) {
  deps.inflight.add(nativeId)
  try {
    return await durableFollowup({
      attempts,
      markFlushing: () => book.markNoticeGroup(nativeId, 'flushing', deps.pid, '', null, true),
      push: () => deps.push(owner, nativeId, text),
      markAccepted: seq => book.markNoticeGroup(nativeId, 'accepted', deps.pid, '', seq, false),
      markAmbiguous: error => book.markNoticeGroup(nativeId, 'ambiguous', deps.pid, error, null, false),
      markDead: error => book.markNoticeGroup(nativeId, 'dead', deps.pid, error, null, false),
      markRetry: error => book.markNoticeGroup(nativeId, 'intent', deps.pid, error, null, false),
    })
  } finally {
    deps.inflight.delete(nativeId)
  }
}

/**
 * @param {{ logHas: (sessionId: string, messageId: string) => Promise<boolean> }} deps
 * @param {string} sessionId
 * @param {string} messageId
 */
async function readLog(
  deps: { logHas: (sessionId: string, messageId: string) => Promise<boolean> },
  sessionId: string,
  messageId: string,
) {
  try {
    const found = await deps.logHas(sessionId, messageId)
    return { found: found === true, unreadable: false, seq: null }
  } catch {
    return { found: false, unreadable: true, seq: null }
  }
}

/**
 * @param {{ data?: { id?: string, message?: { id?: string } } }} event
 */
export function messageIdOf(event: { data?: { id?: string; message?: { id?: string } } }) {
  return event?.data?.id ?? event?.data?.message?.id ?? ''
}

/**
 * @param {{ data?: { reason?: { kind?: string } } }} event
 */
export function reasonKindOf(event: { data?: { reason?: { kind?: string } } }) {
  const reason = event?.data?.reason
  return reason && typeof reason === 'object' ? (reason.kind ?? '') : ''
}
