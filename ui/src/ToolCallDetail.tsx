import { useState, type ReactNode } from 'react'
import { argsOf, callDetailText, isShell, statusLabel, toolPresentation, type ToolStatus } from './activity'
import { useCanvasPlace } from './CanvasPreview'
import { fileChange, type FileChange } from './follow'
import type { Copy } from './i18n/index'
import { useI18n } from './locale'
import type { ToolSegment } from './types'
import type { WorkTicket } from './work'

/**
 * Tool details share one card: status dot, kicker, primary text, copy, then the body.
 * Arguments that are not already the title or body appear as labeled fields on the card.
 * The shell card follows the native bash detail (directory, command, output) and shows workdir.
 */
export function ToolCallDetail({
  segment,
  cwd,
  tickets = [],
  stale = false,
}: {
  segment: ToolSegment
  cwd?: string
  tickets?: readonly WorkTicket[]
  stale?: boolean
}) {
  const { t, locale } = useI18n()
  const view = toolPresentation(segment, cwd, tickets)
  const args = argsOf(segment.args)
  const kind = detailKind(segment.name)
  const change = fileChange(segment)
  return (
    <div className="tool-detail" data-kind={kind}>
      <PrimaryCard kind={kind} segment={segment} args={args} view={view} change={change} t={t} />
      <Facts segment={segment} view={view} kind={kind} stale={stale} locale={locale} t={t} />
    </div>
  )
}

export function toolCallHeadline(
  segment: ToolSegment,
  cwd: string | undefined,
  tickets: readonly WorkTicket[],
  t: Copy,
): string {
  const view = toolPresentation(segment, cwd, tickets)
  if (view.description) return view.description
  if (view.todos.length) return t('activity.updatePlan')
  if (view.ticket?.summary) return view.ticket.summary
  if (view.detail) return callDetailText(view.detail)
  const change = fileChange(segment)
  if (change?.name) return change.name
  return isShell(segment.name) ? t('activity.runCommand') : view.title
}

type DetailKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'write'
  | 'grep'
  | 'todo'
  | 'canvas-read'
  | 'canvas-write'
  | 'work'
  | 'memory'
  | 'generic'

const WORK_TOOLS = new Set([
  'foundations_dispatch',
  'foundations_dispatch_canvas',
  'foundations_supply',
  'foundations_redirect',
  'foundations_steer',
  'foundations_cancel',
  'foundations_grant',
  'foundations_retry',
  'foundations_publish',
  'foundations_reject',
  'foundations_worker_history',
  'foundations_main_history',
  'foundations_report',
  'canvas_publish',
])

const MEMORY_TOOLS = new Set([
  'foundations_recall',
  'foundations_remember',
  'foundations_correct',
  'foundations_forget',
  'foundations_state_update',
  'foundations_skill_load',
  'foundations_memory_list',
  'foundations_memory_read',
])

function detailKind(name: string): DetailKind {
  const key = name.toLowerCase()
  if (isShell(key)) return 'shell'
  if (key === 'read') return 'read'
  if (key === 'write') return 'write'
  if (key === 'edit' || key === 'apply_patch' || key === 'str_replace_editor' || key === 'canvas_edit') return 'edit'
  if (key === 'grep') return 'grep'
  if (key === 'todo_write') return 'todo'
  if (key === 'canvas_read') return 'canvas-read'
  if (key === 'canvas_write') return 'canvas-write'
  if (WORK_TOOLS.has(key)) return 'work'
  if (MEMORY_TOOLS.has(key)) return 'memory'
  return 'generic'
}

type Presented = ReturnType<typeof toolPresentation>

function PrimaryCard({
  kind,
  segment,
  args,
  view,
  change,
  t,
}: {
  kind: DetailKind
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  change: FileChange | null
  t: Copy
}) {
  if ((kind === 'edit' || kind === 'write') && change)
    return <DiffDetail view={view} change={change} failure={callFailure(segment, view.status)} t={t} />
  if (kind === 'shell') return <ShellDetail segment={segment} view={view} t={t} />
  if (kind === 'read') return <ReadDetail segment={segment} args={args} view={view} t={t} />
  if (kind === 'grep') return <GrepDetail segment={segment} args={args} view={view} t={t} />
  if (kind === 'todo') return <TodoDetail segment={segment} view={view} t={t} />
  if (kind === 'canvas-read') return <CanvasReadDetail segment={segment} args={args} view={view} t={t} />
  if (kind === 'canvas-write') return <CanvasWriteDetail segment={segment} args={args} view={view} t={t} />
  if (segment.name.toLowerCase() === 'canvas_publish')
    return <CanvasPublishDetail segment={segment} view={view} t={t} />
  if (kind === 'work') return <WorkDetail segment={segment} args={args} view={view} t={t} />
  if (kind === 'memory') return <MemoryDetail segment={segment} args={args} view={view} t={t} />
  return <GenericDetail segment={segment} args={args} view={view} t={t} />
}

function ShellDetail({ segment, view, t }: { segment: ToolSegment; view: Presented; t: Copy }) {
  const command = view.command || view.description || t('activity.runCommand')
  const workdir = view.cwd && view.cwdSource !== 'session' ? view.cwd : ''
  const failure = toolFailure(segment.result)
  return (
    <DetailCard
      status={view.status}
      kicker={view.cwd ? baseName(view.cwd) : segment.name}
      title={command}
      code
      copyText={view.command}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
      fields={workdir ? [{ label: 'workdir', value: workdir }] : undefined}
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : (
        <ResultBody
          text={segment.result}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function ReadDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const label = view.detail ? callDetailText(view.detail) : ''
  const path = textArg(args, ['file_path', 'path']) || label || 'read'
  const span = spanOf(label)
  const failure = toolFailure(segment.result)
  const content = readContent(segment.result)
  return (
    <DetailCard
      status={view.status}
      kicker="Read"
      title={span ? `${path} ${span}` : path}
      code
      copyText={content}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : (
        <ResultBody
          text={content}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function DiffDetail({
  view,
  change,
  failure,
  t,
}: {
  view: Presented
  change: FileChange
  failure: ToolFailure | null
  t: Copy
}) {
  const text = change.lines
    .map(line => `${line.kind === 'del' ? '- ' : line.kind === 'add' ? '+ ' : '  '}${line.text}`)
    .join('\n')
  return (
    <DetailCard
      status={view.status}
      kicker={change.language || 'Edit'}
      title={change.path}
      code
      copyText={text}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
      extra={
        <span className="tool-detail-counts">
          {change.added > 0 ? <span className="diff-plus">+{change.added}</span> : null}
          {change.removed > 0 ? <span className="diff-minus">-{change.removed}</span> : null}
        </span>
      }
    >
      {failure ? <ErrorNote failure={failure} /> : null}
      <div className="diff-body">
        {change.lines.map((line, index) => (
          <div key={index} className={lineClass(line.kind)}>
            {line.text}
          </div>
        ))}
      </div>
    </DetailCard>
  )
}

function GrepDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const pattern = textArg(args, ['pattern', 'query']) || segment.name
  const where = textArg(args, ['path', 'glob'])
  const failure = toolFailure(segment.result)
  return (
    <DetailCard
      status={view.status}
      kicker="Grep"
      title={pattern}
      code
      copyText={segment.result}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
      extra={where ? <span className="tool-detail-kicker">in {baseName(where)}</span> : null}
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : (
        <ResultBody
          text={segment.result}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function TodoDetail({ segment, view, t }: { segment: ToolSegment; view: Presented; t: Copy }) {
  const failure = callFailure(segment, view.status)
  const done = view.todos.filter(todo => todo.status === 'completed').length
  const text = view.todos.map(todo => `${todo.status} ${todo.content}`).join('\n')
  return (
    <DetailCard
      status={view.status}
      kicker="todo_write"
      title={`${t('activity.updatePlan')} · ${done}/${view.todos.length}`}
      copyText={text}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? <ErrorNote failure={failure} /> : null}
      <ul className="activity-todos">
        {view.todos.map((todo, index) => (
          <li key={index} data-todo={todo.status}>
            <span className="todo-check" data-state={todo.status} role="img" aria-label={todo.status} />
            <span className="todo-content">{todo.content}</span>
          </li>
        ))}
      </ul>
    </DetailCard>
  )
}

function CanvasReadDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const path = textArg(args, ['path']) || 'files'
  const failure = toolFailure(segment.result)
  return (
    <DetailCard
      status={view.status}
      kicker="canvas_read"
      title={path}
      code
      copyText={failure?.message || segment.result}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : (
        <ResultBody
          text={readContent(segment.result) || segment.result}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function CanvasWriteDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const files = canvasFiles(args)
  const remove = canvasRemove(args)
  const title = files.map(file => baseName(file.path)).join(', ') || remove.join(', ') || 'canvas_write'
  const failure = callFailure(segment, view.status)
  const copy = files
    .filter(file => file.text)
    .map(file => `${file.path}\n${file.text}`)
    .join('\n\n')
  return (
    <DetailCard
      status={view.status}
      kicker="canvas_write"
      title={title}
      code
      copyText={copy || failure?.message || ''}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? <ErrorNote failure={failure} /> : null}
      {remove.length ? (
        <p className="tool-detail-note">
          {t('activity.removedFiles')} {remove.join(', ')}
        </p>
      ) : null}
      {files.map(file => (
        <section key={file.path} className="tool-detail-file">
          <h3>{file.path}</h3>
          {file.text ? <pre>{file.text}</pre> : <p className="tool-detail-note">{file.note}</p>}
        </section>
      ))}
      {!segment.resultReceived && segment.result === '' ? (
        <p className="tool-detail-note">{t('activity.callRequested')}</p>
      ) : files.length === 0 && remove.length === 0 ? (
        <p className="tool-detail-note">{t('activity.emptyResult')}</p>
      ) : null}
    </DetailCard>
  )
}

function WorkDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const narrative = workNarrative(args, view.ticket?.summary ?? '')
  const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
  const title = kind.length > 0 && kind.length <= 16 ? kind : ''
  const failure = callFailure(segment, view.status)
  const report = view.latestReport && !narrative.includes(view.latestReport) ? view.latestReport : ''
  return (
    <DetailCard
      status={view.status}
      kicker={segment.name}
      title={title}
      copyText={
        failure?.message || payloadCopy(failure ? '' : segment.result, [narrative, report].filter(Boolean).join('\n\n'))
      }
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? <ErrorNote failure={failure} /> : null}
      {narrative ? <p className="tool-detail-prose">{narrative}</p> : null}
      {failure ? null : (
        <PayloadBody
          result={segment.result}
          prose={report}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={view.status === 'worker' ? statusLabel('worker', t) : t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function CanvasPublishDetail({ segment, view, t }: { segment: ToolSegment; view: Presented; t: Copy }) {
  const place = useCanvasPlace()
  const failure = callFailure(segment, view.status)
  const published = failure ? null : publishedCanvas(segment.result)
  const pending = !segment.resultReceived && segment.result === ''
  return (
    <DetailCard
      status={failure ? 'failed' : view.status}
      kicker="canvas_publish"
      title={published?.title || t('canvas.card')}
      copyText={failure?.message}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
      onOpen={
        published
          ? () =>
              place.open(published.id, {
                revision: published.revision,
                page: null,
                anchor: null,
              })
          : undefined
      }
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : published ? null : (
        <p className="tool-detail-note">{pending ? t('activity.callRequested') : t('activity.emptyResult')}</p>
      )}
    </DetailCard>
  )
}

function MemoryDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const heading = splitHeading(firstLine(textArg(args, ['query', 'title', 'content', 'target'])) || view.description)
  const failure = callFailure(segment, view.status)
  return (
    <DetailCard
      status={view.status}
      kicker={segment.name}
      title={heading.title}
      copyText={failure?.message || payloadCopy(segment.result, heading.prose)}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? <ErrorNote failure={failure} /> : null}
      {heading.prose ? <p className="tool-detail-prose">{heading.prose}</p> : null}
      {failure ? null : (
        <PayloadBody
          result={segment.result}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function GenericDetail({
  segment,
  args,
  view,
  t,
}: {
  segment: ToolSegment
  args: Record<string, unknown>
  view: Presented
  t: Copy
}) {
  const title =
    view.description || firstLine(textArg(args, ['query', 'url', 'pattern', 'prompt', 'text', 'content'])) || view.title
  const failure = callFailure(segment, view.status)
  return (
    <DetailCard
      status={view.status}
      kicker={segment.name}
      title={title}
      copyText={failure?.message || payloadCopy(segment.result) || view.command}
      copyLabel={t('activity.copy')}
      copiedLabel={t('activity.copied')}
    >
      {failure ? (
        <ErrorNote failure={failure} />
      ) : (
        <PayloadBody
          result={segment.result}
          pending={!segment.resultReceived && segment.result === ''}
          emptyLabel={t('activity.emptyResult')}
          waitingLabel={t('activity.callRequested')}
        />
      )}
    </DetailCard>
  )
}

function Facts({
  segment,
  view,
  kind,
  stale,
  locale,
  t,
}: {
  segment: ToolSegment
  view: Presented
  kind: DetailKind
  stale: boolean
  locale: string
  t: Copy
}) {
  const lines: string[] = []
  if (kind === 'shell' && view.description && view.description !== view.command) lines.push(view.description)
  if (view.status !== 'succeeded') {
    lines.push(`${statusLabel(view.status, t)}${stale ? t('activity.lastKnownSuffix') : ''}`)
  } else if (stale) {
    lines.push(t('activity.lastKnown'))
  }
  if (kind === 'shell' && view.cwd) {
    const source =
      view.cwdSource === 'recorded'
        ? t('activity.cwdRecorded')
        : view.cwdSource === 'requested'
          ? t('activity.cwdRequested')
          : t('activity.cwdSessionDefault')
    lines.push(`${source}: ${view.cwd}`)
  }
  if (view.exitCode != null) lines.push(`Exit: ${view.exitCode}`)
  if (view.jobId) lines.push(`Job: ${view.jobId} · ${t('activity.jobRegistered')}`)
  if (view.ticketId) {
    lines.push(
      `Ticket: ${view.ticketId}${view.ticket?.childSessionId ? ` · Worker: ${view.ticket.childSessionId}` : ''}`,
    )
  }
  if (kind !== 'work' && view.latestReport) {
    lines.push(`${t('activity.latestReport')} (v${view.ticket?.revision}): ${view.latestReport}`)
  }
  if (segment.requestedAt != null) {
    const when = new Date(segment.requestedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en')
    const wait =
      segment.settledAt != null
        ? ` · ${t('activity.callWait')}: ${Math.max(0, segment.settledAt - segment.requestedAt)}ms`
        : ''
    lines.push(`${t('activity.callRecorded')}: ${when}${wait}`)
  }
  lines.push(`${view.title} · ${segment.callId}`)
  return (
    <div className="tool-detail-facts">
      {lines.map(line => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

function DetailCard({
  status,
  kicker,
  title,
  code = false,
  copyText,
  copyLabel,
  copiedLabel,
  extra,
  fields,
  onOpen,
  children,
}: {
  status: ToolStatus
  kicker: string
  title: string
  code?: boolean
  copyText?: string
  copyLabel: string
  copiedLabel: string
  extra?: ReactNode
  fields?: readonly { label: string; value: string }[]
  onOpen?: () => void
  children?: ReactNode
}) {
  const row = (
    <>
      <span className="tool-detail-dot" data-state={status} aria-hidden="true" />
      {kicker ? <span className="tool-detail-kicker">{kicker}</span> : null}
      {title ? <span className={code ? 'tool-detail-title code' : 'tool-detail-title'}>{title}</span> : null}
      {extra}
      {copyText ? <CopyText text={copyText} label={copyLabel} copiedLabel={copiedLabel} /> : null}
    </>
  )
  return (
    <article className="tool-detail-card" data-state={status}>
      <header className="tool-detail-head">
        {onOpen ? (
          <button type="button" className="tool-detail-head-row" aria-haspopup="dialog" onClick={onOpen}>
            {row}
          </button>
        ) : (
          <div className="tool-detail-head-row">{row}</div>
        )}
        <ArgFields fields={fields} />
      </header>
      {children ? <div className="tool-detail-body">{children}</div> : null}
    </article>
  )
}

function ArgFields({ fields }: { fields?: readonly { label: string; value: string }[] }) {
  if (!fields?.length) return null
  return (
    <dl className="tool-detail-fields">
      {fields.map(field => (
        <div key={field.label} className="tool-detail-field">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ResultBody({
  text,
  pending,
  emptyLabel,
  waitingLabel,
}: {
  text: string
  pending: boolean
  emptyLabel: string
  waitingLabel: string
}) {
  if (pending) return <p className="tool-detail-note">{waitingLabel}</p>
  if (text === '') return <p className="tool-detail-note">{emptyLabel}</p>
  return <pre>{text}</pre>
}

function CopyText({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="tool-detail-copy"
      aria-label={copied ? copiedLabel : label}
      onClick={event => {
        event.stopPropagation()
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1000)
        })
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  )
}

function lineClass(kind: 'add' | 'del' | 'context'): string {
  if (kind === 'add') return 'diff-line added'
  if (kind === 'del') return 'diff-line removed'
  return 'diff-line same'
}

/** Task sentences sit above the result. A short label such as a report kind can stay in the header. */
function workNarrative(args: Record<string, unknown>, summary: string): string {
  const instruction = textArg(args, ['briefing', 'text', 'content', 'note'])
  const parts = [summary.trim(), instruction.trim()].filter(Boolean)
  const unique = parts.filter((part, index) => parts.indexOf(part) === index)
  if (unique.length === 2 && (unique[0].includes(unique[1]) || unique[1].includes(unique[0]))) {
    return unique[0].length >= unique[1].length ? unique[0] : unique[1]
  }
  return unique.join('\n\n')
}

function splitHeading(value: string): { title: string; prose: string } {
  const text = value.trim()
  if (text.length > 16) return { title: '', prose: text }
  return { title: text, prose: '' }
}

function textArg(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function firstLine(value: string): string {
  return (value.split('\n')[0] ?? '').trim()
}

function baseName(path: string): string {
  const parts = path
    .split(/[/\\]/)
    .map(part => part.trim())
    .filter(Boolean)
  return parts.at(-1) ?? path
}

function spanOf(label: string): string {
  return / (L\d+(?:-\d+)?)$/.exec(label)?.[1] ?? ''
}

function readContent(result: string): string {
  const content = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(result)
  return content ? (content[1] ?? '') : result
}

interface ToolFailure {
  code: string
  message: string
}

/** Plugin tool errors are `{ ok: false, code, message }`. Plain host errors stay in the result text. */
function toolFailure(result: string): ToolFailure | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.ok !== false || typeof record.message !== 'string' || record.message.trim() === '') return null
  return { code: typeof record.code === 'string' ? record.code : '', message: record.message.trim() }
}

function callFailure(segment: ToolSegment, status: ToolStatus): ToolFailure | null {
  return (
    toolFailure(segment.result) ??
    (status === 'failed' && segment.result.trim()
      ? { code: segment.errorCode ?? '', message: segment.result.trim() }
      : null)
  )
}

function publishedCanvas(
  result: string,
): { id: string; title: string; revision: number | null; ticketId: string | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.ok === false) return null
  const canvas = record.canvas && typeof record.canvas === 'object' ? (record.canvas as Record<string, unknown>) : null
  const id = typeof record.canvasId === 'string' ? record.canvasId : typeof canvas?.id === 'string' ? canvas.id : ''
  if (!/^cnv_[A-Za-z0-9_-]{16}$/.test(id)) return null
  const revision =
    typeof record.revision === 'number'
      ? record.revision
      : typeof canvas?.previewRevision === 'number'
        ? canvas.previewRevision
        : null
  const title = typeof canvas?.title === 'string' ? canvas.title : typeof record.title === 'string' ? record.title : ''
  const ticketId =
    typeof canvas?.ticketId === 'string'
      ? canvas.ticketId
      : typeof record.ticketId === 'string'
        ? record.ticketId
        : null
  return { id, title, revision, ticketId }
}

function ErrorNote({ failure }: { failure: ToolFailure }) {
  return (
    <p className="tool-detail-error">
      {failure.code ? <span className="tool-detail-error-code">{failure.code}</span> : null}
      {failure.message}
    </p>
  )
}

function parsedPayload(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function payloadCopy(result: string, prose = ''): string {
  const parsed = parsedPayload(result)
  const fields = parsed !== undefined ? jsonCopy(parsed).trim() : result.trim()
  return [prose.trim(), fields].filter(Boolean).join('\n')
}

function PayloadBody({
  result,
  prose = '',
  pending,
  emptyLabel,
  waitingLabel,
}: {
  result: string
  prose?: string
  pending: boolean
  emptyLabel: string
  waitingLabel: string
}) {
  if (pending) return <p className="tool-detail-note">{waitingLabel}</p>
  const parsed = parsedPayload(result)
  const fields = parsed !== undefined && hasVisibleJson(parsed) ? <JsonValue value={parsed} /> : null
  if (prose || fields) {
    return (
      <>
        {prose ? <p className="tool-detail-note">{prose}</p> : null}
        {fields}
      </>
    )
  }
  if (parsed !== undefined) return null
  if (result.trim() === '') return <p className="tool-detail-note">{emptyLabel}</p>
  return <pre>{result}</pre>
}

function hasVisibleJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => item != null && item !== '' && hasVisibleJson(item))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
      if (key === 'ok' || key === 'retryable') return false
      return item != null && item !== '' && hasVisibleJson(item)
    })
  }
  return value != null && value !== ''
}

function jsonCopy(value: unknown, indent = ''): string {
  if (Array.isArray(value))
    return value
      .map(item => jsonCopy(item, indent))
      .filter(Boolean)
      .join('\n')
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => {
        if (key === 'ok' || key === 'retryable' || item == null || item === '') return []
        if (typeof item === 'object') {
          const nested = jsonCopy(item, `${indent}  `)
          return nested ? [`${indent}${key}`, nested] : []
        }
        return [`${indent}${key}: ${String(item)}`]
      })
      .join('\n')
  }
  return value == null || value === '' ? '' : `${indent}${String(value)}`
}

function JsonValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <JsonList value={value} />
  if (value && typeof value === 'object') return <JsonObject value={value as Record<string, unknown>} />
  return <>{String(value)}</>
}

function JsonList({ value }: { value: unknown[] }) {
  const items = value.filter(item => item != null && item !== '')
  if (!items.length) return null
  if (items.every(item => item == null || typeof item !== 'object')) {
    return (
      <ul className="tool-json-list">
        {items.map((item, index) => (
          <li key={index}>{String(item)}</li>
        ))}
      </ul>
    )
  }
  return (
    <div className="tool-json-list">
      {items.map((item, index) => (
        <div key={index} className="tool-json-item">
          <JsonValue value={item} />
        </div>
      ))}
    </div>
  )
}

function JsonObject({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value).filter(([key, item]) => {
    if ((key === 'ok' || key === 'retryable') && typeof item === 'boolean') return false
    return item != null && item !== '' && hasVisibleJson(item)
  })
  const scalars = entries.filter(([, item]) => typeof item !== 'object' && !isLongText(item))
  const blocks = entries.filter(([, item]) => typeof item === 'object' || isLongText(item))
  if (!scalars.length && !blocks.length) return null
  if (entries.length === 1 && entries[0]?.[0] === 'data') return <JsonValue value={entries[0][1]} />
  return (
    <>
      {scalars.length ? (
        <dl className="tool-detail-fields">
          {scalars.map(([key, item]) => (
            <div key={key} className="tool-detail-field">
              <dt>{key}</dt>
              <dd>{String(item)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {blocks.map(([key, item]) => (
        <section key={key} className="tool-json-block">
          <h3>{key}</h3>
          {typeof item === 'object' ? <JsonValue value={item} /> : <p>{String(item)}</p>}
        </section>
      ))}
    </>
  )
}

function isLongText(value: unknown): boolean {
  return typeof value === 'string' && (value.length > 80 || value.includes('\n'))
}

function canvasFiles(args: Record<string, unknown>): { path: string; text: string; note: string }[] {
  if (!Array.isArray(args.files)) return []
  return args.files.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const file = item as Record<string, unknown>
    const path = typeof file.path === 'string' ? file.path : ''
    if (!path) return []
    const text = typeof file.text === 'string' ? file.text : ''
    const type = typeof file.type === 'string' ? file.type : ''
    const source = typeof file.source === 'string' ? file.source : ''
    const note = source ? source : type || 'file'
    return [{ path, text, note }]
  })
}

function canvasRemove(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.remove)) return []
  return args.remove.flatMap(item => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
}
