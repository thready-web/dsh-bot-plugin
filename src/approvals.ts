/**
 * Official tool-permission answerer for the desk UI.
 *
 * `approval/request` is a distinct waterfall from user-questions. This
 * listener is prepended so typtert `$events` cannot intercept first. The
 * workbench claims every request it can show; anything it cannot identify
 * fails closed as `unavailable`. There is no always-allow on this card.
 */
import { toolError, type ToolPayload } from './errors.ts'
import type { HostContext } from './host.ts'

export type OfficialApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export type OfficialApprovalRequest = {
  agent?: { id?: unknown; session?: unknown }
  toolName?: unknown
  callId?: unknown
  reason?: unknown
  displayReason?: { en?: unknown; [locale: string]: unknown }
  signal?: AbortSignal
}

export type SubmitApprovalInput = {
  sessionId: string
  requestId: string
  outcome: OfficialApprovalOutcome
}

export type ApprovalSnapshot = {
  requestId: string
  sessionId: string
  toolName: string
  callId?: string
  reason: string
  displayReason?: { en: string; [locale: string]: string }
  state: 'open' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
}

type PendingApproval = {
  requestId: string
  request: OfficialApprovalRequest
  sessionId: string
  toolName: string
  callId?: string
  resolve: (outcome: OfficialApprovalOutcome) => void
  onAbort?: () => void
}

const answerers: Map<string, ApprovalAnswerer> = new Map()

export function publishApprovalAnswerer(dataDir: string, answerer: ApprovalAnswerer | null) {
  if (answerer) answerers.set(dataDir, answerer)
  else answerers.delete(dataDir)
}

export function approvalAnswererFor(dataDir: string) {
  return answerers.get(dataDir) ?? null
}

export function approvalSessionIdOf(agent: OfficialApprovalRequest['agent']): string {
  if (!agent || typeof agent !== 'object') return ''
  if (typeof agent.session === 'string' && agent.session !== '') return agent.session
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  return ''
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function displayReasonOf(value: OfficialApprovalRequest['displayReason']) {
  if (!value || typeof value !== 'object') return undefined
  const en = textOf(value.en)
  if (en === '') return undefined
  const display: { en: string; [locale: string]: string } = { en }
  for (const [locale, message] of Object.entries(value)) {
    if (typeof message === 'string' && message !== '') display[locale] = message
  }
  return display
}

export type ApprovalAnswerer = ReturnType<typeof createApprovalAnswerer>

export function createApprovalAnswerer() {
  const pending = new Set<PendingApproval>()
  const settled: ApprovalSnapshot[] = []
  let nextId = 1

  function detach(entry: PendingApproval) {
    if (!pending.has(entry)) return false
    pending.delete(entry)
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort)
    }
    return true
  }

  function remember(entry: PendingApproval, outcome: OfficialApprovalOutcome) {
    settled.unshift({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      callId: entry.callId,
      reason: textOf(entry.request.reason),
      displayReason: displayReasonOf(entry.request.displayReason),
      state: outcome,
    })
    if (settled.length > 50) settled.length = 50
  }

  async function handle(
    request: OfficialApprovalRequest,
    _next: () => Promise<OfficialApprovalOutcome>,
  ): Promise<OfficialApprovalOutcome> {
    const sessionId = approvalSessionIdOf(request.agent)
    const toolName = textOf(request.toolName)
    if (sessionId === '' || toolName === '') return 'unavailable'
    return new Promise(resolve => {
      const callId = textOf(request.callId)
      const entry: PendingApproval = {
        requestId: `approval-${nextId++}`,
        request,
        sessionId,
        toolName,
        callId: callId === '' ? undefined : callId,
        resolve,
      }
      const onAbort = () => {
        if (!detach(entry)) return
        remember(entry, 'cancelled')
        resolve('cancelled')
      }
      entry.onAbort = onAbort
      pending.add(entry)
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function submit(input: SubmitApprovalInput): ToolPayload {
    if (typeof input.sessionId !== 'string' || input.sessionId === '') {
      return toolError('VALIDATION', 'sessionId is required.')
    }
    if (typeof input.requestId !== 'string' || input.requestId === '') {
      return toolError('VALIDATION', 'requestId is required.')
    }
    if (input.outcome !== 'allowed-once' && input.outcome !== 'rejected') {
      return toolError('VALIDATION', 'Tool approval only accepts allow-once or reject.')
    }
    const matches = [...pending].filter(
      entry => entry.sessionId === input.sessionId && entry.requestId === input.requestId,
    )
    if (matches.length > 1) return toolError('CONFLICT', 'Multiple open approvals match this request.')
    const entry = matches[0]
    if (!entry) return toolError('NOT_FOUND', 'No open tool-approval request matches this session.')
    if (!detach(entry)) return toolError('CONFLICT', 'This approval was already answered.')
    remember(entry, input.outcome)
    entry.resolve(input.outcome)
    return { ok: true, path: 'approval', outcome: input.outcome, requestId: entry.requestId }
  }

  function snapshot(sessionId?: string): ApprovalSnapshot[] {
    const open = [...pending]
      .filter(entry => !sessionId || entry.sessionId === sessionId)
      .map(entry => ({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        callId: entry.callId,
        reason: textOf(entry.request.reason),
        displayReason: displayReasonOf(entry.request.displayReason),
        state: 'open' as const,
      }))
    const done = settled.filter(entry => !sessionId || entry.sessionId === sessionId)
    return [...open, ...done]
  }

  function listen(ctx: HostContext) {
    const dispose = ctx.on?.('approval/request', handle, true)
    return () => {
      if (typeof dispose === 'function') dispose()
      for (const entry of [...pending]) {
        if (!detach(entry)) continue
        remember(entry, 'unavailable')
        entry.resolve('unavailable')
      }
    }
  }

  return {
    listen,
    handle,
    submit,
    snapshot,
    pendingCount() {
      return pending.size
    },
  }
}
