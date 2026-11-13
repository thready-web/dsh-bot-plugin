import { resultStatus, toolState, ACTIVE_TOOL_STATES, statusLabel, redactText } from './activity.ts'
import { parseBotMail } from './bot-message.ts'
import { isTicketNotice, parseBriefing } from './work.ts'
import { isUserQuestionTool } from './user-question.ts'
import {
  type LiveBlock,
  type RetryAttempt,
  type Segment,
  type ThreadState,
  type ToolSegment,
  type TurnFailure,
} from './types.ts'

interface ContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: string
}

interface MessageBody {
  role?: string
  id?: string
  content?: ContentBlock[]
  source?: { kind?: string }
  toolCallId?: string
  isError?: boolean
}

interface SessionEvent {
  type?: string
  seq?: number
  time?: number
  surfaceOp?: unknown
  data?: Record<string, unknown>
}

function textOf(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
}

function messageBody(data: Record<string, unknown>): MessageBody | null {
  const nested = data.message
  if (nested && typeof nested === 'object') return nested as MessageBody
  if (Array.isArray(data.content) || typeof data.toolCallId === 'string') return data as MessageBody
  return null
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function failureOf(reason: unknown): TurnFailure | null {
  if (!reason || typeof reason !== 'object') return null
  const record = reason as {
    kind?: string
    error?: { message?: string; code?: string }
    reason?: { kind?: string; reason?: string }
  }
  if (record.kind === 'error') {
    const message =
      typeof record.error?.message === 'string' && record.error.message !== ''
        ? record.error.message
        : 'This turn failed'
    const code = typeof record.error?.code === 'string' ? record.error.code : undefined
    return { message, ...(code ? { code } : {}) }
  }
  if (record.kind === 'interrupted')
    return { message: 'The DSH process exited before this turn finished.', code: 'INTERRUPTED' }
  if (
    record.kind === 'aborted' &&
    record.reason?.kind === 'hook' &&
    record.reason.reason === 'deepseek-account/signed-out'
  ) {
    return { message: 'Stopped because you signed out of DeepSeek.', code: 'ACCOUNT_SIGNED_OUT' }
  }
  return null
}

function stepKey(turn: number | undefined, step: number | undefined): string {
  return `${turn ?? ''}:${step ?? ''}`
}

export function frameEvents(frame: unknown): Array<Record<string, unknown>> {
  const found: SessionEvent[] = []
  collectEvents(frame, found)
  return found.flatMap(event => {
    if (typeof event.seq !== 'number' || typeof event.type !== 'string') return []
    return [event as Record<string, unknown>]
  })
}

export function collectEvents(node: unknown, out: SessionEvent[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectEvents(item, out)
    return
  }
  const record = node as Record<string, unknown>
  if (typeof record.type === 'string' && record.type.includes('/') && ('data' in record || 'seq' in record)) {
    out.push(record as SessionEvent)
    return
  }
  if (record.event) collectEvents(record.event, out)
  if (record.value && record.value !== node) collectEvents(record.value, out)
  if (Array.isArray(record.events)) collectEvents(record.events, out)
  if (Array.isArray(record.records)) collectEvents(record.records, out)
}

function sortSegments(segments: Segment[]): Segment[] {
  return segments.sort((a, b) => a.seq - b.seq)
}

function addUser(segments: Segment[], segment: Segment & { kind: 'user' }): Segment[] {
  const index = segments.findIndex(
    item => item.kind === 'user' && item.optimistic && item.text.trim() === segment.text.trim(),
  )
  if (index >= 0) {
    const next = segments.slice()
    const pending = next[index]
    if (!pending || pending.kind !== 'user') return segments
    next[index] = {
      ...pending,
      optimistic: false,
      time: segment.time ?? pending.time,
      seq: segment.seq,
      turn: segment.turn,
    }
    return next
  }
  return sortSegments([...segments, segment])
}

export function toolDetail(name: string, args: string): string {
  const raw = args.trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const command = typeof parsed.command === 'string' ? parsed.command : ''
    const description = typeof parsed.description === 'string' ? parsed.description : ''
    const path = ['path', 'file_path', 'file', 'target_file', 'target']
      .map(key => parsed[key])
      .find(value => typeof value === 'string')
    const query =
      typeof parsed.query === 'string'
        ? parsed.query
        : typeof parsed.pattern === 'string'
          ? parsed.pattern
          : typeof parsed.prompt === 'string'
            ? parsed.prompt
            : ''
    return (command || (typeof path === 'string' ? path : '') || query || description || name)
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return raw.replace(/\s+/g, ' ').trim()
  }
}

function toolKind(name: string): string {
  const value = name.toLowerCase()
  if (value === 'bash' || value === 'shell' || value.includes('command') || value.includes('exec')) return 'commands'
  if (value.includes('image')) return 'readImage'
  if (value.includes('read') || value === 'cat') return 'read'
  if (value.includes('edit') || value.includes('patch') || value.includes('replace')) return 'edit'
  if (value.includes('write')) return 'write'
  if (value.includes('grep') || value.includes('glob') || value.includes('search') || value.includes('find'))
    return 'search'
  if (value.includes('webfetch') || value.includes('fetch') || value.includes('browse')) return 'webFetch'
  if (value.includes('web')) return 'webSearch'
  if (value.includes('plan')) return 'plan'
  if (value.includes('agent') || value.includes('task')) return 'subagents'
  return 'tools'
}

const RUNNING: Record<string, string> = {
  commands: 'Running commands',
  read: 'Reading files',
  readImage: 'Reading images',
  write: 'Writing files',
  edit: 'Editing files',
  search: 'Searching code',
  webSearch: 'Searching the web',
  webFetch: 'Visiting web pages',
  plan: 'Updating the plan',
  subagents: 'Coordinating subagents',
  tools: 'Calling tools',
  thinking: 'Thinking',
}

const DONE: Record<string, string> = {
  commands: 'Ran commands',
  read: 'Read files',
  readImage: 'Read images',
  write: 'Wrote files',
  edit: 'Edited files',
  search: 'Searched code',
  webSearch: 'Searched the web',
  webFetch: 'Visited web pages',
  plan: 'Updated the plan',
  subagents: 'Coordinated subagents',
  tools: 'Called tools',
  thinking: 'Analysis completed',
}

const TOOL_TITLES: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  str_replace_editor: 'Edit',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  web_search: 'Search',
  websearch: 'Search',
  webfetch: 'Fetch',
  web_fetch: 'Fetch',
}

export function toolTitle(tool: ToolSegment): string {
  const kind = toolKind(tool.name)
  if (tool.running) return RUNNING[kind] ?? 'Calling tools'
  return (
    TOOL_TITLES[tool.name.toLowerCase()] ??
    (tool.name && tool.name !== 'tool' ? tool.name : (DONE[kind] ?? 'Called tools'))
  )
}

export function processHeading(segments: readonly Segment[], running = false): string {
  const kinds = new Set<string>()
  for (const segment of segments) {
    if (segment.kind === 'tool') kinds.add(toolKind(segment.name))
  }
  if (kinds.size === 0) kinds.add('thinking')
  const table = running ? RUNNING : DONE
  const order = [
    'commands',
    'write',
    'edit',
    'read',
    'readImage',
    'search',
    'webSearch',
    'webFetch',
    'tools',
    'thinking',
  ]
  const labels = order
    .filter(kind => kinds.has(kind))
    .slice(0, 3)
    .map(kind => table[kind] ?? kind)
  const first = labels[0]
  if (!first) return 'Analysis completed'
  if (labels.length === 1) return first
  const rest = labels.slice(1).map(label => label.charAt(0).toLowerCase() + label.slice(1))
  if (labels.length === 2) return `${first} and ${rest[0]}`
  return [first, ...rest].join(', ')
}

export type ActivitySegment = Extract<Segment, { kind: 'think' | 'tool' }>

export type TurnPiece =
  | { type: 'text'; segment: Extract<Segment, { kind: 'assistant' }> }
  | { type: 'activity'; id: string; segments: ActivitySegment[] }
  | { type: 'question'; segment: Extract<Segment, { kind: 'tool' }> }

/** Keep each assistant sentence where it was emitted, and bundle only the activity between sentences. */
export function turnPieces(segments: readonly Segment[]): TurnPiece[] {
  const pieces: TurnPiece[] = []
  let activity: ActivitySegment[] = []
  let activityIndex = 0
  const flush = () => {
    if (activity.length === 0) return
    // A run keeps its identity when live block ids become durable event ids.
    pieces.push({
      type: 'activity',
      id: `activity:${activityIndex++}`,
      segments: activity,
    })
    activity = []
  }
  for (const segment of segments) {
    if (segment.kind === 'assistant') {
      flush()
      pieces.push({ type: 'text', segment })
    } else if (segment.kind === 'tool' && isUserQuestionTool(segment.name)) {
      flush()
      pieces.push({ type: 'question', segment })
    } else if (segment.kind === 'think' || segment.kind === 'tool') {
      activity.push(segment)
    }
  }
  flush()
  return pieces
}

export interface DiffLine {
  kind: 'add' | 'del' | 'context'
  text: string
}

export interface FileChange {
  path: string
  name: string
  language: string
  kilobytes: number
  added: number
  removed: number
  lines: DiffLine[]
}

export function fileChange(tool: ToolSegment): FileChange | null {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(tool.args) as unknown
    if (!value || typeof value !== 'object') return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const name = tool.name.toLowerCase()
  const path = stringField(parsed, ['file_path', 'path', 'file'])
  if (!path) return null
  if (name === 'write') {
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const lines = contentLines(content).map(text => ({ kind: 'add' as const, text }))
    return change(path, content.length, lines, lines.length, 0)
  }
  if (name === 'edit' || name === 'apply_patch' || name === 'str_replace_editor') {
    const oldText =
      typeof parsed.old_string === 'string'
        ? parsed.old_string
        : typeof parsed.old_str === 'string'
          ? parsed.old_str
          : null
    const newText =
      typeof parsed.new_string === 'string'
        ? parsed.new_string
        : typeof parsed.new_str === 'string'
          ? parsed.new_str
          : typeof parsed.content === 'string'
            ? parsed.content
            : typeof parsed.file_text === 'string'
              ? parsed.file_text
              : ''
    const lines =
      oldText == null || oldText === ''
        ? contentLines(newText).map(text => ({ kind: 'add' as const, text }))
        : lineDiff(oldText, newText)
    const added = lines.filter(line => line.kind === 'add').length
    const removed = lines.filter(line => line.kind === 'del').length
    return change(path, newText.length, lines, added, removed)
  }
  return null
}

function change(path: string, bytes: number, lines: DiffLine[], added: number, removed: number): FileChange {
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  return {
    path,
    name,
    language: languageFor(name),
    kilobytes: Math.max(1, Math.ceil(bytes / 1024)),
    added,
    removed,
    lines,
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = contentLines(oldText)
  const newLines = contentLines(newText)
  if (oldLines.length > 180 || newLines.length > 180) {
    return [
      ...oldLines.map(text => ({ kind: 'del' as const, text })),
      ...newLines.map(text => ({ kind: 'add' as const, text })),
    ]
  }
  const height = oldLines.length + 1
  const width = newLines.length + 1
  const dp: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(0))
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const row = dp[i]
      const next = dp[i + 1]
      if (!row || !next) continue
      row[j] = oldLines[i] === newLines[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i] ?? '' })
      i += 1
      j += 1
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: 'del', text: oldLines[i] ?? '' })
      i += 1
    } else {
      lines.push({ kind: 'add', text: newLines[j] ?? '' })
      j += 1
    }
  }
  while (i < oldLines.length) {
    lines.push({ kind: 'del', text: oldLines[i] ?? '' })
    i += 1
  }
  while (j < newLines.length) {
    lines.push({ kind: 'add', text: newLines[j] ?? '' })
    j += 1
  }
  return lines
}

function languageFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const languages: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    md: 'markdown',
    css: 'css',
    html: 'html',
    json: 'json',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
  }
  return languages[ext] ?? ''
}

export function thinkPreview(text: string): string {
  const line =
    text
      .split('\n')
      .map(item => item.trim())
      .find(Boolean) ?? ''
  return line.replaceAll('**', '')
}

function liveActivity(state: ThreadState): string {
  if (!state.drafting) return ''
  const tool = [...state.segments]
    .reverse()
    .find((item): item is ToolSegment => item.kind === 'tool' && ACTIVE_TOOL_STATES.has(toolState(item)))
  if (tool) {
    const detail = redactText(toolDetail(tool.name, tool.args))
    const label = statusLabel(toolState(tool))
    return detail ? `${label} · ${detail}` : label
  }
  if (state.segments.some(item => item.kind === 'assistant' && item.streaming)) return 'Replying'
  if (state.segments.some(item => item.kind === 'think' && item.running)) return 'Thinking'
  return 'Analyzing the request'
}

function withActivity(state: ThreadState): ThreadState {
  const activity = liveActivity(state)
  return activity === state.activity ? state : { ...state, activity }
}

function upsertTool(segments: Segment[], tool: ToolSegment): Segment[] {
  const index = segments.findIndex(item => item.kind === 'tool' && item.callId === tool.callId)
  if (index < 0) return sortSegments([...segments, tool])
  const previous = segments[index]
  if (!previous || previous.kind !== 'tool') return segments
  const next = segments.slice()
  const hasResult = previous.resultReceived === true || tool.resultReceived === true
  const newerResult =
    tool.resultReceived && (!previous.resultReceived || (tool.resultSeq ?? -1) > (previous.resultSeq ?? -1))
  const result = newerResult ? tool : previous
  const newerCall = tool.callReceived && (!previous.callReceived || (tool.callSeq ?? -1) > (previous.callSeq ?? -1))
  const call = newerCall ? tool : previous
  const name = (call.name !== 'tool' ? call.name : tool.name) || previous.name
  next[index] = {
    ...previous,
    // A result-first placeholder has no call position yet. Recover it from a late call.
    seq:
      !previous.callReceived && previous.resultReceived && tool.callReceived
        ? Math.min(previous.seq, tool.seq)
        : previous.seq,
    id: `tool:${tool.callId}`,
    name,
    args: call.callReceived ? call.args : tool.args || previous.args,
    callReceived: previous.callReceived || tool.callReceived,
    callSeq: call.callSeq,
    requestedAt: call.requestedAt,
    resultReceived: hasResult,
    result: hasResult ? result.result : '',
    error: hasResult ? result.error : false,
    errorCode: result.errorCode,
    meta: result.meta,
    resultSeq: result.resultSeq,
    settledAt: result.settledAt,
    status: hasResult
      ? resultStatus(name, result.result, result.error, result.errorCode)
      : (tool.status ?? previous.status),
    running: !hasResult && (tool.running || previous.running),
    turn: previous.turn ?? tool.turn,
    step: previous.step ?? tool.step,
  }
  return sortSegments(next)
}

function projectLive(
  state: ThreadState,
  key: string,
  blocks: LiveBlock[],
  seq: number,
  turn?: number,
  step?: number,
): Segment[] {
  const prefix = `live:${key}:`
  const prior = state.segments.filter(item => item.id.startsWith(prefix))
  let kept = state.segments.filter(
    item => !item.id.startsWith(prefix) || (item.kind === 'tool' && (item.callReceived || item.resultReceived)),
  )
  const added: Segment[] = []
  for (const block of blocks) {
    const part = seq + block.index / 100
    if (block.kind === 'reasoning' && block.text.trim()) {
      added.push({
        kind: 'think',
        id: `${prefix}think:${block.index}`,
        text: block.text,
        running: true,
        seq: part,
        turn,
        step,
      })
    } else if (block.kind === 'text' && block.text) {
      added.push({
        kind: 'assistant',
        id: `${prefix}text:${block.index}`,
        text: block.text,
        streaming: true,
        seq: part,
        turn,
        step,
      })
    } else if (block.kind === 'tool-call' && (block.name || block.args || block.id)) {
      const callId = block.id || `${prefix}tool:${block.index}`
      const existing = [...kept, ...prior].find(
        (item): item is ToolSegment => item.kind === 'tool' && item.callId === callId,
      )
      const durable = kept.findIndex(item => item.kind === 'tool' && item.callId === callId)
      if (durable >= 0) {
        const previous = kept[durable]
        if (previous && previous.kind === 'tool' && !previous.callReceived && !previous.resultReceived) {
          const next = kept.slice()
          next[durable] = {
            ...previous,
            name: block.name || previous.name,
            args: block.args || previous.args,
            running: previous.resultReceived ? false : previous.running,
            status: previous.resultReceived || previous.callReceived ? previous.status : 'preparing',
          }
          kept = next
        }
      } else {
        added.push({
          kind: 'tool',
          id: `${prefix}tool:${block.index}`,
          callId,
          name: block.name || existing?.name || 'tool',
          args: block.args || existing?.args || '',
          result: existing?.result ?? '',
          error: existing?.error ?? false,
          running: existing?.resultReceived ? false : true,
          status: existing?.status ?? 'preparing',
          resultReceived: existing?.resultReceived,
          seq: existing?.seq ?? part,
          turn,
          step,
        })
      }
    }
  }
  return sortSegments([...kept, ...added])
}

function ensureBlock(blocks: LiveBlock[], index: number, kind: LiveBlock['kind']): LiveBlock[] {
  const found = blocks.find(block => block.index === index)
  if (found) {
    if (found.kind === kind) return blocks
    return blocks.map(block => (block.index === index ? { ...block, kind } : block))
  }
  return [...blocks, { index, kind, text: '', id: '', name: '', args: '' }].sort((a, b) => a.index - b.index)
}

function patchBlock(
  blocks: LiveBlock[],
  index: number,
  kind: LiveBlock['kind'],
  patch: (block: LiveBlock) => LiveBlock,
): LiveBlock[] {
  const next = ensureBlock(blocks, index, kind)
  return next.map(block => (block.index === index ? patch({ ...block, kind }) : block))
}

function applyChunk(blocks: LiveBlock[], chunk: Record<string, unknown>): LiveBlock[] {
  const index = numberOf(chunk.index) ?? 0
  const type = typeof chunk.type === 'string' ? chunk.type : ''
  if (type === 'block-start') {
    const blockType =
      chunk.blockType === 'reasoning' || chunk.blockType === 'tool-call' || chunk.blockType === 'text'
        ? chunk.blockType
        : 'text'
    return ensureBlock(blocks, index, blockType)
  }
  if (type === 'text-delta' || type === 'text-chunks') {
    const extra = typeof chunk.text === 'string' ? chunk.text : textsOf(chunk.texts)
    return patchBlock(blocks, index, 'text', block => ({ ...block, text: block.text + extra }))
  }
  if (type === 'reasoning-delta' || type === 'reasoning-chunks') {
    const extra = typeof chunk.text === 'string' ? chunk.text : textsOf(chunk.texts)
    return patchBlock(blocks, index, 'reasoning', block => ({ ...block, text: block.text + extra }))
  }
  if (type === 'tool-call-delta' || type === 'tool-call-chunks') {
    const extra =
      typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : asString(chunk.args ?? chunk.arguments)
    return patchBlock(blocks, index, 'tool-call', block => ({
      ...block,
      id: typeof chunk.id === 'string' && chunk.id ? chunk.id : block.id,
      name: typeof chunk.name === 'string' && chunk.name ? chunk.name : block.name,
      args: type === 'tool-call-chunks' && extra ? extra : block.args + extra,
    }))
  }
  if (type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
    const block = chunk.block as ContentBlock
    const kind = block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'text' ? block.type : 'text'
    return patchBlock(blocks, index, kind, current => ({
      ...current,
      kind,
      text: typeof block.text === 'string' ? block.text : current.text,
      id: block.id || current.id,
      name: block.name || current.name,
      args: asString(block.arguments) || current.args,
    }))
  }
  return blocks
}

function textsOf(value: unknown): string {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('') : ''
}

function applyLive(state: ThreadState, event: SessionEvent): ThreadState {
  const data = event.data ?? {}
  const chunk = data.chunk
  if (!chunk || typeof chunk !== 'object') return state
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  const key = stepKey(turn, step)
  const previous = state.live[key] ?? { seq: event.seq ?? 0, blocks: [] }
  const blocks = applyChunk(previous.blocks, chunk as Record<string, unknown>)
  const live = { ...state.live, [key]: { seq: previous.seq || event.seq || 0, blocks } }
  const seq = previous.seq || event.seq || 0
  return {
    ...state,
    live,
    drafting: true,
    turn: turn ?? state.turn,
    segments: projectLive({ ...state, live }, key, blocks, seq, turn, step),
  }
}

function applyAssistant(state: ThreadState, event: SessionEvent): ThreadState {
  const data = event.data ?? {}
  const message = messageBody(data)
  const content = message?.content ?? []
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  const key = stepKey(turn, step)
  const live = { ...state.live }
  delete live[key]
  let segments = state.segments.filter(item => !item.id.startsWith(`live:${key}:`))
  segments = segments.filter(
    item => !((item.kind === 'think' || item.kind === 'assistant') && item.turn === turn && item.step === step),
  )
  const base = event.seq ?? 0
  content.forEach((block, index) => {
    const seq = base + index / 100
    if (block.type === 'reasoning' && block.text?.trim()) {
      segments.push({ kind: 'think', id: `think:${key}:${index}`, text: block.text, running: false, seq, turn, step })
    } else if (block.type === 'text' && block.text) {
      segments.push({
        kind: 'assistant',
        id: `text:${key}:${index}`,
        text: block.text,
        streaming: false,
        time: event.time,
        seq,
        turn,
        step,
        messageId: message?.id,
      })
    } else if (block.type === 'tool-call') {
      const callId = block.id || `call:${key}:${index}`
      const existing = segments.find(item => item.kind === 'tool' && item.callId === callId)
      segments = segments.filter(item => !(item.kind === 'tool' && item.callId === callId))
      segments.push({
        ...(existing?.kind === 'tool' ? existing : {}),
        kind: 'tool',
        id: `tool:${callId}`,
        callId,
        name:
          existing?.kind === 'tool' && existing.callReceived
            ? existing.name
            : block.name || (existing?.kind === 'tool' ? existing.name : '') || 'tool',
        args:
          existing?.kind === 'tool' && existing.callReceived
            ? existing.args
            : asString(block.arguments) || (existing?.kind === 'tool' ? existing.args : ''),
        result: existing?.kind === 'tool' ? existing.result : '',
        error: existing?.kind === 'tool' ? existing.error : false,
        running: existing?.kind === 'tool' ? existing.running && !existing.resultReceived : true,
        status:
          existing?.kind === 'tool'
            ? existing.resultReceived
              ? resultStatus(block.name || existing.name, existing.result, existing.error, existing.errorCode)
              : existing.status
            : 'preparing',
        // The committed content order is authoritative. A held stream can receive
        // tool/call before stream end; keeping its provisional seq would hoist the
        // tool ahead of this message's reasoning/text on commit (unlike replay).
        seq,
        turn,
        step,
      })
    }
  })
  return { ...state, live, segments: sortSegments(segments) }
}

function applyToolCall(state: ThreadState, event: SessionEvent): ThreadState {
  const data = event.data ?? {}
  const callId = typeof data.callId === 'string' ? data.callId : ''
  if (!callId) return state
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  return {
    ...state,
    segments: upsertTool(state.segments, {
      kind: 'tool',
      id: `tool:${callId}`,
      callId,
      name: typeof data.name === 'string' ? data.name : 'tool',
      args: asString(data.arguments),
      status: state.turnEnds?.[turn ?? -1] ? 'unknown' : 'waiting',
      callReceived: true,
      callSeq: event.seq,
      requestedAt: event.time,
      result: '',
      error: false,
      running: true,
      seq: event.seq ?? Number.MAX_SAFE_INTEGER,
      turn,
      step,
    }),
  }
}

function applyToolResult(state: ThreadState, event: SessionEvent): ThreadState {
  const data = event.data ?? {}
  const message = messageBody(data)
  const callId = message?.toolCallId ?? (typeof data.callId === 'string' ? data.callId : '')
  if (!callId) return state
  const result = textOf(message?.content)
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  const existing = state.segments.find(item => item.kind === 'tool' && item.callId === callId)
  return {
    ...state,
    segments: upsertTool(state.segments, {
      kind: 'tool',
      id: `tool:${callId}`,
      callId,
      name: existing?.kind === 'tool' ? existing.name : 'tool',
      args: existing?.kind === 'tool' ? existing.args : '',
      result,
      resultReceived: true,
      resultSeq: event.seq,
      settledAt: event.time,
      meta: data.meta,
      errorCode:
        typeof (data.error as { code?: string } | undefined)?.code === 'string'
          ? (data.error as { code: string }).code
          : undefined,
      status: resultStatus(
        existing?.kind === 'tool' ? existing.name : 'tool',
        result,
        message?.isError === true,
        typeof (data.error as { code?: string } | undefined)?.code === 'string'
          ? (data.error as { code: string }).code
          : undefined,
      ),
      error: message?.isError === true,
      running: false,
      seq: existing?.seq ?? event.seq ?? Number.MAX_SAFE_INTEGER,
      turn: turn ?? (existing?.kind === 'tool' ? existing.turn : undefined),
      step: step ?? (existing?.kind === 'tool' ? existing.step : undefined),
    }),
  }
}

export function isOpeningSnapshot(frame: unknown): boolean {
  return payloadOf(frame)?.type === 'snapshot'
}

/**
 * First seq of the follow opening page.
 * CDC loads only the log before this seq, so the page is not fetched again as chunks.
 * An empty page starts at 0. A non-snapshot frame returns null.
 */
export function openingHistoryCut(frame: unknown): number | null {
  const payload = payloadOf(frame)
  if (!payload || payload.type !== 'snapshot') return null
  const records = Array.isArray(payload.records) ? payload.records : []
  let beforeSeq = 0
  let seen = false
  for (const event of frameEvents(records)) {
    if (typeof event.seq !== 'number') continue
    if (!seen || event.seq < beforeSeq) beforeSeq = event.seq
    seen = true
  }
  return beforeSeq
}

function payloadOf(frame: unknown): Record<string, unknown> | null {
  if (!frame || typeof frame !== 'object') return null
  const record = frame as Record<string, unknown>
  const value = record.value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = value as Record<string, unknown>
    if (typeof inner.type === 'string') return inner
  }
  return typeof record.type === 'string' ? record : null
}

function streamingSeq(state: ThreadState, floor: number): number {
  let seq = floor
  for (const item of state.segments) if (item.seq > seq) seq = item.seq
  return seq + 0.5
}

function expandStream(stream: unknown): Array<{ time: number; chunk: Record<string, unknown> }> {
  if (!Array.isArray(stream)) return []
  const out: Array<{ time: number; chunk: Record<string, unknown> }> = []
  for (const candidate of stream) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (record.type === 'chunk' && record.chunk && typeof record.chunk === 'object') {
      out.push({ time: numberOf(record.time) ?? 0, chunk: record.chunk as Record<string, unknown> })
      continue
    }
    const index = numberOf(record.index) ?? 0
    const members = Array.isArray(record.texts) ? record.texts : Array.isArray(record.args) ? record.args : null
    if (!members) continue
    let time = numberOf(record.time0) ?? 0
    const gaps = Array.isArray(record.dt) ? record.dt : []
    members.forEach((member, offset) => {
      if (offset > 0) time += numberOf(gaps[offset - 1]) ?? 0
      const text = typeof member === 'string' ? member : ''
      if (record.type === 'text-chunks') out.push({ time, chunk: { type: 'text-delta', index, text } })
      else if (record.type === 'reasoning-chunks') out.push({ time, chunk: { type: 'reasoning-delta', index, text } })
      else if (record.type === 'tool-call-chunks') {
        out.push({
          time,
          chunk: {
            type: 'tool-call-delta',
            index,
            id: typeof record.id === 'string' ? record.id : '',
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            argumentsDelta: text,
          },
        })
      }
    })
  }
  return out
}

function pushChunk(
  state: ThreadState,
  turn: number,
  step: number,
  time: number,
  chunk: Record<string, unknown>,
  seq: number,
): ThreadState {
  return applyLive(state, { type: 'assistant/live-chunk', seq, time, data: { turn, step, chunk } })
}

function clearStepLive(state: ThreadState, turn: number, step: number, settled = false): ThreadState {
  const key = stepKey(turn, step)
  const live = { ...state.live }
  delete live[key]
  return {
    ...state,
    live,
    segments: state.segments.filter(item => {
      if (item.id.startsWith(`live:${key}:`))
        return item.kind === 'tool' && (item.callReceived === true || item.resultReceived === true)
      if (
        settled &&
        item.kind !== 'user' &&
        item.turn === turn &&
        item.step === step &&
        (item.kind === 'assistant' || item.kind === 'think')
      )
        return false
      return true
    }),
  }
}

function holdsMessage(state: ThreadState, event: SessionEvent): boolean {
  const attempt = state.streamAttempt
  if (!attempt) return false
  if (event.surfaceOp != null && event.surfaceOp !== 'append') return false
  const data = event.data ?? {}
  if (numberOf(data.turn) !== attempt.turn || numberOf(data.step) !== attempt.step) return false
  return event.seq == null || event.seq > attempt.startedAfterSeq
}

function releasePending(state: ThreadState): ThreadState {
  const pending = state.pendingAssistant
  const base = pending ? applyAssistant(state, pending) : state
  return { ...base, pendingAssistant: null, streamAttempt: null }
}

function freezeLive(state: ThreadState, turn: number, step: number): ThreadState {
  return {
    ...state,
    streamAttempt: null,
    pendingAssistant: null,
    segments: state.segments.map(item => {
      if (item.kind === 'user' || item.turn !== turn || item.step !== step) return item
      if (item.kind === 'think') return { ...item, running: false }
      if (item.kind === 'tool')
        return {
          ...item,
          running: false,
          status: item.resultReceived || !ACTIVE_TOOL_STATES.has(toolState(item)) ? item.status : ('unknown' as const),
        }
      if (item.kind === 'assistant') return { ...item, streaming: false }
      return item
    }),
  }
}

function modelStepSettled(state: ThreadState, turn: number, step: number): boolean {
  return (
    Boolean(state.turnEnds?.[turn]) ||
    state.segments.some(
      item =>
        item.kind !== 'user' &&
        item.turn === turn &&
        item.step === step &&
        (item.kind === 'tool'
          ? item.callReceived || item.resultReceived
          : item.kind === 'assistant'
            ? !item.id.startsWith('live:') && !item.streaming
            : item.kind === 'think' && !item.id.startsWith('live:') && !item.running),
    )
  )
}

function applyStreamBaseline(state: ThreadState, baseline: Record<string, unknown>): ThreadState {
  const revision = numberOf(baseline.revision) ?? state.streamRevision
  if (revision < state.streamRevision) return state
  let next: ThreadState = { ...state, streamRevision: revision }
  const attempt = baseline.activeAttempt
  if (!attempt || typeof attempt !== 'object') return { ...next, streamAttempt: null }
  const record = attempt as Record<string, unknown>
  const attemptId = typeof record.attemptId === 'string' ? record.attemptId : ''
  const turn = numberOf(record.turn)
  const step = numberOf(record.step)
  const startedAfterSeq = numberOf(record.startedAfterSeq) ?? revision
  if (!attemptId || turn == null || step == null) return { ...next, streamAttempt: null }
  if (modelStepSettled(next, turn, step)) return { ...next, streamAttempt: null }
  next = clearStepLive(next, turn, step)
  const expanded = expandStream(record.stream)
  const count = Math.min(numberOf(record.nextIndex) ?? expanded.length, expanded.length)
  const seq = streamingSeq(next, startedAfterSeq)
  for (let index = 0; index < count; index += 1) {
    const member = expanded[index]
    if (!member) continue
    next = pushChunk(next, turn, step, member.time, member.chunk, seq)
  }
  return {
    ...next,
    drafting: count > 0 || next.drafting,
    streamAttempt: { attemptId, turn, step, nextIndex: count, startedAfterSeq },
  }
}

function applyStreamFrame(state: ThreadState, frame: Record<string, unknown>): ThreadState {
  const type = typeof frame.type === 'string' ? frame.type : ''
  const revision = numberOf(frame.revision)
  const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
  if (revision == null || !attemptId || revision <= state.streamRevision) return state
  if (type === 'start') {
    const turn = numberOf(frame.turn)
    const step = numberOf(frame.step)
    if (turn == null || step == null || modelStepSettled(state, turn, step)) return state
    const released = state.pendingAssistant ? releasePending(state) : state
    const cleared = clearStepLive(released, turn, step, true)
    return {
      ...cleared,
      drafting: true,
      streamRevision: revision,
      streamAttempt: {
        attemptId,
        turn,
        step,
        nextIndex: 0,
        startedAfterSeq: numberOf(frame.startedAfterSeq) ?? state.streamRevision,
      },
    }
  }
  if (revision !== state.streamRevision + 1) return { ...releasePending(state), streamRevision: revision }
  const attempt = state.streamAttempt
  if (!attempt || state.turnEnds?.[attempt.turn] || attempt.attemptId !== attemptId)
    return { ...state, streamRevision: revision }
  if (type === 'chunk') {
    const index = numberOf(frame.index)
    const chunk = frame.chunk
    if (index == null || !chunk || typeof chunk !== 'object') return { ...state, streamRevision: revision }
    if (index !== attempt.nextIndex) return { ...releasePending(state), streamRevision: revision }
    const key = stepKey(attempt.turn, attempt.step)
    const seq = state.live[key]?.seq || streamingSeq(state, attempt.startedAfterSeq)
    const next = pushChunk(
      state,
      attempt.turn,
      attempt.step,
      numberOf(frame.time) ?? 0,
      chunk as Record<string, unknown>,
      seq,
    )
    return {
      ...next,
      streamRevision: revision,
      streamAttempt: { ...attempt, nextIndex: attempt.nextIndex + 1 },
    }
  }
  if (type === 'end') {
    const outcome =
      frame.outcome && typeof frame.outcome === 'object' ? (frame.outcome as { kind?: string; eventType?: string }) : {}
    const stamped = { ...state, streamRevision: revision }
    if (outcome.kind === 'abandoned') {
      const marked = {
        ...stamped,
        segments: stamped.segments.map(item =>
          item.kind === 'tool' &&
          !item.callReceived &&
          !item.resultReceived &&
          item.turn === attempt.turn &&
          item.step === attempt.step
            ? { ...item, id: `tool:${item.callId}`, running: false, status: 'cancelled' as const }
            : item,
        ),
      }
      const cleared = clearStepLive(marked, attempt.turn, attempt.step)
      return { ...cleared, streamAttempt: null, pendingAssistant: null }
    }
    if (outcome.kind === 'committed' && outcome.eventType === 'assistant/message') {
      return { ...releasePending(stamped), streamRevision: revision }
    }
    return { ...freezeLive(stamped, attempt.turn, attempt.step), streamRevision: revision }
  }
  return { ...state, streamRevision: revision }
}

function settleTurn(state: ThreadState, turn: number | null, cancelled = false): ThreadState {
  const pendingTurn = numberOf(state.pendingAssistant?.data?.turn)
  const released = state.pendingAssistant && (turn == null || pendingTurn === turn) ? releasePending(state) : state
  const live = Object.fromEntries(Object.entries(released.live).filter(([key]) => !key.startsWith(`${turn ?? ''}:`)))
  return {
    ...released,
    live,
    segments: released.segments
      .filter(item => !(typeof turn === 'number' && item.id.startsWith(`live:${turn}:`)) || item.kind === 'tool')
      .map(item => {
        if (item.turn !== turn) return item
        if (item.kind === 'think') return { ...item, running: false }
        if (item.kind === 'tool')
          return {
            ...item,
            running: false,
            status:
              item.resultReceived || !ACTIVE_TOOL_STATES.has(toolState(item))
                ? item.status
                : cancelled && !item.callReceived
                  ? ('cancelled' as const)
                  : ('unknown' as const),
          }
        if (item.kind === 'assistant') return { ...item, streaming: false }
        return item
      }),
  }
}

function applySnapshot(state: ThreadState, value: Record<string, unknown>): ThreadState {
  const projections = value.projections
  const values =
    projections && typeof projections === 'object'
      ? ((projections as { values?: Record<string, unknown> }).values ?? {})
      : {}
  const next = { ...state }
  if (typeof values.title === 'string') next.title = values.title
  const lastUsed =
    values.modelSelection && typeof values.modelSelection === 'object'
      ? (values.modelSelection as { lastUsed?: { model?: string } }).lastUsed
      : undefined
  if (lastUsed?.model) next.model = lastUsed.model
  const permissions = values.permissions
  if (permissions && typeof permissions === 'object') {
    const record = permissions as { currentValue?: string; preset?: string; sandbox?: string }
    const preset = record.currentValue ?? record.preset ?? record.sandbox
    if (typeof preset === 'string') next.preset = preset
  }
  const stats = values.sessionStats
  if (stats && typeof stats === 'object') {
    const turns = (stats as { turns?: number }).turns
    const steps = (stats as { steps?: number }).steps
    if (typeof turns === 'number') next.turns = turns
    if (typeof steps === 'number') next.steps = steps
  }
  return next
}

export function applyLogEvent(state: ThreadState, event: SessionEvent): ThreadState {
  if (typeof event.type !== 'string') return state
  let next = state
  const data = event.data ?? {}
  if (event.type === 'session/title' && typeof data.title === 'string') {
    const kind = data.source && typeof data.source === 'object' ? (data.source as { kind?: string }).kind : ''
    if (!(next.title && kind !== 'provider')) next = { ...next, title: data.title }
    return next
  }
  if (event.type === 'request/context') {
    const model = typeof data.model === 'string' ? data.model : ''
    if (model) next = { ...next, model }
    return next
  }
  if (event.type === 'turn/start') {
    const turn = numberOf(data.turn)
    next = {
      ...next,
      drafting: true,
      turn: turn ?? next.turn,
      turnStartedAt: typeof event.time === 'number' ? event.time : Date.now(),
    }
    return next
  }
  if (event.type === 'turn/end') {
    const turn = numberOf(data.turn) ?? next.turn
    const completed = { ...next.completed }
    if (turn != null && next.turn === turn && next.turnStartedAt != null && typeof event.time === 'number') {
      completed[turn] = Math.max(1, Math.round((event.time - next.turnStartedAt) / 1000))
    }
    const failure = turn == null ? null : failureOf(data.reason)
    const failures = failure == null || turn == null ? next.failures : { ...next.failures, [turn]: failure }
    const endKind =
      data.reason && typeof data.reason === 'object' && typeof (data.reason as { kind?: unknown }).kind === 'string'
        ? (data.reason as { kind: string }).kind
        : ''
    const turnEnds =
      turn == null
        ? (next.turnEnds ?? {})
        : { ...(next.turnEnds ?? {}), [turn]: endKind || next.turnEnds?.[turn] || 'ended' }
    next = settleTurn(next, turn, endKind === 'aborted')
    next = {
      ...next,
      drafting: next.turn === turn ? false : next.drafting,
      completed,
      failures,
      turnEnds,
      turnStartedAt: next.turn === turn ? null : next.turnStartedAt,
    }
    return next
  }
  if (event.type === 'llm/retry') {
    const turn = numberOf(data.turn)
    const retryId = typeof data.retryId === 'string' ? data.retryId : ''
    const retry = numberOf(data.retry)
    if (turn == null || retryId === '' || retry == null) return next
    const failure =
      data.failure && typeof data.failure === 'object' ? (data.failure as { message?: string; code?: string }) : {}
    const attempt: RetryAttempt = {
      retryId,
      retry,
      maxRetries: numberOf(data.maxRetries) ?? null,
      delayMs: typeof data.delayMs === 'number' ? data.delayMs : 0,
      message: typeof failure.message === 'string' ? failure.message : 'Request failed.',
      ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
      state: 'scheduled',
    }
    const prior = next.retries[turn] ?? []
    next = {
      ...next,
      retries: {
        ...next.retries,
        [turn]: [...prior.filter(item => item.retryId !== retryId || item.retry !== retry), attempt],
      },
    }
    return next
  }
  if (event.type === 'llm/retry-started') {
    const turn = numberOf(data.turn)
    const retryId = typeof data.retryId === 'string' ? data.retryId : ''
    const retry = numberOf(data.retry)
    if (turn == null || retryId === '' || retry == null) return next
    const prior = next.retries[turn]
    if (!prior) return next
    next = {
      ...next,
      retries: {
        ...next.retries,
        [turn]: prior.map(item =>
          item.retryId === retryId && item.retry === retry ? { ...item, state: 'started' } : item,
        ),
      },
    }
    return next
  }
  if (event.type === 'assistant/live-chunk') {
    next = applyLive(next, event)
    return next
  }
  if (event.type === 'user/message') {
    const message = messageBody(data)
    if (!message || message.source?.kind !== 'user') return next
    const text = textOf(message.content)
    if (!text) return next
    next = {
      ...next,
      segments: addUser(next.segments, {
        kind: 'user',
        id: `user:${event.seq ?? text}`,
        text,
        time: event.time,
        seq: event.seq ?? Number.MAX_SAFE_INTEGER,
        turn: numberOf(data.turn),
      }),
    }
    return next
  }
  if (event.type === 'assistant/message') {
    if (holdsMessage(next, event)) next = { ...next, pendingAssistant: event }
    else next = applyAssistant(next, event)
    return next
  }
  if (event.type === 'tool/call') {
    next = applyToolCall(next, event)
    return next
  }
  if (event.type === 'tool/result') {
    next = applyToolResult(next, event)
  }
  return next
}

export function applyEphemeralFrame(state: ThreadState, frame: unknown): ThreadState {
  const payload = payloadOf(frame) ?? (frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null)
  if (!payload) return state
  let next = state
  if (payload.type === 'snapshot') {
    next = applySnapshot(next, payload)
    const baseline = payload.assistantStream
    if (baseline && typeof baseline === 'object') next = applyStreamBaseline(next, baseline as Record<string, unknown>)
  }
  if (payload.type === 'assistant-stream') {
    const streamFrame = payload.frame
    if (streamFrame && typeof streamFrame === 'object')
      next = applyStreamFrame(next, streamFrame as Record<string, unknown>)
  }
  return next
}

function reduceFrame(state: ThreadState, frame: unknown, seen: Set<number>): ThreadState {
  let next = state
  const found: SessionEvent[] = []
  collectEvents(frame, found)
  for (const event of found) {
    if (event.seq != null) {
      if (seen.has(event.seq)) continue
      seen.add(event.seq)
    }
    next = applyLogEvent(next, event)
  }
  return applyEphemeralFrame(next, frame)
}

export function ingestFrame(state: ThreadState, frame: unknown, seen: Set<number>): ThreadState {
  return withActivity(reduceFrame(state, frame, seen))
}

export function previewOf(segments: Segment[]): string {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const item = segments[index]
    if (!item) continue
    if (item.kind === 'user' && isTicketNotice(item.text)) continue
    const mail = item.kind === 'user' ? parseBotMail(item.text) : null
    const briefing = item.kind === 'user' ? parseBriefing(item.text) : null
    const text = mail
      ? mail.body
      : briefing?.body
        ? briefing.body
        : item.kind === 'user' || item.kind === 'assistant'
          ? item.text
          : item.kind === 'tool'
            ? item.result || toolDetail(item.name, item.args)
            : thinkPreview(item.text)
    const clean = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[|*_`>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) return clean.slice(0, 80)
  }
  return ''
}
