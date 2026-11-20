/** Evidence-based UI projection. Never interprets model prose as a process heartbeat. */
import { english, type Copy, type MessageKey } from './i18n/index.ts'
import type { ToolSegment } from './types.ts'
import { isWorkDispatch, type WorkTicket } from './work.ts'

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

// TODO: mask credentials before tool arguments, results, and copied text are shown.
function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
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

/** Status only. Folded rows and the composer must not pretty-print every historical payload. */
export function toolStatus(tool: ToolSegment, tickets: readonly WorkTicket[] = []): ToolStatus {
  const status = toolState(tool)
  if (!isWorkDispatch(tool.name)) return status
  const parsedId = argsOf(tool.result).ticketId
  const ticketId = typeof parsedId === 'string' ? parsedId : ''
  const ticket = ticketId ? tickets.find(item => item.id === ticketId) : undefined
  if (ticket) {
    if (ticket.status === 'failed') return 'failed'
    if (ticket.status === 'cancelled') return 'cancelled'
    if (ticket.status === 'delivered') return 'succeeded'
    return 'worker'
  }
  if (status === 'succeeded' && ticketId) return 'worker'
  return status
}

function positiveLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

function baseName(path: string): string {
  const parts = path
    .split(/[/\\]/)
    .map(part => part.trim())
    .filter(Boolean)
  return parts.at(-1) ?? path
}

function firstLine(value: unknown): string {
  return typeof value === 'string' ? (value.split('\n')[0] ?? '').trim() : ''
}

function readWindowFromMeta(meta: unknown): { path: string; start: number; end: number; total: number | null } | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const record = meta as Record<string, unknown>
  const offset = positiveLine(record.offset)
  const total =
    typeof record.totalLines === 'number' && Number.isInteger(record.totalLines) && record.totalLines >= 0
      ? record.totalLines
      : null
  if (offset == null || !Array.isArray(record.lines)) return null
  const numbers: number[] = []
  for (const line of record.lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return null
    const number = (line as Record<string, unknown>).number
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null
    numbers.push(number)
  }
  const start = numbers[0] ?? offset
  const end = numbers.at(-1) ?? Math.max(0, offset - 1)
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  return { path, start, end, total }
}

function readWindowFromText(result: string): { path: string; start: number; end: number; total: number | null } | null {
  const path = /<path>([^<]*)<\/path>/.exec(result)?.[1]?.trim() ?? ''
  const showing = /\(Showing lines (\d+)-(\d+) of (\d+)\./.exec(result)
  if (showing) return { path, start: Number(showing[1]), end: Number(showing[2]), total: Number(showing[3]) }
  const capped = /\(Output capped\. Showing lines (\d+)-(\d+)\./.exec(result)
  if (capped) return { path, start: Number(capped[1]), end: Number(capped[2]), total: null }
  const eof = /\(End of file - total (\d+) lines\)/.exec(result)
  if (eof) {
    const total = Number(eof[1])
    return { path, start: total === 0 ? 0 : 1, end: total, total }
  }
  return null
}

type CallTool = Pick<ToolSegment, 'name' | 'args' | 'result' | 'meta'>

/** A collapsed row. The chain stores this, never the handler's own detail type. */
export interface PresentedCall {
  text: string
  view(): unknown
}

export interface CallHandle<D> {
  /** Attach the row view. D stays inside this registration. */
  show(render: (detail: D) => unknown): void
}

interface CallLink {
  names: ReadonlySet<string>
  present: (tool: CallTool, args: Record<string, unknown>) => PresentedCall | null
}

const callChain: CallLink[] = []

function registerCall<D>(
  names: readonly string[],
  present: (tool: CallTool, args: Record<string, unknown>) => D | null,
  text: (detail: D) => string,
): CallHandle<D> {
  let render: ((detail: D) => unknown) | null = null
  callChain.push({
    names: new Set(names),
    present: (tool, args) => {
      const detail = present(tool, args)
      if (detail == null) return null
      return { text: text(detail), view: () => render?.(detail) ?? null }
    },
  })
  return {
    show(next) {
      render = next
    },
  }
}

function lineSpan(start: number, end: number): string {
  if (end < start || end < 1) return ''
  return start === end ? `L${start}` : `L${start}-${end}`
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

function listedNames(names: string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names[0]} + ${names.length - 1} files`
}

function textArg(args: Record<string, unknown>, keys: readonly string[]): string {
  const value = keys.map(key => args[key]).find(item => typeof item === 'string')
  return typeof value === 'string' ? value : ''
}

function diffText(added: number, removed: number): string {
  return [added > 0 ? `+${added}` : '', removed > 0 ? `-${removed}` : ''].filter(part => part !== '').join(' ')
}

export const fileReadCall = registerCall(
  ['read'],
  (tool, args) => {
    const argPath = firstLine(args.file_path) || firstLine(args.path)
    const settled = readWindowFromMeta(tool.meta) ?? (tool.result ? readWindowFromText(tool.result) : null)
    const path = settled?.path || argPath
    if (!path) return null
    let span = ''
    if (settled && settled.end >= settled.start) span = lineSpan(settled.start, settled.end)
    else {
      const offset = positiveLine(args.offset)
      const limit = positiveLine(args.limit)
      if (limit != null) span = lineSpan(offset ?? 1, (offset ?? 1) + limit - 1)
      else if (offset != null) span = `L${offset}`
    }
    return { path: baseName(path), span }
  },
  detail => [detail.path ? `Read ${detail.path}` : 'Read', detail.span].filter(part => part !== '').join(' '),
)

export const fileEditCall = registerCall(
  ['edit', 'apply_patch', 'str_replace_editor'],
  (_tool, args) => {
    const path = firstLine(args.file_path) || firstLine(args.path)
    if (!path) return null
    return {
      path: baseName(path),
      added: lineCount(textArg(args, ['new_string', 'new_str', 'content', 'file_text'])),
      removed: lineCount(textArg(args, ['old_string', 'old_str'])),
    }
  },
  detail => ['Edit', detail.path, diffText(detail.added, detail.removed)].filter(part => part !== '').join(' '),
)

export const fileWriteCall = registerCall(
  ['write'],
  (_tool, args) => {
    const path = firstLine(args.file_path) || firstLine(args.path)
    if (!path) return null
    return {
      path: baseName(path),
      added: lineCount(typeof args.content === 'string' ? args.content : ''),
    }
  },
  detail => ['Write', detail.path, detail.added > 0 ? `+${detail.added}` : ''].filter(part => part !== '').join(' '),
)

export const grepCall = registerCall(
  ['grep'],
  (_tool, args) => {
    const pattern = firstLine(args.pattern) || firstLine(args.query)
    if (!pattern) return null
    return {
      pattern: pattern.length > 48 ? `${pattern.slice(0, 48)}…` : pattern,
      where: baseName(firstLine(args.path) || firstLine(args.glob)),
    }
  },
  detail => ['Grep', detail.pattern, detail.where ? `in ${detail.where}` : ''].filter(part => part !== '').join(' '),
)

export const canvasReadCall = registerCall(
  ['canvas_read'],
  (_tool, args) => ({ path: baseName(firstLine(args.path)) }),
  detail => (detail.path ? `canvas_read ${detail.path}` : 'canvas_read files'),
)

export const canvasEditCall = registerCall(
  ['canvas_edit'],
  (_tool, args) => {
    const path = firstLine(args.path)
    if (!path) return null
    return {
      path: baseName(path),
      added: lineCount(typeof args.replacement === 'string' ? args.replacement : ''),
      removed: lineCount(typeof args.old === 'string' ? args.old : ''),
    }
  },
  detail => ['canvas_edit', detail.path, diffText(detail.added, detail.removed)].filter(part => part !== '').join(' '),
)

export const canvasWriteCall = registerCall(
  ['canvas_write'],
  (_tool, args) => {
    const files = Array.isArray(args.files) ? args.files : []
    const names: string[] = []
    let textFiles = 0
    let textLines = 0
    for (const item of files) {
      if (!item || typeof item !== 'object') continue
      const file = item as Record<string, unknown>
      const path = firstLine(file.path)
      if (!path) continue
      names.push(baseName(path))
      if (typeof file.text === 'string') {
        textFiles += 1
        textLines += lineCount(file.text)
      }
    }
    const remove = Array.isArray(args.remove)
      ? args.remove.flatMap(item => {
          const path = typeof item === 'string' ? firstLine(item) : ''
          return path ? [baseName(path)] : []
        })
      : []
    if (names.length === 0 && remove.length === 0) return null
    const dropped = remove.slice(0, 2).join(', ')
    return {
      files: listedNames(names),
      added: names.length === 1 && textFiles === 1 && textLines > 0 ? textLines : null,
      remove: remove.length === 0 ? '' : `${dropped}${remove.length > 2 ? ` +${remove.length - 2}` : ''}`,
    }
  },
  detail =>
    [
      'canvas_write',
      detail.files,
      detail.added != null && detail.added > 0 ? `+${detail.added}` : '',
      detail.remove ? `remove ${detail.remove}` : '',
    ]
      .filter(part => part !== '')
      .join(' '),
)

/** First registered handler that claims this tool name supplies the collapsed row. */
export function callDetail(tool: CallTool): PresentedCall | null {
  const name = tool.name.toLowerCase()
  const args = argsOf(tool.args)
  for (const link of callChain) {
    if (!link.names.has(name)) continue
    const detail = link.present(tool, args)
    if (detail) return detail
  }
  return null
}

export function callDetailText(detail: PresentedCall): string {
  return detail.text
}

export function toolPresentation(tool: ToolSegment, sessionCwd?: string, tickets: readonly WorkTicket[] = []) {
  const args = argsOf(tool.args)
  const result = argsOf(tool.result)
  const shell = isShell(tool.name)
  const command = shell && typeof args.command === 'string' ? args.command : ''
  const description = typeof args.description === 'string' ? args.description : ''
  const meta = tool.meta && typeof tool.meta === 'object' ? (tool.meta as Record<string, unknown>) : {}
  const cwdRaw = typeof meta.cwd === 'string' ? meta.cwd : typeof args.workdir === 'string' ? args.workdir : sessionCwd
  const resolvedCwd =
    typeof meta.cwd === 'string' || !cwdRaw || cwdRaw.startsWith('/') || !sessionCwd
      ? cwdRaw
      : sessionCwd.replace(/\/$/, '') + '/' + cwdRaw
  const cwd = resolvedCwd ?? ''
  const ticketId = typeof result.ticketId === 'string' ? result.ticketId : ''
  const ticket = tickets.find(item => item.id === ticketId)
  // A dispatch result acknowledges a worker, not delivery of its task.
  const status = toolStatus(tool, tickets)
  const todos =
    tool.name === 'todo_write' && Array.isArray(args.todos)
      ? args.todos.flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const row = item as Record<string, unknown>
          return typeof row.content === 'string' && typeof row.status === 'string'
            ? [{ content: row.content, status: row.status }]
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
    title: tool.name === 'todo_write' ? 'todo_write' : tool.name,
    detail: callDetail(tool),
    args: formatArgs(tool.args),
    output: tool.result,
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
