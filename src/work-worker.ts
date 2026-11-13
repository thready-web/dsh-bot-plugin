import { randomUUID } from 'node:crypto'
import { sha256 } from './fs-safe.ts'
import { toolError } from './errors.ts'
import { createTicketBook } from './work-tickets.ts'
import {
  decideAdmission,
  budgetTrip,
  estimateWorkerBudget,
  DEFAULT_WORK_BUDGET,
  effectiveWorkLimits,
} from './work-admit.ts'
import {
  messageIdOf,
  pushInput,
  pushNotice,
  reasonKindOf,
  reconcileInputs,
  reconcileNotices,
  renderNotice,
} from './work-ledger.ts'

const KINDS = new Set(['progress', 'question', 'artifact', 'result', 'failure'])
const LABEL: Record<string, string> = {
  accepted: 'accepted',
  enqueued: 'enqueued',
  started: 'started',
  needs_user: 'needs user',
  ready: 'candidate',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
}

type BudgetArm = {
  attemptId: string | null
  turn: number
  startedAt: number
  steps: number
  tokens: number
  lastSeq: number | null
  role: 'main' | 'worker'
  tight: boolean
  limits: { maxSteps: number; wallMs: number; maxTokens: number; ceilingWall: number; ceilingTokens: number }
  tripped: boolean
  /** This turn was woken by a [foundations:budget] notice, so a second trip does not post another. */
  budgetNotice: boolean
  extensionOpen: boolean
  closing: boolean
  pausedAt: number | null
  atBoundary: boolean
  clear: () => void
}

type WorkHostOptions = {
  createChild?: (spec: {
    sessionId: string
    ownerSessionId: string
    ticketId: string
    fencingToken: number
  }) => Promise<string>
  push?: (
    sessionId: string,
    messageId: string,
    text: string,
  ) => Promise<{ ok?: boolean; ambiguous?: boolean; seq?: number | null; error?: string }>
  logHas?: (sessionId: string, messageId: string) => Promise<boolean> | boolean
  remove?: (sessionId: string, messageId: string) => Promise<boolean> | boolean
  pendingIds?: (sessionId: string) => Promise<string[] | null> | string[] | null
  /**
   * Stop a running turn. `reason` becomes the DSH cancel cause
   * `{ kind: 'hook', reason }`; it is never reported as a user cancel.
   */
  cancel?: (sessionId: string, options: { keepInbox?: boolean; reason?: string }) => Promise<void> | void
  /** Host log sink. A budget trip is always logged at warn. */
  log?: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void
  /** Called once per main-session budget trip so the host can tell the user. */
  onMainBudget?: (sessionId: string, trip: MainBudgetTrip) => void
  snapshot?: (sessionId: string) => Promise<Array<Record<string, any>>> | Array<Record<string, any>>
  /** True when this process still holds a live child handle. */
  childPresent?: (sessionId: string) => Promise<boolean> | boolean
  resident?: boolean
  /** Explicit grants may re-enter the existing detached child via the durable inbox. */
  resumePaused?: boolean
  pid?: number
  now?: () => Date
  budget?: Partial<typeof DEFAULT_WORK_BUDGET>
  schedule?: (fn: () => void, ms: number) => () => void
}

export type MainBudgetTrip = {
  reason: 'steps' | 'wall'
  /** `main-budget:steps` or `main-budget:wall`; the DSH cancel/hook reason. */
  cause: string
  turn: number
  steps: number
  elapsedMs: number
  maxSteps: number
  wallMs: number
  /** `pre-step` = the next step was refused; `timer` = a running step was cancelled at the wall cap. */
  via: 'pre-step' | 'timer'
  /** False when this turn was itself a budget notice, so the host should not post another one. */
  notify: boolean
}

/** Message id prefix of the inbox notice sent after a main-session budget trip. */
export const BUDGET_NOTICE_PREFIX = 'foundations-budget:'

/**
 * Host-side ticket protocol. The model is not called from here.
 * Native inbox delivery stays in `options.push` / `options.pendingIds`.
 * @param {import('./store.js').Store} store
 * @param {import('./engine.js').Engine} engine
 */
export function createWorkRuntime(
  store: import('./store.ts').Store,
  engine: import('./engine.ts').Engine,
  options: WorkHostOptions = {},
) {
  const now = options.now ?? (() => new Date())
  const limits = { ...DEFAULT_WORK_BUDGET, ...options.budget }
  const slots = effectiveWorkLimits(limits)
  const pid = options.pid ?? process.pid
  const resident = options.resident !== false
  const book = createTicketBook(store.db, store.root, now)
  const inflight = new Set<string>()
  /** Ticket ids currently in ensureChild / flush, so a tick cannot start the same ticket twice. */
  const starting = new Set<string>()
  /** In-flight startReserved promises, so a later promoteQueued can join them. */
  const startingPromises = new Map<string, Promise<any>>()
  /** @type {Map<string, { messageId: string, turn: number | null, seq: number | null }>} */
  const turns: Map<string, { messageId: string; turn: number | null; seq: number | null }> = new Map()
  /** @type {Map<string, string>} */
  const wakeTurns: Map<string, string> = new Map()
  /** @type {Map<string, { turn: number, startedAt: number, steps: number, tokens: number, lastSeq: number | null, role: 'main' | 'worker', tight: boolean, limits: { maxSteps: number, wallMs: number, maxTokens: number, ceilingWall: number, ceilingTokens: number }, tripped: boolean, extensionOpen: boolean, closing: boolean, clear: () => void }>} */
  const arms: Map<string, BudgetArm> = new Map()
  /** @type {Map<string, number>} */
  const holds: Map<string, number> = new Map()
  const admitting = new Set<string>()
  const budgetWaiters = new Map<string, Set<(allowed: boolean) => void>>()
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const deps = {
    pid,
    inflight,
    logHas: async (sessionId: string, messageId: string) => {
      if (!options.logHas) return false
      return await options.logHas(sessionId, messageId)
    },
    push: async (sessionId: string, messageId: string, text: string) => {
      if (!options.push) return { ok: false, ambiguous: true, error: 'no-push' }
      return options.push(sessionId, messageId, text)
    },
    noticeText: (nativeId: string) => noticeText(nativeId),
  }

  return {
    limits,
    book,
    dispatch,
    supply,
    redirect,
    cancelTicket,
    retry,
    grant,
    publish,
    reject,
    report,
    holdNotices,
    releaseHold,
    tick,
    admit,
    promoteQueued,
    observeSession,
    observeClaimed,
    gateStep,
    waitForBudget,
    isWorkerSession,
    summaries: (owner: string) => book.summaries(owner),
    detail: (id: string) => book.detail(id),
    liveStamp: () => book.liveStamp(),
    liveBoard: (sessionId: string) => book.liveBoard(sessionId),
    liveBoardAll: () => book.liveBoardAll(),
    project,
  }

  /**
   * @param {string} sessionId
   */
  function isWorkerSession(sessionId: string) {
    return book.attemptForChild(sessionId) != null
  }

  /**
   * A running slot is free when both the per-bot and global running caps have room.
   * needs_user does not occupy a running slot.
   * @param {string} owner
   */
  function hasSlot(owner: string) {
    return book.countSlots(owner) < slots.perBot && book.countGlobalSlots() < slots.global
  }

  /**
   * Queue room is separate from running slots. The combined unfinished cap is
   * slots + queue, so parked needs_user tickets cannot grow without bound.
   * @param {string} owner
   */
  function canQueue(owner: string) {
    return (
      book.countQueued(owner) < slots.perBotQueue &&
      book.countGlobalQueued() < slots.globalQueue &&
      book.countActive(owner) < slots.perBot + slots.perBotQueue &&
      book.countGlobal() < slots.global + slots.globalQueue
    )
  }

  /**
   * @param {string} owner
   * @returns {'start' | 'queue' | 'refuse'}
   */
  function underCombinedCap(owner: string) {
    return (
      book.countActive(owner) < slots.perBot + slots.perBotQueue &&
      book.countGlobal() < slots.global + slots.globalQueue
    )
  }

  /**
   * @param {string} owner
   * @returns {'start' | 'queue' | 'refuse'}
   */
  function decideDispatch(owner: string) {
    // needs_user does not occupy a running slot, but it still counts as unfinished.
    // A free slot must not admit a new ticket once the combined cap is full.
    if (!underCombinedCap(owner)) return 'refuse'
    if (hasSlot(owner)) return 'start'
    if (canQueue(owner)) return 'queue'
    return 'refuse'
  }

  /**
   * Create the child if needed and flush the current briefing or supply.
   * @param {Record<string, any>} ticket
   */
  async function startReserved(ticket: Record<string, any>) {
    if (!resident) {
      return { ...publicDispatch(ticket), flush: 'pending', resident: false, message: 'Only a resident host continues' }
    }
    if (starting.has(ticket.id)) {
      return startingPromises.get(ticket.id) ?? publicDispatch(book.ticket(ticket.id) ?? ticket, { flush: 'pending' })
    }
    starting.add(ticket.id)
    const run = (async () => {
      const current = book.ticket(ticket.id)
      if (!current) return toolError('NOT_FOUND', 'No such ticket.')
      if (current.status === 'cancelled' || current.status === 'failed' || current.status === 'delivered') {
        return publicDispatch(current)
      }
      const created = await ensureChild(current)
      if (created.error) return created.error
      if (created.rejected) return publicDispatch(created.ticket ?? book.ticket(ticket.id) ?? current)
      const liveAfterStart = book.ticket(ticket.id)
      if (
        !liveAfterStart ||
        liveAfterStart.status === 'cancelled' ||
        liveAfterStart.status === 'failed' ||
        liveAfterStart.status === 'delivered'
      ) {
        return publicDispatch(liveAfterStart ?? current)
      }
      const input = await store.write('work', () => {
        const live = book.ticket(ticket.id)
        const liveAttempt = book.attempt(live.active_attempt_id)
        if (liveAttempt?.current_input_id) {
          const existing = book.input(liveAttempt.current_input_id)
          if (existing) return existing
        }
        const text = book.readBriefing(live.briefing_hash)
        return book.insertInput({
          ticketId: live.id,
          attemptId: liveAttempt.id,
          revision: live.briefing_revision,
          kind: 'briefing',
          text,
        })
      })
      if (input.flush_status === 'accepted') {
        return publicDispatch(book.ticket(ticket.id), { flush: 'accepted', nativeMessageId: input.native_message_id })
      }
      const flushed = await pushInput(book, input, deps)
      return publicDispatch(book.ticket(ticket.id), {
        flush: flushWord(flushed),
        nativeMessageId: input.native_message_id,
      })
    })()
    startingPromises.set(ticket.id, run)
    try {
      return await run
    } finally {
      starting.delete(ticket.id)
      startingPromises.delete(ticket.id)
    }
  }

  /**
   * Start waiting tickets that now fit a slot. Awaits only starts this call
   * launched, so a hung createChild from an earlier call cannot deadlock
   * later ticks or cancel. The earlier promise stays owned until it finishes
   * and is then attached or cleaned up.
   */
  async function promoteQueued() {
    if (!resident) return { started: [] }
    const started: string[] = []
    const launched: Promise<unknown>[] = []
    const launch = (ticket: Record<string, any> | null) => {
      if (!ticket?.id || starting.has(ticket.id)) return
      started.push(ticket.id)
      launched.push(
        startReserved(ticket).catch(error => {
          options.log?.(
            'warn',
            `session-foundations: startReserved failed ticket=${ticket.id} ${error instanceof Error ? error.message : String(error)}`,
          )
          return error
        }),
      )
    }
    for (const ticket of book.heldStarts()) launch(ticket)
    for (;;) {
      const claimed = await store.write('work', () => {
        for (const ticket of book.nextPromotable()) {
          if (book.slotHeld(ticket)) continue
          if (ticket.status !== 'accepted' && ticket.status !== 'needs_user') continue
          if (!hasSlot(ticket.owner_session_id)) continue
          return book.reserveSlot(ticket.id)
        }
        return null
      })
      if (!claimed) break
      launch(claimed)
    }
    await Promise.all(launched)
    // Join in-flight starts that are still allowed to attach. Do not join a
    // hung createChild after the ticket has already been cancelled, failed, or
    // expired, so a later tick can free the slot and start the next waiter.
    const pending = [...startingPromises.entries()]
      .filter(([id]) => {
        const ticket = book.ticket(id)
        return (
          ticket != null && ticket.status !== 'failed' && ticket.status !== 'cancelled' && ticket.status !== 'delivered'
        )
      })
      .map(([, promise]) => promise)
    await Promise.all(pending)
    return { started }
  }

  function schedulePromote() {
    void promoteQueued().catch(error => {
      options.log?.(
        'warn',
        `session-foundations: promoteQueued failed ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function dispatch(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner))
      return toolError('FORBIDDEN', 'An ordinary session stays on one loop and cannot dispatch work.')
    if (typeof args.parentTicketId === 'string' && args.parentTicketId !== '') {
      return toolError('VALIDATION', 'The MVP does not accept child tickets.')
    }
    const briefing = typeof args.briefing === 'string' ? args.briefing.trim() : ''
    if (briefing === '' || briefing.length > 16000) return toolError('VALIDATION', 'briefing is empty or too long.')
    const key =
      typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim() !== '' ? args.idempotencyKey.trim() : null
    const suggestion = args.budget && typeof args.budget === 'object' ? args.budget : null
    const budget = estimateWorkerBudget(briefing, suggestion, limits)
    const prepared = await store.write('work', () => {
      if (key) {
        const existing = book.byIdempotency(owner, key)
        if (existing) {
          if (existing.briefing_hash !== sha256(briefing))
            return {
              error: toolError('IDEMPOTENCY_KEY_REUSE', 'The same idempotency key was reused for a different task.'),
            }
          return { replay: existing }
        }
      }
      const decision = decideDispatch(owner)
      if (decision === 'refuse') {
        return {
          error: toolError(
            'BUDGET',
            'Unfinished tickets already hit the host slot and queue limits, so no row was created.',
          ),
        }
      }
      const created = book.insertAccepted({
        owner,
        briefing,
        idempotencyKey: key,
        correlationId: correlationOf(owner, args.correlationId),
        budget,
      })
      if (decision === 'start') book.reserveSlot(created.ticket.id)
      return { created, start: decision === 'start' }
    })
    if (prepared.error) return prepared.error
    if (prepared.replay) return publicDispatch(prepared.replay, { replayed: true })
    const ticket = prepared.created.ticket
    if (!prepared.start) {
      return publicDispatch(book.ticket(ticket.id), {
        flush: 'pending',
        queued: true,
        childSessionId: null,
        nativeMessageId: null,
      })
    }
    if (!resident) {
      return { ...publicDispatch(ticket), flush: 'pending', resident: false, message: 'Only a resident host continues' }
    }
    return startReserved(ticket)
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function supply(owner: string, args: Record<string, unknown>) {
    return retarget(owner, args, 'supply')
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function redirect(owner: string, args: Record<string, unknown>) {
    return retarget(owner, args, 'redirect')
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   * @param {'supply' | 'redirect'} kind
   */
  async function retarget(owner: string, args: Record<string, unknown>, kind: 'supply' | 'redirect') {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot change a ticket.')
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '' || text.length > 16000) return toolError('VALIDATION', 'text is empty or too long.')
    const found = resolveTicket(owner, args.ticketId, kind === 'supply' ? ['needs_user', 'enqueued'] : null)
    if (found.error) return found.error
    const expected = revisionOf(args.expectedRevision)
    const advanced = await store.write('work', () => {
      const result = book.advanceGeneration(found.ticket.id, expected, kind, text)
      if (result.error) return result
      // A supply into needs_user must take a running slot. If none is free, keep
      // the input durable and start it when promoteQueued reserves one.
      if (kind === 'supply' && result.ticket.status === 'needs_user' && !hasSlot(owner)) {
        return { ...result, queued: true }
      }
      if (kind === 'supply' && result.ticket.status === 'needs_user') book.reserveSlot(result.ticket.id)
      return result
    })
    if (advanced.error) return toolError(advanced.error, advanced.message ?? 'Changing the generation failed.')
    if (advanced.queued) {
      return publicDispatch(book.ticket(found.ticket.id), {
        flush: 'pending',
        queued: true,
        nativeMessageId: advanced.input.native_message_id,
      })
    }
    if (!resident)
      return { ...publicDispatch(advanced.ticket), flush: 'pending', message: 'Only a resident host continues' }
    const flushed = await pushInput(book, advanced.input, deps)
    return publicDispatch(book.ticket(found.ticket.id), {
      flush: flushWord(flushed),
      nativeMessageId: advanced.input.native_message_id,
    })
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function cancelTicket(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot cancel a ticket.')
    const found = resolveTicket(owner, args.ticketId, null)
    if (found.error) return found.error
    const note = typeof args.note === 'string' ? args.note.trim() : ''
    const expected = revisionOf(args.expectedRevision)
    const cancelled = await store.write('work', () => book.markCancelled(found.ticket.id, expected, note))
    if (cancelled.error) return toolError(cancelled.error, cancelled.message ?? 'Cancel failed.')
    const child = cancelled.ticket.child_session_id
    if (child) closeBudgetWait(child)
    if (resident && child && options.cancel) {
      await options.cancel(child, { keepInbox: note !== '', reason: 'ticket-cancel' })
    }
    if (resident && note !== '' && cancelled.input) await pushInput(book, cancelled.input, deps)
    await removeUnclaimed(owner, cancelled.ticket.id)
    schedulePromote()
    return {
      ok: true,
      ticketId: cancelled.ticket.id,
      ticketStatus: cancelled.ticket.status,
      already: cancelled.already === true,
    }
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function grant(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot grant more budget.')
    const found = resolveTicket(owner, args.ticketId, null)
    if (found.error) return found.error
    if (args.deny === true) {
      const failed = await store.write('work', () => book.failRunning(found.ticket.id, 'grant-denied'))
      const child = failed?.child_session_id
      const state = child ? arms.get(child) : null
      if (child) closeBudgetWait(child)
      if (state) {
        state.closing = true
        state.clear?.()
      }
      if (resident && child && options.cancel) await options.cancel(child, { keepInbox: false, reason: 'grant-denied' })
      schedulePromote()
      return { ok: true, ticketId: found.ticket.id, ticketStatus: 'failed', denied: true }
    }
    const live = found.ticket.child_session_id ? arms.get(found.ticket.child_session_id) : null
    if (live?.role === 'worker') saveQuota(found.ticket.child_session_id, live)
    const added = await store.write('work', () =>
      book.extendBudget(
        found.ticket.id,
        {
          wallMs: typeof args.wallMs === 'number' ? args.wallMs : undefined,
          maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        },
        { wallMs: limits.workerWallMs, maxTokens: limits.workerMaxTokens },
      ),
    )
    if (added.error)
      return { ...toolError(added.error, added.message ?? 'No budget was added.'), ...quotaFeedback(found.ticket.id) }
    const child = added.ticket.child_session_id
    if (child) releaseArm(child, added.budget)
    let resumedInput = null
    const quota = quotaOf(added.ticket.id)
    if (
      child &&
      !arms.has(child) &&
      quota?.waiting &&
      options.resumePaused &&
      resident &&
      options.push &&
      ['started', 'enqueued'].includes(added.ticket.status) &&
      added.budget.maxTokens > quota.tokens &&
      added.budget.wallMs > quota.activeMs &&
      quota.tokens < limits.workerMaxTokens &&
      quota.activeMs < limits.workerWallMs &&
      !(await isChildLive(child))
    ) {
      resumedInput = await store.write('work', () => {
        const fresh = book.ticket(added.ticket.id)
        if (
          !fresh ||
          !['started', 'enqueued'].includes(fresh.status) ||
          fresh.active_attempt_id !== added.ticket.active_attempt_id
        )
          return null
        const current = quotaOf(fresh.id)
        if (!current?.waiting) return null
        if (current.resumeInputId) return book.input(current.resumeInputId)
        // A detached native turn ended (possibly disposed). Advance only the
        // input generation, not the attempt/fence/session, so replay of that
        // old turn/end cannot finalize a new pending result.
        store.db
          .prepare(
            'UPDATE work_tickets SET revision = revision + 1, briefing_revision = briefing_revision + 1, updated_at = ? WHERE id = ?',
          )
          .run(now().toISOString(), fresh.id)
        const input = book.insertInput({
          ticketId: fresh.id,
          attemptId: fresh.active_attempt_id,
          revision: fresh.briefing_revision + 1,
          kind: 'supply',
          text: '[foundations:budget-resume] Budget was explicitly granted. Continue the SAME ticket from durable history; do not repeat completed effects. Inspect current state before continuing. This is a new host turn after detachment, not a new task.',
        })
        writeQuota(fresh.id, { ...current, resumeInputId: input.id })
        return input
      })
      if (resumedInput) await pushInput(book, resumedInput, deps)
    }
    return {
      ok: true,
      ticketId: added.ticket.id,
      ticketStatus: book.ticket(added.ticket.id)?.status ?? added.ticket.status,
      briefingRevision: book.ticket(added.ticket.id)?.briefing_revision,
      wallMs: added.budget.wallMs,
      maxTokens: added.budget.maxTokens,
      hostCeilingTokens: limits.workerMaxTokens,
      hostCeilingWallMs: limits.workerWallMs,
      ...quotaFeedback(added.ticket.id),
      continuation: resumedInput
        ? 'same-session-new-turn'
        : child && arms.has(child)
          ? 'same-turn'
          : 'awaiting-host-turn',
    }
  }

  async function retry(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot retry a ticket.')
    const found = resolveTicket(owner, args.ticketId, ['failed', 'cancelled'])
    if (found.error) return found.error
    const expected = revisionOf(args.expectedRevision)
    const retried = await store.write('work', () => {
      const result = book.insertRetry(found.ticket.id, expected)
      if (result.error) return result
      if (!hasSlot(owner)) return { ...result, queued: true }
      book.reserveSlot(result.ticket.id)
      return result
    })
    if (retried.error) return toolError(retried.error, retried.message ?? 'Retry failed.')
    if (retried.queued) {
      return publicDispatch(book.ticket(retried.ticket.id), {
        flush: 'pending',
        queued: true,
        nativeMessageId: retried.input?.native_message_id ?? null,
      })
    }
    if (!resident)
      return { ...publicDispatch(retried.ticket), flush: 'pending', message: 'Only a resident host continues' }
    return startReserved(book.ticket(retried.ticket.id))
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function publish(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot publish.')
    const resultEventId = args.resultEventId
    if (typeof resultEventId !== 'string' || resultEventId === '')
      return toolError('VALIDATION', 'resultEventId is required.')
    const text = args.text
    if (typeof text !== 'string' || text.trim() === '' || text.length > 16000)
      return toolError('VALIDATION', 'text is empty or too long.')
    const turn = args.turn == null ? null : String(args.turn)
    const saved = await store.write('work', () => {
      const event = book.event(resultEventId)
      if (!event) return toolError('NOT_FOUND', 'No such result.')
      const ticket = book.ticket(event.ticket_id)
      if (!ticket || ticket.owner_session_id !== owner)
        return toolError('FORBIDDEN', 'This result does not belong to this session.')
      if (ticket.review_status === 'rejected') return toolError('REJECTED', 'This candidate was already rejected.')
      if (event.kind !== 'result' || event.apply_status !== 'applied')
        return toolError('VALIDATION', 'The result has not finished reconciliation.')
      if (event.briefing_revision !== ticket.briefing_revision)
        return toolError('VALIDATION', 'The result generation is stale.')
      const attempt = book.attempt(ticket.active_attempt_id)
      if (!attempt || attempt.id !== event.attempt_id || attempt.fencing_token !== event.fencing_token) {
        return toolError('VALIDATION', 'The result execution generation has changed.')
      }
      if (ticket.status === 'cancelled' || ticket.status === 'failed')
        return toolError('VALIDATION', 'This ticket can no longer be published.')
      const delivery = book.insertDelivery({
        ticketId: ticket.id,
        eventId: event.event_id,
        owner,
        attemptId: attempt.id,
        fencingToken: attempt.fencing_token,
        briefingRevision: event.briefing_revision,
        text,
        turn,
      })
      return {
        ok: true,
        publishId: delivery.row.publish_id,
        already: delivery.already,
        text,
        status: delivery.row.status,
        ticketId: ticket.id,
      }
    })
    return saved
  }

  /**
   * @param {string} owner
   * @param {Record<string, unknown>} args
   */
  async function reject(owner: string, args: Record<string, unknown>) {
    if (!engine.isBot(owner)) return toolError('FORBIDDEN', 'An ordinary session cannot reject a candidate.')
    const resultEventId = args.resultEventId
    if (typeof resultEventId !== 'string' || resultEventId === '')
      return toolError('VALIDATION', 'resultEventId is required.')
    return store.write('work', () => {
      const event = book.event(resultEventId)
      if (!event) return toolError('NOT_FOUND', 'No such result.')
      const ticket = book.ticket(event.ticket_id)
      if (!ticket || ticket.owner_session_id !== owner)
        return toolError('FORBIDDEN', 'This result does not belong to this session.')
      if (event.kind !== 'result' || event.apply_status !== 'applied')
        return toolError('VALIDATION', 'There is no candidate to reject yet.')
      book.setReview(ticket.id, 'rejected')
      store.db
        .prepare(`
        UPDATE user_deliveries SET status = 'abandoned'
        WHERE result_event_id = ? AND status = 'intent'
      `)
        .run(event.event_id)
      return { ok: true, reviewStatus: 'rejected', ticketId: ticket.id }
    })
  }

  /**
   * @param {string} sessionId child session
   * @param {Record<string, unknown>} args
   */
  async function report(sessionId: string, args: Record<string, unknown>) {
    const kind = typeof args.kind === 'string' ? args.kind : ''
    if (!KINDS.has(kind))
      return toolError('VALIDATION', 'kind must be progress, question, artifact, result, or failure.')
    const text = typeof args.text === 'string' ? args.text : ''
    if (text.trim() === '' || text.length > 16000) return toolError('VALIDATION', 'text is empty or too long.')
    const attempt = book.attemptForChild(sessionId)
    if (!attempt) return toolError('FORBIDDEN', 'This session is not a worker, so it cannot report.')
    const bound = turns.get(sessionId)
    if (!bound) return toolError('NOT_FOUND', 'This round has no matching briefing.')
    const input = book.inputByNative(bound.messageId)
    if (!input || input.attempt_id !== attempt.id) return toolError('NOT_FOUND', 'This round has no matching briefing.')
    const ticket = book.ticket(input.ticket_id)
    if (!ticket) return toolError('NOT_FOUND', 'The ticket does not exist.')
    const current =
      ticket.active_attempt_id === attempt.id &&
      ticket.briefing_revision === input.briefing_revision &&
      ticket.status !== 'cancelled' &&
      ticket.status !== 'failed' &&
      ticket.status !== 'delivered'
    const applyStatus =
      current && (kind === 'progress' || kind === 'artifact') ? 'applied' : current ? 'pending_completion' : 'stale'
    const saved = await store.write('work', () =>
      book.insertEvent({
        ticketId: ticket.id,
        attemptId: attempt.id,
        fencingToken: attempt.fencing_token,
        briefingRevision: input.briefing_revision,
        kind,
        text,
        applyStatus,
      }),
    )
    if (saved.duplicate || !saved.event) return toolError('REPLAY', 'This event was already written.')
    const until = new Date(now().getTime() + limits.leaseMs).toISOString()
    book.touchLease(attempt.id, until, typeof bound.seq === 'number' ? bound.seq : null)
    return {
      ok: true,
      eventId: saved.event.event_id,
      applyStatus: saved.event.apply_status,
      kind,
    }
  }

  async function tick() {
    await reconcileInputs(book, deps)
    await reconcileNotices(book, deps)
    await renewLiveLeases()
    const expired = await store.write('work', () => book.expireQuiet())
    await stopExpiredChildren(expired)
    for (const owner of book.ownerIds()) {
      if (engine.isBot(owner)) await admit(owner)
    }
    for (const child of book.childIds()) await reconcileChild(child)
    for (const owner of book.ownerIds()) await reconcileOwner(owner)
    await promoteQueued()
  }

  /**
   * Renew the lease of a started worker that is still alive, so a silent
   * model or tool turn longer than leaseMs does not false-expire it.
   */
  async function renewLiveLeases() {
    const renewals: string[] = []
    for (const child of book.childIds()) {
      const attempt = book.attemptForChild(child)
      if (!attempt || (attempt.status !== 'started' && attempt.status !== 'enqueued')) continue
      if (!(await isChildLive(child))) continue
      renewals.push(attempt.id)
    }
    if (renewals.length === 0) return
    await store.write('work', () => {
      const until = new Date(now().getTime() + limits.leaseMs).toISOString()
      for (const id of renewals) {
        const attempt = book.attempt(id)
        if (!attempt || (attempt.status !== 'started' && attempt.status !== 'enqueued')) continue
        book.touchLease(id, until, typeof attempt.lease_observed_seq === 'number' ? attempt.lease_observed_seq : null)
      }
    })
  }

  /**
   * @param {string} sessionId
   */
  async function isChildLive(sessionId: string) {
    if (options.childPresent) {
      try {
        if (!(await options.childPresent(sessionId))) return false
      } catch {
        return false
      }
    } else if (!options.snapshot) {
      return false
    }
    if (!options.snapshot) return true
    try {
      const events = await options.snapshot(sessionId)
      return !latestTurnEnded(events)
    } catch {
      return false
    }
  }

  /**
   * @param {Array<{ ticketId: string, reason: string, childSessionId?: string | null }>} expired
   */
  async function stopExpiredChildren(
    expired: Array<{ ticketId: string; reason: string; childSessionId?: string | null }>,
  ) {
    if (!Array.isArray(expired) || expired.length === 0) return
    for (const item of expired) {
      const child = item.childSessionId
      if (!child || !options.cancel) continue
      const state = arms.get(child)
      if (state) {
        state.closing = true
        state.clear?.()
      }
      try {
        await options.cancel(child, { keepInbox: false, reason: `worker-expire:${item.reason}` })
      } catch {
        /* best-effort stop; the ledger already failed the ticket */
      }
    }
  }

  /**
   * @param {Record<string, any>} event
   */
  function eventText(event: Record<string, any>) {
    if (typeof event.text === 'string' && event.text !== '') return event.text
    return book.detail(event.ticket_id)?.events?.find(item => item.event_id === event.event_id)?.text ?? ''
  }

  /**
   * @param {Record<string, any>} event
   */
  function isExtensionAsk(event: Record<string, any>) {
    return event.kind === 'progress' && eventText(event).startsWith('[foundations:extension]')
  }

  /**
   * Extension asks are decision-required: they may starve-bypass notice-open,
   * user-pending, and delivery-open. Ordinary progress does not.
   * @param {Record<string, any>} event
   */
  function isDecisionRequiredEvent(event: Record<string, any>) {
    return event.kind === 'question' || event.kind === 'result' || event.kind === 'failure' || isExtensionAsk(event)
  }

  /**
   * @param {Record<string, any>} ticket
   */
  function isFinishedTicket(ticket: Record<string, any>) {
    const status = String(ticket.status)
    return status === 'failed' || status === 'cancelled' || status === 'delivered'
  }

  /**
   * @param {string} owner
   */
  async function admit(owner: string) {
    if (admitting.has(owner)) return { admitted: false, reason: 'admission-inflight' }
    admitting.add(owner)
    try {
      return await admitOnce(owner)
    } finally {
      admitting.delete(owner)
    }
  }
  function currentExtension(event: Record<string, any>) {
    const ticket = book.ticket(event.ticket_id)
    if (!ticket || !['started', 'enqueued'].includes(ticket.status)) return false
    const budget = JSON.parse(ticket.budget_json)
    if (budget.extension !== 'open') return false
    const latest = book.detail(ticket.id)?.events.filter(isExtensionAsk).at(-1)
    return latest?.event_id === event.event_id
  }
  async function admitOnce(owner: string) {
    const wake = book.pendingWake(owner)
    if (wake.events.length === 0 && wake.cancels.length === 0) return { admitted: false, reason: 'empty' }
    let pending = null
    try {
      pending = options.pendingIds ? await options.pendingIds(owner) : null
    } catch {
      pending = null
    }
    const terminalTimes = []
    for (const event of wake.events) {
      if (
        event.apply_status === 'applied' &&
        isDecisionRequiredEvent(event) &&
        (!isExtensionAsk(event) || currentExtension(event))
      ) {
        terminalTimes.push(Date.parse(event.created_at))
      }
    }
    for (const ticket of wake.cancels) terminalTimes.push(Date.parse(ticket.updated_at))
    const urgent = wake.events.filter(event => isExtensionAsk(event) && currentExtension(event))
    const heldUntil = holds.get(owner)
    if (!urgent.length && heldUntil != null && now().getTime() < heldUntil)
      return { admitted: false, reason: 'interrupt-hold' }
    if (heldUntil != null) holds.delete(owner)
    const decision = decideAdmission({
      pendingIds: pending,
      backgroundIds: book.backgroundIds(owner),
      noticeOpen: book.openNotice(owner),
      deliveryOpen: book.openDelivery(owner),
      lastNoticeAt: book.latestNoticeAt(owner),
      nowMs: now().getTime(),
      mergeWindowMs: limits.mergeWindowMs,
      terminalSince: terminalTimes.length === 0 ? null : Math.min(...terminalTimes),
      starveMs: limits.starveMs,
    })
    if (!urgent.length && !decision.admit) return { admitted: false, ...decision }
    const nativeId = randomUUID()
    const items: Array<{ ticketId: string; eventId: string; line: string }> = []
    for (const event of urgent.length ? urgent : wake.events) {
      const ticket = book.ticket(event.ticket_id)
      if (!ticket) continue
      // A grant cannot revive a finished ticket, so drop a stale extension ask.
      if (isExtensionAsk(event) && !currentExtension(event)) continue
      items.push({
        ticketId: ticket.id,
        eventId: event.event_id,
        line: noticeLine(ticket, event),
      })
    }
    for (const ticket of urgent.length ? [] : wake.cancels) {
      items.push({
        ticketId: ticket.id,
        eventId: `cancel:${ticket.cancel_requested_revision}`,
        line: `${ticket.id} cancelled rev ${ticket.briefing_revision}`,
      })
    }
    if (items.length === 0) return { admitted: false, reason: 'empty' }
    await store.write('work', () => {
      // Revalidate after the write queue: a grant/cancel may have raced admission.
      const valid = items.filter(
        item =>
          item.eventId.startsWith('cancel:') ||
          (!book.event(item.eventId)?.notice_id &&
            (!isExtensionAsk(book.event(item.eventId) ?? {}) || currentExtension(book.event(item.eventId)!))),
      )
      items.splice(0, items.length, ...valid)
      if (items.length) book.insertNotices(nativeId, owner, items)
    })
    if (!items.length) return { admitted: false, reason: 'superseded' }
    const flushed = await pushNotice(book, nativeId, owner, renderNotice(items.map(item => item.line)), 0, deps)
    return {
      ...decision,
      admitted: true,
      reason: urgent.length ? 'budget-decision' : decision.reason,
      nativeMessageId: nativeId,
      flush: flushWord(flushed),
    }
  }

  /**
   * Progress stays a status line. Result and failure carry the body so the
   * main bot writes the user-visible reply instead of leaving it on the card.
   * @param {Record<string, any>} ticket
   * @param {Record<string, any>} event
   */
  function noticeLine(ticket: Record<string, any>, event: Record<string, any>) {
    const status = String(ticket.status)
    const head = `${ticket.id} ${status} (${LABEL[status] ?? status}) rev ${ticket.briefing_revision} ${event.kind}`
    const text = book.detail(ticket.id)?.events?.find(item => item.event_id === event.event_id)?.text ?? ''
    if (text.startsWith('[foundations:extension]')) {
      if (isFinishedTicket(ticket)) return head
      return [head, `eventId: ${event.event_id}`, text].join('\n')
    }
    if (event.kind !== 'result' && event.kind !== 'failure') return head
    const body = text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text
    const ask =
      event.kind === 'result'
        ? 'This is a successful result. Call foundations_publish now. Use the eventId below as resultEventId and the words you want the user to see as text. After the tool returns, write that same text as the reply to the user. Do not only restate the status, and do not ask the user to paste the body back.'
        : 'This is a failed result. Now tell the user the reason and the next step in your own words. Do not only restate the status, and do not ask the user to paste the body back.'
    return [head, `eventId: ${event.event_id}`, ask, '---', body].join('\n')
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, any>} event
   */
  function observeSession(sessionId: string, event: Record<string, any>) {
    if (!event || typeof event.type !== 'string') return
    noteBudget(sessionId, event)
    const nativeId = messageIdOf(event)
    if (
      (event.type === 'user/message' || event.type === 'agent/inbox/claimed') &&
      nativeId &&
      book.inputByNative(nativeId)
    ) {
      turns.set(sessionId, {
        messageId: nativeId,
        turn: event.data?.turn ?? null,
        seq: typeof event.seq === 'number' ? event.seq : null,
      })
    }
    if (event.type === 'user/message' && engine.isBot(sessionId)) holds.delete(sessionId)
    if (event.type === 'user/message' && nativeId) {
      const input = book.inputByNative(nativeId)
      if (input) {
        book.markStarted(input.ticket_id, nativeId)
        const attempt = book.attempt(input.attempt_id)
        if (attempt)
          book.touchLease(
            attempt.id,
            new Date(now().getTime() + limits.leaseMs).toISOString(),
            typeof event.seq === 'number' ? event.seq : null,
          )
      }
      if (engine.isBot(sessionId) && book.noticeIds(sessionId).has(nativeId)) {
        book.setNoticeObserve(nativeId, 'started')
        if (event.data?.turn != null) wakeTurns.set(`${sessionId}:${event.data.turn}`, nativeId)
      }
    }
    if (event.type === 'turn/end') {
      if (isWorkerSession(sessionId) && event.data?.reason?.reason?.kind === 'user') {
        const attempt = book.attemptForChild(sessionId)
        if (attempt) book.markCancelled(attempt.ticket_id, null, 'Worker cancelled by user.')
        closeBudgetWait(sessionId)
      }
      applyTurnEnd(sessionId, event.data?.turn ?? null, reasonKindOf(event))
    }
    if (isWorkerSession(sessionId) && typeof event.seq === 'number') {
      const attempt = book.attemptForChild(sessionId)
      if (attempt && (attempt.status === 'started' || attempt.status === 'enqueued')) {
        book.touchLease(attempt.id, new Date(now().getTime() + limits.leaseMs).toISOString(), event.seq)
      }
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} messageId
   * @param {number | null} turn
   */
  function observeClaimed(sessionId: string, messageId: string, turn: number | null) {
    if (book.inputByNative(messageId)) turns.set(sessionId, { messageId, turn, seq: null })
    book.setNoticeObserve(messageId, 'claimed')
    if (turn != null && book.noticeIds(sessionId).has(messageId)) wakeTurns.set(`${sessionId}:${turn}`, messageId)
  }

  /**
   * @param {Record<string, any>} ticket
   */
  async function ensureChild(ticket: Record<string, any>) {
    if (ticket.child_session_id) return { ticket }
    if (!options.createChild) return { error: publicDispatch(ticket, { flush: 'pending' }) }
    const sessionId = `worker-${ticket.id}`
    const attemptId = ticket.active_attempt_id
    const fencingToken = book.attempt(attemptId)?.fencing_token ?? 1
    try {
      const created = await options.createChild({
        sessionId,
        ownerSessionId: ticket.owner_session_id,
        ticketId: ticket.id,
        fencingToken,
      })
      const child = typeof created === 'string' && created !== '' ? created : sessionId
      const saved = await store.write('work', () => book.setChildIfEmpty(ticket.id, child, { attemptId, fencingToken }))
      if (!saved?.attached) {
        try {
          if (options.cancel) await options.cancel(child, { keepInbox: false, reason: 'stale-start' })
        } catch {
          /* best-effort cleanup of a late or fenced child */
        }
        return { rejected: true, ticket: saved?.ticket ?? book.ticket(ticket.id) ?? ticket }
      }
      engine.ensureSession(child)
      return { ticket: saved.ticket }
    } catch {
      return {
        error: publicDispatch(book.ticket(ticket.id), {
          flush: 'pending',
          childSessionId: null,
          nativeMessageId: null,
        }),
      }
    }
  }

  /**
   * @param {string} owner
   * @param {unknown} ticketId
   * @param {string[] | null} statuses
   */
  function resolveTicket(owner: string, ticketId: unknown, statuses: string[] | null) {
    if (typeof ticketId === 'string' && ticketId !== '') {
      const ticket = book.ticket(ticketId)
      if (!ticket || ticket.owner_session_id !== owner) return { error: toolError('NOT_FOUND', 'No such ticket.') }
      return { ticket }
    }
    const rows = store.db
      .prepare(`
      SELECT * FROM work_tickets WHERE owner_session_id = ?
      ${statuses ? `AND status IN (${statuses.map(() => '?').join(',')})` : ''}
      ORDER BY updated_at DESC
    `)
      .all(owner, ...(statuses ?? []))
    if (rows.length !== 1) return { error: toolError('VALIDATION', 'Name the ticket.') }
    return { ticket: rows[0] }
  }

  /**
   * @param {unknown} value
   */
  function revisionOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null
  }

  /**
   * @param {string} owner
   * @param {unknown} value
   */
  function correlationOf(owner: string, value: unknown) {
    if (typeof value !== 'string' || value === '') return ''
    const found = store.db
      .prepare(`
      SELECT 1 AS ok FROM deliveries WHERE id = ? AND (sender_session_id = ? OR target_session_id = ?)
    `)
      .get(value, owner, owner)
    return found ? value : ''
  }

  /**
   * @param {Record<string, any>} ticket
   * @param {{ replayed?: boolean, flush?: string, nativeMessageId?: string | null, childSessionId?: string | null }} [extra]
   */
  function publicDispatch(
    ticket: Record<string, any>,
    extra: {
      replayed?: boolean
      flush?: string
      nativeMessageId?: string | null
      childSessionId?: string | null
      queued?: boolean
    } = {},
  ) {
    const fresh = book.ticket(ticket.id) ?? ticket
    const attempt = fresh.active_attempt_id ? book.attempt(fresh.active_attempt_id) : null
    const input = attempt ? book.currentInput(attempt) : null
    const flush =
      extra.flush ??
      (input?.flush_status === 'accepted'
        ? 'accepted'
        : input?.flush_status === 'ambiguous' || input?.flush_status === 'flushing'
          ? 'ambiguous'
          : 'pending')
    const dispatched =
      flush === 'accepted' || (fresh.status !== 'accepted' && fresh.status !== 'failed' && fresh.status !== 'cancelled')
    return {
      ok: true,
      ticketId: fresh.id,
      attemptId: attempt?.id ?? fresh.active_attempt_id,
      briefingRevision: fresh.briefing_revision,
      status: dispatched && flush === 'accepted' ? 'enqueued' : 'accepted',
      ticketStatus: fresh.status,
      ...quotaFeedback(fresh.id),
      childSessionId: extra.childSessionId === null ? null : fresh.child_session_id,
      fencingToken: attempt?.fencing_token ?? null,
      nativeMessageId: extra.nativeMessageId === undefined ? (input?.native_message_id ?? null) : extra.nativeMessageId,
      flush,
      replayed: extra.replayed === true,
      queued: extra.queued === true || (fresh.status === 'accepted' && !book.slotHeld(fresh)),
    }
  }

  function project(ticket: Record<string, any>) {
    return publicDispatch(ticket)
  }

  /**
   * @param {{ status?: string }} flushed
   */
  function flushWord(flushed: { status?: string }) {
    if (flushed?.status === 'accepted') return 'accepted'
    if (flushed?.status === 'ambiguous') return 'ambiguous'
    return 'pending'
  }

  /**
   * @param {string} sessionId
   * @param {number | null} turn
   * @param {string} reason
   */
  function applyTurnEnd(sessionId: string, turn: number | null, reason: string) {
    const bound = turns.get(sessionId)
    if (engine.isBot(sessionId) && turn != null) {
      const nativeId = wakeTurns.get(`${sessionId}:${turn}`)
      if (nativeId) book.setNoticeObserve(nativeId, 'completed')
    }
    clearBudget(sessionId)
    if (!bound) return
    if (turn != null && bound.turn != null && bound.turn !== turn) return
    const input = book.inputByNative(bound.messageId)
    if (!input) return
    const found = book.detail(input.ticket_id)
    if (!found) return
    let released = false
    for (const event of found.events) {
      if (event.attempt_id !== input.attempt_id) continue
      if (event.briefing_revision !== input.briefing_revision) continue
      if (event.apply_status !== 'pending_completion') continue
      book.applyTerminal(event.event_id, reason)
      released = true
    }
    if (released) void promoteQueued().catch(() => {})
  }

  /**
   * @param {string} sessionId
   */
  async function reconcileChild(sessionId: string) {
    if (!options.snapshot) return
    const events = await options.snapshot(sessionId)
    /** @type {Map<number, string>} */
    const byTurn: Map<number, string> = new Map()
    for (const event of events) {
      const nativeId = messageIdOf(event)
      if (event.type === 'user/message' && nativeId && book.inputByNative(nativeId)) {
        const input = book.inputByNative(nativeId)
        book.markStarted(input.ticket_id, nativeId)
        turns.set(sessionId, {
          messageId: nativeId,
          turn: event.data?.turn ?? null,
          seq: typeof event.seq === 'number' ? event.seq : null,
        })
        if (event.data?.turn != null) byTurn.set(event.data.turn, nativeId)
      }
    }
    for (const event of events) {
      if (event.type !== 'turn/end') continue
      const nativeId = byTurn.get(event.data?.turn)
      if (!nativeId) continue
      // Historical turn endings must not overwrite the latest live input binding.
      const input = book.inputByNative(nativeId)
      if (!input) continue
      const found = book.detail(input.ticket_id)
      for (const item of found?.events ?? []) {
        if (item.apply_status === 'pending_completion' && item.briefing_revision === input.briefing_revision) {
          book.applyTerminal(item.event_id, reasonKindOf(event))
        }
      }
    }
  }

  /**
   * @param {string} owner
   */
  async function reconcileOwner(owner: string) {
    if (!options.snapshot) return
    const events = await options.snapshot(owner)
    const notices = book.noticeIds(owner)
    /** @type {string | null} */
    let waiting: string | null = null
    for (const event of events) {
      const name = event.data?.name ?? event.data?.toolName
      const args = parseArgs(event.data?.arguments ?? event.data?.args ?? event.data?.result)
      if (
        (event.type === 'tool/call' || event.type === 'tool/result') &&
        name === 'foundations_publish' &&
        typeof args?.resultEventId === 'string'
      ) {
        waiting = args.resultEventId
      }
      if (event.type === 'user/message' && notices.has(messageIdOf(event))) continue
      if (event.type === 'assistant/message' && waiting && typeof event.seq === 'number') {
        const ticketRows = book.ownerIds().includes(owner)
          ? store.db
              .prepare(`
          SELECT * FROM user_deliveries WHERE owner_session_id = ? AND result_event_id = ? AND status = 'intent'
        `)
              .get(owner, waiting)
          : null
        if (ticketRows) book.bindDelivery(ticketRows.publish_id, event.seq)
        waiting = null
      }
    }
  }

  /**
   * @param {string} nativeId
   */
  function noticeText(nativeId: string) {
    const rows = store.db.prepare(`SELECT * FROM work_notices WHERE native_message_id = ?`).all(nativeId)
    const lines = rows.map(row => {
      const ticket = book.ticket(row.ticket_id)
      return `${row.ticket_id} ${ticket?.status ?? ''} rev ${ticket?.briefing_revision ?? ''} ${row.event_id}`
    })
    return renderNotice(lines)
  }

  /**
   * @param {string} owner
   * @param {string} ticketId
   */
  async function removeUnclaimed(owner: string, ticketId: string) {
    const rows = store.db
      .prepare(`SELECT * FROM work_notices WHERE ticket_id = ? AND observe_status = 'none'`)
      .all(ticketId)
    const seen = new Set()
    for (const row of rows) {
      if (seen.has(row.native_message_id)) continue
      seen.add(row.native_message_id)
      if (row.flush_status === 'accepted' && options.remove) {
        await options.remove(owner, row.native_message_id)
      } else if (row.flush_status !== 'accepted') {
        book.markNoticeGroup(row.native_message_id, 'dead', row.flush_pid ?? null, 'cancelled', null, false)
      }
    }
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, any>} event
   */
  function noteBudget(sessionId: string, event: Record<string, any>) {
    const role = budgetRole(sessionId)
    if (!role) return
    if (role === 'main' && (event.type === 'tool/call' || event.type === 'tool/result')) {
      const name = event.data?.name ?? event.data?.toolName
      if (
        name === 'foundations_dispatch' ||
        (typeof name === 'string' && name !== '' && !name.startsWith('foundations_'))
      ) {
        tightenMain(sessionId)
      }
    }
    if (event.type === 'turn/start') {
      arm(sessionId, event.data?.turn ?? 0, role)
      return
    }
    const state = arms.get(sessionId)
    if (
      role === 'main' &&
      state &&
      (event.type === 'user/message' || event.type === 'agent/inbox/claimed') &&
      (messageIdOf(event) ?? '').startsWith(BUDGET_NOTICE_PREFIX)
    ) {
      state.budgetNotice = true
      return
    }
    if (event.type === 'assistant/message' && role === 'worker' && state) {
      const seq = typeof event.seq === 'number' ? event.seq : null
      if (seq != null && state.lastSeq != null && seq <= state.lastSeq) return
      const total = event.data?.usage?.totalTokens
      if (typeof total === 'number' && total > 0) {
        state.tokens += total
        if (seq != null) state.lastSeq = seq
        saveQuota(sessionId, state)
        consider(sessionId, state, false)
      }
      return
    }
    if (event.type !== 'step/end') return
    const live = state ?? arm(sessionId, event.data?.turn ?? 0, role)
    const step = Number(event.data?.step)
    live.steps = Number.isFinite(step) ? Math.max(live.steps, step) : live.steps + 1
    // The main step cap is enforced in gateStep (agent/pre-step), before the next
    // step starts. Cancelling here would abort a turn whose last step already
    // ended naturally and record it as aborted.
  }

  /**
   * `agent/pre-step` gate for a bot main session. Refuses the next step once the
   * turn has used its step or wall budget. A turn whose last step ended without
   * a tool call never reaches this gate, so it still ends `completed`.
   * Messages claimed for this step (a user steer) always enter: dropping them on
   * a refusal would lose user input.
   * @param {string} sessionId
   * @param {{ turn?: number, step?: number, claimed?: number }} position
   */
  function gateStep(
    sessionId: string,
    position: { turn?: number; step?: number; claimed?: number } = {},
  ): { kind: 'enter' } | { kind: 'reject'; trip: MainBudgetTrip } {
    if (budgetRole(sessionId) !== 'main') return { kind: 'enter' }
    const state = arms.get(sessionId)
    if (!state || state.role !== 'main' || state.closing) return { kind: 'enter' }
    if ((position.claimed ?? 0) > 0) return { kind: 'enter' }
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    const reason = budgetTrip({
      steps: state.steps,
      elapsedMs: elapsed,
      maxSteps: state.limits.maxSteps,
      wallMs: state.limits.wallMs,
    })
    if (reason !== 'steps' && reason !== 'wall') return { kind: 'enter' }
    const trip = tripMain(sessionId, state, reason, elapsed, 'pre-step')
    return { kind: 'reject', trip }
  }

  /**
   * Record, log, and announce one main-session budget trip.
   * @param {string} sessionId
   * @param {BudgetArm} state
   * @param {'steps' | 'wall'} reason
   * @param {number} elapsed
   * @param {'pre-step' | 'timer'} via
   */
  function tripMain(
    sessionId: string,
    state: BudgetArm,
    reason: 'steps' | 'wall',
    elapsed: number,
    via: 'pre-step' | 'timer',
  ): MainBudgetTrip {
    const trip: MainBudgetTrip = {
      reason,
      cause: `main-budget:${reason}`,
      turn: state.turn,
      steps: state.steps,
      elapsedMs: elapsed,
      maxSteps: state.limits.maxSteps,
      wallMs: state.limits.wallMs,
      via,
      notify: !state.budgetNotice,
    }
    if (state.tripped) return { ...trip, notify: false }
    state.tripped = true
    options.log?.(
      'warn',
      `session-foundations: main budget ${trip.cause} session=${sessionId} turn=${trip.turn} steps=${trip.steps}/${trip.maxSteps} elapsedMs=${trip.elapsedMs}/${trip.wallMs} via=${via}`,
      { sessionId, ...trip },
    )
    if (trip.notify) {
      try {
        options.onMainBudget?.(sessionId, trip)
      } catch {
        /* the notice is best effort; the log line above stays */
      }
    }
    return trip
  }

  /**
   * @param {string} sessionId
   */
  function budgetRole(sessionId: string) {
    if (book.attemptForChild(sessionId)) return 'worker'
    if (engine.isBot(sessionId)) return 'main'
    return null
  }

  /**
   * Keep ticket notices out of the inbox until the interrupting user message
   * arrives, or until the hold expires.
   * @param {string} sessionId
   */
  function holdNotices(sessionId: string) {
    if (!engine.isBot(sessionId)) return toolError('FORBIDDEN', 'Only a bot main session holds ticket notices.')
    const until = now().getTime() + limits.holdMs
    holds.set(sessionId, until)
    return { ok: true, until }
  }

  /**
   * @param {string} sessionId
   */
  function releaseHold(sessionId: string) {
    holds.delete(sessionId)
    return { ok: true }
  }

  /**
   * A dispatch or a host tool moves the turn onto the `main*` cap. The cap can
   * only tighten: with the defaults (main == chat) this changes nothing.
   * @param {string} sessionId
   */
  function tightenMain(sessionId: string) {
    const state = arms.get(sessionId)
    if (!state || state.role !== 'main' || state.tight || state.closing || state.tripped) return
    state.tight = true
    const maxSteps = Math.min(state.limits.maxSteps, limits.mainMaxSteps)
    const wallMs = Math.min(state.limits.wallMs, limits.mainWallMs)
    if (maxSteps === state.limits.maxSteps && wallMs === state.limits.wallMs) return
    state.limits = {
      ...state.limits,
      maxSteps,
      wallMs,
      ceilingWall: wallMs,
    }
    state.clear?.()
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    state.clear = schedule(
      () => {
        const live = arms.get(sessionId)
        if (!live || live !== state || live.closing) return
        consider(sessionId, live, true)
      },
      Math.max(1, state.limits.wallMs - elapsed),
    )
    consider(sessionId, state, false)
  }

  /**
   * @param {string} sessionId
   * @param {number} turn
   * @param {'main' | 'worker'} role
   */
  function arm(sessionId: string, turn: number, role: 'main' | 'worker') {
    const previous = arms.get(sessionId)
    clearBudget(sessionId)
    const caps =
      role === 'main'
        ? {
            maxSteps: limits.chatMaxSteps,
            wallMs: limits.chatWallMs,
            maxTokens: Number.POSITIVE_INFINITY,
            ceilingWall: limits.chatWallMs,
            ceilingTokens: Number.POSITIVE_INFINITY,
            extensionOpen: false,
          }
        : workerCaps(sessionId)
    const state = {
      attemptId: role === 'worker' ? (book.attemptForChild(sessionId)?.id ?? null) : null,
      turn,
      startedAt: role === 'worker' ? now().getTime() : (previous?.startedAt ?? now().getTime()),
      steps: 0,
      tokens: role === 'worker' ? 0 : (previous?.tokens ?? 0),
      lastSeq: role === 'worker' ? null : (previous?.lastSeq ?? null),
      role,
      tight: false,
      limits: caps,
      tripped: false,
      budgetNotice: false,
      extensionOpen: false,
      closing: false,
      pausedAt: null as number | null,
      atBoundary: false,
      clear: () => {},
    }
    if (role === 'worker') {
      const attempt = book.attemptForChild(sessionId)
      const quota = attempt ? quotaOf(attempt.ticket_id) : null
      if (quota) {
        state.tokens = quota.tokens ?? 0
        state.lastSeq = quota.lastSeq ?? null
        const elapsed =
          (quota.activeMs ?? 0) + (quota.runningSince == null ? 0 : Math.max(0, now().getTime() - quota.runningSince))
        state.startedAt = now().getTime() - elapsed
        if (quota.waiting) {
          state.pausedAt = now().getTime()
          state.atBoundary = true
        }
      }
    }
    const elapsed = Math.max(
      0,
      (state.pausedAt != null && state.atBoundary ? state.pausedAt : now().getTime()) - state.startedAt,
    )
    state.extensionOpen = previous?.extensionOpen === true || caps.extensionOpen === true
    const target = caps.wallMs
    if (state.pausedAt == null)
      state.clear = schedule(
        () => {
          const live = arms.get(sessionId)
          if (!live || live !== state || live.closing) return
          consider(sessionId, live, true)
        },
        Math.max(1, target - elapsed),
      )
    arms.set(sessionId, state)
    if (role === 'worker') saveQuota(sessionId, state)
    return state
  }

  /**
   * @param {string} sessionId
   */
  function workerCaps(sessionId: string) {
    const attempt = book.attemptForChild(sessionId)
    const ticket = attempt ? book.ticket(attempt.ticket_id) : null
    let wallMs: number = limits.workerWallMs
    let maxTokens: number = limits.workerMaxTokens
    let extensionOpen = false
    if (ticket) {
      try {
        const parsed = JSON.parse(ticket.budget_json)
        if (Number.isFinite(parsed.wallMs)) wallMs = Math.min(limits.workerWallMs, Math.max(1000, parsed.wallMs))
        if (Number.isFinite(parsed.maxTokens))
          maxTokens = Math.min(limits.workerMaxTokens, Math.max(1000, parsed.maxTokens))
        extensionOpen = parsed.extension === 'open'
      } catch {
        /* host ceiling */
      }
    }
    return {
      maxSteps: Number.POSITIVE_INFINITY,
      wallMs,
      maxTokens,
      ceilingWall: limits.workerWallMs,
      ceilingTokens: limits.workerMaxTokens,
      extensionOpen,
    }
  }

  /**
   * @param {string} sessionId
   * @param {{ steps: number, startedAt: number, limits: { maxSteps: number, wallMs: number }, tripped: boolean, role: 'main' | 'worker' }} state
   * @param {boolean} fromTimer
   */
  function consider(sessionId: string, state: BudgetArm, fromTimer: boolean) {
    if (state.closing) return
    if (state.role === 'main') {
      // Step caps are enforced by gateStep before the next step. Only the wall
      // timer stops a step that is still running; the arm is cleared on
      // turn/end, so a finished turn is never cancelled here.
      if (!fromTimer || state.tripped) return
      const elapsed = Math.max(state.limits.wallMs, now().getTime() - state.startedAt)
      const trip = tripMain(sessionId, state, 'wall', elapsed, 'timer')
      Promise.resolve(options.cancel?.(sessionId, { keepInbox: true, reason: trip.cause })).catch(() => {})
      return
    }
    if (state.pausedAt != null) return
    const elapsed = Math.max(0, now().getTime() - state.startedAt)
    const overWall = fromTimer || elapsed >= state.limits.wallMs
    const overTokens = state.tokens >= state.limits.maxTokens
    if (!overWall && !overTokens) return
    askForQuota(sessionId, state, overTokens ? 'tokens' : 'wall', elapsed)
  }

  /**
   * @param {string} sessionId
   * @param {{ limits: { wallMs: number, maxTokens: number, ceilingWall: number }, tokens: number, startedAt: number, extensionOpen: boolean, closing: boolean, clear: () => void }} state
   * @param {'wall' | 'tokens'} reason
   * @param {number} elapsed
   */
  function askForQuota(sessionId: string, state: BudgetArm, reason: 'wall' | 'tokens', elapsed: number) {
    state.extensionOpen = true
    state.clear?.()
    state.pausedAt = now().getTime()
    state.atBoundary = false
    saveQuota(sessionId, state, reason)
    const attempt = book.attemptForChild(sessionId)
    if (!attempt) return
    const ticket = book.ticket(attempt.ticket_id)
    if (!ticket || ticket.status === 'failed' || ticket.status === 'cancelled' || ticket.status === 'delivered') {
      closeBudgetWait(sessionId)
      return
    }
    const marked = book.markExtensionOpen(ticket.id)
    if (!marked || marked.already) return
    const text = [
      '[foundations:extension]',
      reason === 'tokens' ? 'The token budget is used up.' : 'The runtime is used up.',
      `elapsed ms: ${elapsed}`,
      `granted wall ms: ${state.limits.wallMs}`,
      `tokens used: ${state.tokens}`,
      `granted tokens: ${state.limits.maxTokens}`,
      `host ceiling tokens: ${state.limits.ceilingTokens}; host ceiling active wall ms: ${state.limits.ceilingWall}`,
      `required total tokens: ${state.tokens + 1}; required total active wall ms: ${elapsed + 1}`,
      'Worker is waiting for budget at the next safe loop boundary. It will not dispatch another step until sufficient budget is granted. Budget wait does not expire.',
      'Call foundations_grant with amounts to ADD, sufficient to exceed current cumulative usage. Host ceilings cannot be raised by this tool; at a host ceiling an explicit deny/cancel is required. Pass deny=true to stop. Do not redispatch a replacement ticket.',
    ].join('\n')
    book.insertEvent({
      ticketId: ticket.id,
      attemptId: attempt.id,
      fencingToken: attempt.fencing_token,
      briefingRevision: ticket.briefing_revision,
      kind: 'progress',
      text,
      applyStatus: 'applied',
    })
  }

  /**
   * @param {string} sessionId
   * @param {{ wallMs: number, maxTokens: number }} budget
   */
  function releaseArm(sessionId: string, budget: { wallMs: number; maxTokens: number }) {
    const state = arms.get(sessionId)
    const attempt = book.attemptForChild(sessionId)
    if (!attempt) return
    const quota = quotaOf(attempt.ticket_id)
    if (!state || state.role !== 'worker' || state.closing) {
      // A detached turn stays parked until the grant path queues a durable continuation.
      if (quota) writeQuota(attempt.ticket_id, { ...quota, waiting: true, runningSince: null })
      return
    }
    state.limits.wallMs = budget.wallMs
    state.limits.maxTokens = budget.maxTokens
    const elapsed = Math.max(
      0,
      (state.pausedAt != null && state.atBoundary ? state.pausedAt : now().getTime()) - state.startedAt,
    )
    if (
      state.tokens >= budget.maxTokens ||
      elapsed >= budget.wallMs ||
      state.tokens >= state.limits.ceilingTokens ||
      elapsed >= state.limits.ceilingWall
    ) {
      state.extensionOpen = true
      if (state.pausedAt == null) state.pausedAt = now().getTime()
      state.clear()
      saveQuota(sessionId, state)
      book.markExtensionOpen(attempt.ticket_id)
      return
    }
    state.extensionOpen = false
    state.startedAt = now().getTime() - elapsed
    state.pausedAt = null
    state.atBoundary = false
    state.clear?.()
    saveQuota(sessionId, state)
    state.clear = schedule(
      () => {
        if (arms.get(sessionId) === state && !state.closing) consider(sessionId, state, true)
      },
      Math.max(1, budget.wallMs - elapsed),
    )
    for (const resolve of budgetWaiters.get(sessionId) ?? []) resolve(true)
    budgetWaiters.delete(sessionId)
  }

  type Quota = {
    tokens: number
    lastSeq: number | null
    activeMs: number
    runningSince: number | null
    waiting: boolean
    reason?: string
    phase?: 'requested' | 'waiting'
    resumeInputId?: string
  }
  function quotaOf(ticketId: string): Quota | null {
    try {
      return JSON.parse(book.ticket(ticketId)?.budget_json ?? '{}').quota ?? null
    } catch {
      return null
    }
  }
  function writeQuota(ticketId: string, quota: Quota) {
    const ticket = book.ticket(ticketId)
    if (!ticket) return
    const budget = JSON.parse(ticket.budget_json)
    budget.quota = quota
    store.db
      .prepare('UPDATE work_tickets SET budget_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(budget), now().toISOString(), ticketId)
  }
  function saveQuota(sessionId: string, state: BudgetArm, reason?: string) {
    const attempt = book.attemptForChild(sessionId)
    if (!attempt || attempt.id !== state.attemptId) return
    const activeMs = Math.max(
      0,
      (state.pausedAt != null && state.atBoundary ? state.pausedAt : now().getTime()) - state.startedAt,
    )
    writeQuota(attempt.ticket_id, {
      tokens: state.tokens,
      lastSeq: state.lastSeq,
      activeMs,
      runningSince: state.pausedAt == null ? now().getTime() : null,
      waiting: state.pausedAt != null,
      phase: state.atBoundary ? 'waiting' : 'requested',
      reason:
        state.pausedAt == null
          ? undefined
          : state.tokens >= state.limits.ceilingTokens || activeMs >= state.limits.ceilingWall
            ? 'host-ceiling'
            : (reason ?? quotaOf(attempt.ticket_id)?.reason),
    })
  }
  function quotaFeedback(ticketId: string) {
    const quota = quotaOf(ticketId)
    const budget = JSON.parse(book.ticket(ticketId)?.budget_json ?? '{}')
    return {
      waitingBudget: quota?.waiting === true,
      budgetReason: quota?.reason ?? null,
      usedTokens: quota?.tokens ?? 0,
      activeElapsedMs: quota?.activeMs ?? 0,
      requiredMaxTokens: (quota?.tokens ?? 0) + 1,
      requiredWallMs: (quota?.activeMs ?? 0) + 1,
      minimumAdditionalTokens: Math.max(0, (quota?.tokens ?? 0) + 1 - (budget.maxTokens ?? 0)),
      minimumAdditionalWallMs: Math.max(0, (quota?.activeMs ?? 0) + 1 - (budget.wallMs ?? 0)),
      hostTokenHeadroom: Math.max(0, limits.workerMaxTokens - (quota?.tokens ?? 0)),
      hostWallHeadroomMs: Math.max(0, limits.workerWallMs - (quota?.activeMs ?? 0)),
    }
  }
  function closeBudgetWait(sessionId: string) {
    const state = arms.get(sessionId)
    if (state) {
      state.closing = true
      state.clear()
    }
    for (const resolve of budgetWaiters.get(sessionId) ?? []) resolve(false)
    budgetWaiters.delete(sessionId)
  }
  /** Awaiting this official pre-step waterfall suspends admission, not the turn. */
  async function waitForBudget(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    if (!isWorkerSession(sessionId)) return true
    const attempt = book.attemptForChild(sessionId)
    const ticket = attempt ? book.ticket(attempt.ticket_id) : null
    if (!ticket || isFinishedTicket(ticket) || signal?.aborted) return false
    const state = arms.get(sessionId) ?? arm(sessionId, 0, 'worker')
    if (state.closing) return false
    consider(sessionId, state, false)
    if (state.pausedAt == null) return true
    if (!state.atBoundary) {
      // The already-admitted request/tool batch may finish; account for that
      // active time before freezing the clock at this safe loop boundary.
      state.pausedAt = now().getTime()
      state.atBoundary = true
      saveQuota(sessionId, state)
    }
    const caps = workerCaps(sessionId)
    releaseArm(sessionId, caps)
    if (state.pausedAt == null) return true
    return new Promise(resolve => {
      const waiters = budgetWaiters.get(sessionId) ?? new Set()
      const done = (allowed: boolean) => {
        signal?.removeEventListener('abort', aborted)
        waiters.delete(done)
        if (!waiters.size) budgetWaiters.delete(sessionId)
        resolve(allowed)
      }
      const aborted = () => done(false)
      waiters.add(done)
      budgetWaiters.set(sessionId, waiters)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) done(false)
    })
  }

  /**
   * @param {string} sessionId
   */
  function clearBudget(sessionId: string) {
    const state = arms.get(sessionId)
    if (state?.role === 'worker') saveQuota(sessionId, state)
    if (!state) return
    state.clear?.()
    arms.delete(sessionId)
  }
}

/**
 * A later turn/end for every started turn means the child is idle.
 * No turn at all, or an open turn, means it may still be running.
 * @param {Array<Record<string, any>>} events
 */
function latestTurnEnded(events: Array<Record<string, any>>) {
  const open = new Set()
  let sawTurn = false
  for (const event of events) {
    const turn = event.data?.turn
    if (turn == null) continue
    if (event.type === 'turn/start' || event.type === 'user/message') {
      sawTurn = true
      open.add(turn)
    } else if (event.type === 'turn/end') {
      sawTurn = true
      open.delete(turn)
    }
  }
  return sawTurn && open.size === 0
}

/**
 * @param {unknown} value
 */
function parseArgs(value: unknown) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
