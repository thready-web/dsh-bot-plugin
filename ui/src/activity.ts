/** Evidence-based UI projection. Never interprets model prose as a process heartbeat. */
import { english, type Copy, type MessageKey } from './i18n/index.ts'
import type { ToolSegment } from './types.ts'
import type { WorkTicket } from './work.ts'

export type ToolStatus =
  | 'preparing'
  | 'waiting'
  | 'running'
  | 'worker'
  | 'background'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
/** Last-known background is not current execution. Counts and composer pending use open states only. */
export const OPEN_TOOL_STATES: ReadonlySet<ToolStatus> = new Set(['preparing', 'waiting', 'running', 'worker'])
export const ACTIVE_TOOL_STATES: ReadonlySet<ToolStatus> = new Set([...OPEN_TOOL_STATES, 'background'])

const sensitiveKey =
  /(?:password|passwd|passphrase|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i

/** Best-effort credential masking, including incomplete streaming JSON. No unredacted copy path. */
export function redactText(value: string): string {
  if (/^\s*[\[{]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return JSON.stringify(maskObject(parsed), null, 2)
    } catch {
      /* an incomplete stream or plain console output */
    }
  }
  return (
    value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, '$1 [REDACTED]')
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, '[REDACTED]')
      // Quoted JSON keys, including fragments whose closing quote has not arrived yet.
      .replace(
        /("[^"\n]*(?:password|passwd|passphrase|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)[^"\n]*"\s*:\s*)("(?:\\.|[^"\\])*"?|[^,}\n]+)/gi,
        '$1"[REDACTED]"',
      )
      // Shell env assignments, CLI flags, and diagnostic key:value lines.
      .replace(
        /((?:--)?[A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)[A-Za-z0-9_-]*\s*(?:=|:\s*|\s+))('[^']*'?|"(?:\\.|[^"\\])*"?|[^\s,;]+)/gi,
        '$1[REDACTED]',
      )
      .replace(
        /((?:--)?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)\s*(?:=|:\s*|\s+))('[^']*'?|"(?:\\.|[^"\\])*"?|[^\s,;]+)/gi,
        '$1[REDACTED]',
      )
  )
}

function maskObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskObject)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : maskObject(item)]),
    )
  }
  return typeof value === 'string' ? redactText(value) : value
}

export function safeArgs(raw: string): string {
  try {
    return JSON.stringify(maskObject(JSON.parse(raw)), null, 2)
  } catch {
    return redactText(raw)
  }
}

export function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function isShell(name: string) {
  return ['bash', 'shell', 'pwsh', 'powershell'].includes(name.toLowerCase())
}

/** Only explicit host/tool markers are decoded, not arbitrary words like "failed" in stdout. */
export function resultStatus(name: string, result: string, isError: boolean, errorCode = ''): ToolStatus {
  if (/^TOOL_(NOT_STARTED|OUTCOME_UNKNOWN)$/.test(errorCode)) return 'unknown'
  if (/ABORT|CANCEL/i.test(errorCode)) return 'cancelled'
  if (isError) return 'failed'
  if (isShell(name)) {
    if (/^\[stopped: .+\]$/m.test(result)) return 'cancelled'
    if (/^\[(?:timed out after .+|killed by signal: .+|sandbox: .+)\]$/m.test(result)) return 'failed'
    const code = /^\[exit code: (-?\d+)\]$/m.exec(result)
    if (code) return Number(code[1]) !== 0 ? 'failed' : 'succeeded'
    // An acknowledgement is last-known only when no later exit, stop, or signal evidence exists.
    if (
      /^started background job \S+/m.test(result) ||
      /^\[still running after \d+ms; moved to background job .+\]$/m.test(result)
    )
      return 'background'
  }
  return 'succeeded'
}

export function toolState(tool: ToolSegment): ToolStatus {
  if (tool.status) return tool.status
  if (tool.resultReceived || tool.result !== '') return resultStatus(tool.name, tool.result, tool.error)
  return tool.running ? 'waiting' : 'unknown'
}

const STATUS_KEY: Record<ToolStatus, MessageKey> = {
  preparing: 'activity.status.preparing',
  waiting: 'activity.status.waiting',
  running: 'activity.status.running',
  worker: 'activity.status.worker',
  background: 'activity.status.backgroundDetail',
  succeeded: 'activity.status.succeeded',
  failed: 'activity.status.failed',
  cancelled: 'activity.status.cancelled',
  unknown: 'activity.status.unknown',
}

export function statusLabel(state: ToolStatus, t: Copy = english): string {
  return t(STATUS_KEY[state])
}

export function toolPresentation(tool: ToolSegment, sessionCwd?: string, tickets: readonly WorkTicket[] = []) {
  const args = argsOf(tool.args)
  const result = argsOf(tool.result)
  const shell = isShell(tool.name)
  const command = shell && typeof args.command === 'string' ? redactText(args.command) : ''
  const description = typeof args.description === 'string' ? redactText(args.description) : ''
  const meta = tool.meta && typeof tool.meta === 'object' ? (tool.meta as Record<string, unknown>) : {}
  const cwdRaw = typeof meta.cwd === 'string' ? meta.cwd : typeof args.workdir === 'string' ? args.workdir : sessionCwd
  const resolvedCwd =
    typeof meta.cwd === 'string' || !cwdRaw || cwdRaw.startsWith('/') || !sessionCwd
      ? cwdRaw
      : sessionCwd.replace(/\/$/, '') + '/' + cwdRaw
  const cwd = resolvedCwd ? redactText(resolvedCwd) : ''
  const ticketId = typeof result.ticketId === 'string' ? result.ticketId : ''
  const ticket = tickets.find(item => item.id === ticketId)
  let status = toolState(tool)
  // A dispatch result acknowledges a worker, not delivery of its task.
  if (ticket && tool.name === 'foundations_dispatch') {
    status =
      ticket.status === 'failed'
        ? 'failed'
        : ticket.status === 'cancelled'
          ? 'cancelled'
          : ticket.status === 'delivered'
            ? 'succeeded'
            : 'worker'
  } else if (tool.name === 'foundations_dispatch' && status === 'succeeded' && ticketId) status = 'worker'
  const todos =
    tool.name === 'todo_write' && Array.isArray(args.todos)
      ? args.todos.flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const row = item as Record<string, unknown>
          return typeof row.content === 'string' && typeof row.status === 'string'
            ? [{ content: redactText(row.content), status: row.status }]
            : []
        })
      : []
  const exit = shell ? /^\[exit code: (-?\d+)\]$/m.exec(tool.result) : null
  return {
    status,
    command,
    description,
    cwd,
    cwdSource: typeof meta.cwd === 'string' ? 'recorded' : typeof args.workdir === 'string' ? 'requested' : 'session',
    todos,
    title: tool.name === 'todo_write' ? 'todo_write' : redactText(tool.name),
    args: safeArgs(tool.args),
    output: redactText(tool.result),
    exitCode: exit ? Number(exit[1]) : null,
    ticket,
    ticketId,
    latestReport:
      ticket?.events.filter(event => event.revision === ticket.revision && event.applyStatus !== 'stale').at(-1)
        ?.text ?? '',
    jobId: shell
      ? (/(?:^started background job |moved to background job )([^\s\]]+)/m.exec(tool.result)?.[1] ?? '')
      : '',
  }
}
