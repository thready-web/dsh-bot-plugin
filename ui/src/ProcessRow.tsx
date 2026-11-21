import { useState, type ReactNode } from 'react'
import { Collapse } from './Collapse'
import { blockKey, fileChange, type ActivitySegment } from './follow'
import { ToolCallDrawer } from './ToolCallDrawer'
import {
  canvasEditCall,
  canvasReadCall,
  canvasWriteCall,
  fileEditCall,
  fileReadCall,
  fileWriteCall,
  grepCall,
  OPEN_TOOL_STATES,
  isShell,
  statusLabel,
  toolPresentation,
  toolStatus,
  type PresentedCall,
} from './activity'
import { useI18n } from './locale'
import { useSmoothText } from './use-smooth-text'
import type { WorkTicket } from './work'
import { type ThinkSegment, type ToolSegment } from './types'

function ThinkBody({ text, active }: { text: string; active: boolean }) {
  const shown = useSmoothText(text, active)
  return <div className="think-body">{shown}</div>
}

export function ThinkRow({ segment }: { segment: ThinkSegment }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  return (
    <div className="official-row" data-variant="think" data-segment={segment.id}>
      <button type="button" className="official-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="official-leading">
          <ThinkIcon />
          <Chevron />
        </span>
        <span className="official-label">
          {segment.running
            ? t('activity.thinkNow')
            : segment.seconds != null
              ? t('activity.thoughtSeconds', { seconds: String(segment.seconds) })
              : t('activity.thought')}
        </span>
      </button>
      <Collapse open={open}>
        <ThinkBody text={segment.text} active={segment.running} />
      </Collapse>
    </div>
  )
}

/** One contiguous activity run in the timeline, shared by normal and Bot mode. No generic Thinking wrapper. */
export function ActivityGroup({
  segments,
  pending = false,
  tickets = [],
  cwd,
  connectionPhase,
  onOpenTool,
  selectedCallId = null,
}: {
  segments: ActivitySegment[]
  pending?: boolean
  tickets?: readonly WorkTicket[]
  cwd?: string
  connectionPhase?: string
  onOpenTool?: (segment: ToolSegment | null) => void
  selectedCallId?: string | null
}) {
  const { t } = useI18n()
  const states = segments.flatMap(segment => (segment.kind === 'tool' ? [toolStatus(segment, tickets)] : []))
  const running =
    segments.some(segment => segment.kind === 'think' && segment.running) ||
    states.some(state => OPEN_TOOL_STATES.has(state))
  const active = pending || running
  const stale = connectionPhase != null && connectionPhase !== 'live'
  const tools = segments.filter(segment => segment.kind === 'tool')
  // One tool call is the row itself. A folder exists only for two or more, and starts closed.
  const fold = tools.length > 1
  const [open, setOpen] = useState(false)
  const [localCallId, setLocalCallId] = useState<string | null>(null)
  const owned = onOpenTool == null
  const selectedId = owned ? localCallId : selectedCallId
  const openTool = (segment: ToolSegment) => {
    if (selectedId === segment.callId) {
      if (onOpenTool) onOpenTool(null)
      else setLocalCallId(null)
      return
    }
    if (onOpenTool) onOpenTool(segment)
    else setLocalCallId(segment.callId)
  }
  const localSegment = owned
    ? segments.find(segment => segment.kind === 'tool' && segment.callId === localCallId)
    : null
  const latestTool = tools[tools.length - 1]
  const latestToolLive = latestTool != null && OPEN_TOOL_STATES.has(toolStatus(latestTool, tickets))
  const toolCallLabel =
    tools.length === 1 ? t('activity.toolCallOne') : t('activity.toolCalls', { count: String(tools.length) })
  const renderSegment = (segment: ActivitySegment) =>
    segment.kind === 'think' ? (
      <ThinkRow key={blockKey(segment.id)} segment={segment} />
    ) : (
      <ToolCallRow
        key={segment.callId}
        segment={segment}
        cwd={cwd}
        tickets={tickets}
        stale={stale}
        selected={selectedId === segment.callId}
        onOpen={() => openTool(segment)}
      />
    )
  const note = pending && !running ? <p className="activity-note">{t('activity.generating')}</p> : null
  return (
    <section
      className={fold && open ? 'activity-group open' : 'activity-group'}
      aria-label={t('activity.title')}
      data-state={active ? 'running' : 'settled'}
      data-fold={fold ? 'true' : 'false'}
      data-open={fold && open ? 'true' : 'false'}
      data-activity-start={segments[0]?.id}
    >
      {fold ? (
        <>
          <Collapse open={open}>
            <div className="activity-earlier">{segments.map(renderSegment)}</div>
          </Collapse>
          {open ? (
            <button
              type="button"
              className="activity-fold activity-collapse"
              aria-expanded={true}
              aria-label={toolCallLabel}
              onClick={() => setOpen(false)}
            >
              <Chevron />
            </button>
          ) : latestToolLive && latestTool ? (
            <div className="activity-latest">
              <button
                type="button"
                className="activity-fold"
                aria-expanded={false}
                aria-label={toolCallLabel}
                onClick={() => setOpen(true)}
              >
                <Chevron />
              </button>
              {renderSegment(latestTool)}
            </div>
          ) : (
            <button
              type="button"
              className="activity-fold activity-calls"
              aria-expanded={false}
              aria-label={toolCallLabel}
              onClick={() => setOpen(true)}
            >
              <Chevron />
              <span>{toolCallLabel}</span>
            </button>
          )}
          {open ? note : null}
        </>
      ) : (
        <>
          {segments.map(renderSegment)}
          {note}
        </>
      )}
      {localSegment && localSegment.kind === 'tool' ? (
        <ToolCallDrawer
          open
          segment={localSegment}
          cwd={cwd}
          tickets={tickets}
          stale={stale}
          onClose={() => setLocalCallId(null)}
        />
      ) : null}
    </section>
  )
}

interface ToolRowProps {
  segment: ToolSegment
  cwd?: string
  tickets?: readonly WorkTicket[]
  stale?: boolean
  selected?: boolean
  onOpen?: () => void
}

function FileReadLabel({ detail }: { detail: { path: string; span: string } }) {
  return (
    <span className="official-label call-label file-call">
      <span className="call-verb">Read</span>
      <span className="call-target">{detail.path}</span>
      {detail.span ? <span className="call-lines">{detail.span}</span> : null}
    </span>
  )
}

function FileEditLabel({ detail }: { detail: { path: string; added: number; removed: number } }) {
  return (
    <span className="official-label call-label file-call">
      <span className="call-verb">Edit</span>
      <span className="call-target">{detail.path}</span>
      {detail.added > 0 ? <span className="diff-plus">+{detail.added}</span> : null}
      {detail.removed > 0 ? <span className="diff-minus">-{detail.removed}</span> : null}
    </span>
  )
}

function FileWriteLabel({ detail }: { detail: { path: string; added: number } }) {
  return (
    <span className="official-label call-label file-call">
      <span className="call-verb">Write</span>
      <span className="call-target">{detail.path}</span>
      {detail.added > 0 ? <span className="diff-plus">+{detail.added}</span> : null}
    </span>
  )
}

function GrepLabel({ detail }: { detail: { pattern: string; where: string } }) {
  return (
    <span className="official-label call-label file-call">
      <span className="call-verb">Grep</span>
      <span className="call-target">{detail.pattern}</span>
      {detail.where ? <span className="call-lines">in {detail.where}</span> : null}
    </span>
  )
}

function CanvasReadLabel({ detail }: { detail: { path: string } }) {
  return (
    <span className="official-label call-label canvas-call">
      <span className="call-tool">canvas_read</span>
      <span className="call-target">{detail.path || 'files'}</span>
    </span>
  )
}

function CanvasEditLabel({ detail }: { detail: { path: string; added: number; removed: number } }) {
  return (
    <span className="official-label call-label canvas-call">
      <span className="call-tool">canvas_edit</span>
      <span className="call-target">{detail.path}</span>
      {detail.added > 0 ? <span className="diff-plus">+{detail.added}</span> : null}
      {detail.removed > 0 ? <span className="diff-minus">-{detail.removed}</span> : null}
    </span>
  )
}

function CanvasWriteLabel({ detail }: { detail: { files: string; added: number | null; remove: string } }) {
  return (
    <span className="official-label call-label canvas-call">
      <span className="call-tool">canvas_write</span>
      {detail.files ? <span className="call-target">{detail.files}</span> : null}
      {detail.added != null && detail.added > 0 ? <span className="diff-plus">+{detail.added}</span> : null}
      {detail.remove ? <span className="call-lines">remove {detail.remove}</span> : null}
    </span>
  )
}

fileReadCall.show(detail => <FileReadLabel detail={detail} />)
fileEditCall.show(detail => <FileEditLabel detail={detail} />)
fileWriteCall.show(detail => <FileWriteLabel detail={detail} />)
grepCall.show(detail => <GrepLabel detail={detail} />)
canvasReadCall.show(detail => <CanvasReadLabel detail={detail} />)
canvasEditCall.show(detail => <CanvasEditLabel detail={detail} />)
canvasWriteCall.show(detail => <CanvasWriteLabel detail={detail} />)

function CallLabel({ detail }: { detail: PresentedCall }) {
  return detail.view() as ReactNode
}

export function ToolCallRow(props: ToolRowProps) {
  const [open, setOpen] = useState(false)
  if (props.onOpen) return <ToolCallRowView {...props} />
  return (
    <>
      <ToolCallRowView {...props} selected={open} onOpen={() => setOpen(value => !value)} />
      <ToolCallDrawer
        open={open}
        segment={open ? props.segment : null}
        cwd={props.cwd}
        tickets={props.tickets}
        stale={props.stale}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** The row only names the call. Its detail opens in the right drawer. */
export function ToolCallRowView({ segment, cwd, tickets = [], stale = false, selected = false, onOpen }: ToolRowProps) {
  const { t } = useI18n()
  const view = toolPresentation(segment, cwd, tickets)
  const change = fileChange({ ...segment, args: view.args, result: view.output })
  const fallback = isShell(segment.name) ? t('activity.runCommand') : view.title
  const phrase =
    view.description ||
    (view.todos.length ? t('activity.updatePlan') : '') ||
    (view.ticket ? view.ticket.summary : '') ||
    (view.detail ? '' : change?.name || fallback)
  const exceptional = ['failed', 'cancelled', 'unknown'].includes(view.status)
  return (
    <div
      className={selected ? 'official-row tool-activity selected' : 'official-row tool-activity'}
      data-state={view.status}
      data-segment={segment.id}
    >
      <button
        type="button"
        className="official-title"
        aria-haspopup="dialog"
        aria-pressed={selected}
        onClick={event => {
          event.stopPropagation()
          onOpen?.()
        }}
      >
        <span className="official-leading">
          <ToolIcon />
        </span>
        {view.detail && phrase === '' ? (
          <CallLabel detail={view.detail} />
        ) : (
          <span className="official-label">{phrase}</span>
        )}
        {exceptional ? (
          <span className="activity-status">
            {statusLabel(view.status, t)}
            {stale ? t('activity.lastKnownSuffix') : ''}
          </span>
        ) : null}
      </button>
    </div>
  )
}

/** All activity folds share the project's height animation and reduced-motion behavior. */
export function ActivityDisclosure({
  className,
  status,
  segmentId,
  open,
  onToggle,
  panelId,
  title,
  trailing,
  children,
}: {
  className: string
  status?: string
  segmentId?: string
  open: boolean
  onToggle: () => void
  panelId: string
  title: ReactNode
  trailing?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`${className}${open ? ' open' : ''}`} data-state={status} data-segment={segmentId}>
      <button
        type="button"
        className="official-title"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={event => {
          event.stopPropagation()
          onToggle()
        }}
      >
        {title}
      </button>
      {trailing}
      <div id={panelId} className="activity-panel">
        <Collapse open={open}>{children}</Collapse>
      </div>
    </div>
  )
}

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 6.5L8 10.5L12 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ThinkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.8c2.8 0 5 2 5 4.6 0 1.6-.8 3-2 3.8-.4.3-.6.7-.6 1.1V12H5.6v-.7c0-.4-.2-.8-.6-1.1-1.2-.8-2-2.2-2-3.8 0-2.6 2.2-4.6 5-4.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6.2 13.6h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function ToolIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.2 4.2h9.6M3.2 8h9.6M3.2 11.8h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}
