import { Fragment, useState } from 'react'
import type { Copy } from './i18n/index.ts'
import { useI18n } from './locale'
import { CanvasCard, useCanvasPlace, type CanvasSummary } from './CanvasPreview'
import { splitCanvasMessage } from './canvas-target'
import { BriefingCard, WorkCard, WorkRefusal } from './WorkCard'
import {
  backgroundOpen,
  budgetRefusalText,
  isBudgetRefusal,
  isTicketNotice,
  parseBriefing,
  type WorkTicket,
} from './work'
import { InboxLine } from './BotChatView'
import { inboxSummary } from './bot-chat'
import { parseBotMail } from './bot-message'
import { blockKey, isCardSegment, turnPieces } from './follow'
import { MarkdownView } from './MarkdownView'
import { ActivityGroup } from './ProcessRow'
import { UserQuestionCard } from './UserQuestionCard'
import { ToolApprovalCard, type ToolApprovalView } from './ToolApprovalCard'
import type { UserQuestionWait } from './user-question'
import type {
  ApprovalCardSegment,
  CanvasCardSegment,
  CardSegment,
  RetryAttempt,
  Segment,
  ToolSegment,
  TurnFailure,
  WorkerCardSegment,
} from './types'
import { placeOrphanTurns, turnAnchorSeq } from './transcript-place'

function clock(time: number | undefined, locale: string): string {
  if (!time) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' })
}

function dayKey(time: number | undefined): string {
  if (!time) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayText(time: number, locale: string, t: Copy): string {
  const date = new Date(time)
  const stamp = clock(time, locale)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dayKey(time) === dayKey(today.getTime())) return t('day.today', { time: stamp })
  if (dayKey(time) === dayKey(yesterday.getTime())) return t('day.yesterday', { time: stamp })
  const when = date.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric' })
  return `${when} ${stamp}`
}

export function Transcript({
  sessionId,
  segments,
  completed,
  failures,
  retries,
  turnEnds,
  tickets,
  now,
  canRetry,
  onRetry,
  onRetrySend,
  onSupply,
  onOpenSession,
  onOpenFile,
  onOpenInbox,
  botLabel,
  chat = false,
  cwd,
  connectionPhase,
  approvals = [],
  questionWaits,
  onCompose,
  onOpenTool,
  selectedCallId = null,
  faceSessionId,
}: {
  sessionId?: string
  /** Avatar identity. A worker passes its main session so the face stays the parent's. */
  faceSessionId?: string
  segments: Segment[]
  completed: Record<number, number>
  failures: Record<number, TurnFailure>
  retries: Record<number, RetryAttempt[]>
  turnEnds: Record<number, string>
  tickets: WorkTicket[]
  now: number
  canRetry: boolean
  onRetry: (text: string) => void
  onRetrySend?: (clientMessageId: string) => void
  onSupply: (ticketId: string, text: string) => Promise<string>
  onOpenSession: (sessionId: string) => void
  onOpenFile: (path: string, line?: number) => void
  onOpenInbox: () => void
  botLabel: (sessionId: string) => string
  chat?: boolean
  cwd?: string
  connectionPhase?: string
  approvals?: ToolApprovalView[]
  questionWaits?: Record<string, { remainingMs?: number; waitState?: UserQuestionWait }>
  onCompose?: (text: string) => void
  onOpenTool?: (segment: ToolSegment | null) => void
  selectedCallId?: string | null
}) {
  const blocks: Array<
    | { type: 'user'; segment: Segment & { kind: 'user' } }
    | { type: 'card'; segment: CardSegment }
    | { type: 'turn'; turn: number; seconds?: number; segments: Segment[] }
  > = []
  let turnBlock: Extract<(typeof blocks)[number], { type: 'turn' }> | null = null
  const flush = () => {
    if (turnBlock && (turnBlock.segments.length || failures[turnBlock.turn] || retries[turnBlock.turn]?.length))
      blocks.push(turnBlock)
    turnBlock = null
  }
  for (const segment of segments) {
    if (segment.kind === 'user') {
      flush()
      if (!isTicketNotice(segment.text)) blocks.push({ type: 'user', segment })
      continue
    }
    if (isCardSegment(segment)) {
      if (turnBlock) turnBlock.segments.push(segment)
      else blocks.push({ type: 'card', segment })
      continue
    }
    const turn = segment.turn ?? -1
    if (!turnBlock || turnBlock.turn !== turn) {
      flush()
      turnBlock = { type: 'turn', turn, seconds: completed[turn], segments: [] }
    }
    turnBlock.segments.push(segment)
  }
  flush()
  const seen = new Set(blocks.flatMap(block => (block.type === 'turn' ? [block.turn] : [])))
  const orphans: { seq?: number; block: (typeof blocks)[number] }[] = []
  const queueOrphan = (turn: number) => {
    if (seen.has(turn) || !Number.isFinite(turn)) return
    const failure = failures[turn]
    const attempts = retries[turn]
    if (!failure && !attempts?.length) return
    seen.add(turn)
    orphans.push({
      seq: turnAnchorSeq(failure, attempts),
      block: { type: 'turn', turn, seconds: completed[turn], segments: [] },
    })
  }
  for (const key of Object.keys(failures)) queueOrphan(Number(key))
  for (const key of Object.keys(retries)) queueOrphan(Number(key))
  if (orphans.length) {
    const placed = placeOrphanTurns(blocks, orphans)
    blocks.splice(0, blocks.length, ...placed)
  }
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const latestTurn = blocks.reduce((max, block) => (block.type === 'turn' ? Math.max(max, block.turn) : max), -1)
  const open = backgroundOpen(tickets)
  const { locale, t } = useI18n()
  let lastDay = ''
  return (
    <>
      {blocks.map((block, index) => {
        const stampTime = block.type === 'user' ? block.segment.time : undefined
        const key = dayKey(stampTime)
        const showDay = Boolean(key && key !== lastDay && stampTime)
        if (key) lastDay = key
        return (
          <Fragment key={block.type === 'turn' ? `${sessionId}:turn-${block.turn}` : block.segment.id}>
            {showDay && stampTime ? <p className="day-stamp">{dayText(stampTime, locale, t)}</p> : null}
            {block.type === 'user' ? (
              <UserBlock
                segment={block.segment}
                botLabel={botLabel}
                onOpenInbox={onOpenInbox}
                onOpenFile={onOpenFile}
                onRetrySend={onRetrySend}
              />
            ) : block.type === 'card' ? (
              <CardView
                segment={block.segment}
                sessionId={sessionId}
                faceSessionId={faceSessionId || sessionId}
                byId={byId}
                now={now}
                onSupply={onSupply}
                onOpenSession={onOpenSession}
                approvals={approvals}
              />
            ) : (
              <TurnBlock
                sessionId={sessionId}
                cwd={cwd}
                connectionPhase={connectionPhase}
                block={block}
                index={index}
                blocks={blocks}
                failures={failures}
                retries={retries}
                turnEnds={turnEnds}
                latestTurn={latestTurn}
                background={open}
                byId={byId}
                now={now}
                canRetry={canRetry}
                onRetry={onRetry}
                onSupply={onSupply}
                onOpenSession={onOpenSession}
                onOpenFile={onOpenFile}
                chat={chat}
                approvals={approvals}
                questionWaits={questionWaits}
                onCompose={onCompose}
                onOpenTool={onOpenTool}
                selectedCallId={selectedCallId}
                faceSessionId={faceSessionId || sessionId}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

function CardView({
  segment,
  sessionId,
  faceSessionId,
  byId,
  now,
  onSupply,
  onOpenSession,
  approvals,
}: {
  segment: CardSegment
  sessionId?: string
  faceSessionId?: string
  byId: Map<string, WorkTicket>
  now: number
  onSupply: (ticketId: string, text: string) => Promise<string>
  onOpenSession: (sessionId: string) => void
  approvals: ToolApprovalView[]
}) {
  const canvasPlace = useCanvasPlace()
  if (segment.kind === 'worker-card') {
    return (
      <WorkCard
        ticket={workerTicket(segment, byId)}
        now={now}
        onSupply={onSupply}
        onOpen={onOpenSession}
        ownerSessionId={faceSessionId}
      />
    )
  }
  if (segment.kind === 'canvas-card') {
    return <CanvasCard item={canvasSummary(segment)} onOpen={() => canvasPlace.open(segment.canvasId)} />
  }
  return <ToolApprovalCard approval={approvalView(segment, sessionId, approvals)} sessionId={sessionId} />
}

function workerTicket(segment: WorkerCardSegment, byId: Map<string, WorkTicket>): WorkTicket {
  return (
    byId.get(segment.ticketId) ?? {
      id: segment.ticketId,
      status: segment.status,
      revision: 1,
      summary: segment.summary,
      childSessionId: null,
      startedAt: null,
      events: [],
    }
  )
}

function canvasSummary(segment: CanvasCardSegment): CanvasSummary {
  return {
    id: segment.canvasId,
    title: segment.title,
    ticketId: segment.ticketId,
    previewRevision: segment.revision,
    stableRevision: null,
  }
}

function approvalView(
  segment: ApprovalCardSegment,
  sessionId: string | undefined,
  approvals: readonly ToolApprovalView[],
) {
  return (
    approvals.find(item => item.requestId === segment.requestId) ?? {
      requestId: segment.requestId,
      sessionId: sessionId ?? '',
      toolName: segment.toolName,
      reason: segment.reason,
      ...(segment.callId ? { callId: segment.callId } : {}),
      state: 'recorded' as const,
    }
  )
}

function UserBlock({
  segment,
  botLabel,
  onOpenInbox,
  onOpenFile,
  onRetrySend,
}: {
  segment: Segment & { kind: 'user' }
  botLabel: (sessionId: string) => string
  onOpenInbox: () => void
  onOpenFile: (path: string, line?: number) => void
  onRetrySend?: (clientMessageId: string) => void
}) {
  const mail = parseBotMail(segment.text)
  const briefing = parseBriefing(segment.text)
  const { locale, t } = useI18n()
  const stamp = clock(segment.time, locale)
  if (briefing) return <BriefingCard briefing={briefing} time={stamp} mark={segment.id} onOpenFile={onOpenFile} />
  if (mail) {
    const line = inboxSummary([{ kind: 'in', id: segment.id, seq: segment.seq, time: segment.time, mail }], botLabel)
    return (
      <InboxLine
        who={line?.who ?? 'BOT'}
        preview={line?.preview ?? ''}
        time={stamp}
        mark={segment.id}
        onOpen={onOpenInbox}
      />
    )
  }
  return (
    <div className="user-row" data-turn={segment.id}>
      <div className="user-bubble">
        <UserText text={segment.text} />
      </div>
      {segment.delivery ? (
        <p className="send-state" aria-live="polite">
          <span>
            {segment.delivery === 'queued'
              ? t('composer.queued')
              : segment.delivery === 'sending'
                ? t('composer.sending')
                : segment.delivery === 'failed'
                  ? t('composer.failed')
                  : t('composer.unknown')}
          </span>
          {segment.clientMessageId && (segment.delivery === 'failed' || segment.delivery === 'unknown') ? (
            <button
              type="button"
              aria-label={t('composer.retry')}
              onClick={() => onRetrySend?.(segment.clientMessageId ?? '')}
            >
              {t('composer.retry')}
            </button>
          ) : null}
        </p>
      ) : null}
      {stamp ? <time>{stamp}</time> : null}
    </div>
  )
}

function UserText({ text }: { text: string }) {
  const parts = splitCanvasMessage(text)
  return (
    <>
      {parts.text}
      {parts.chips.length > 0 ? (
        <span className="canvas-chip-row">
          {parts.chips.map(chip => (
            <span key={`${chip.canvasId}:${chip.revision}:${chip.path}`} className="canvas-chip">
              <span className="canvas-chip-text">{chip.label}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
}

function promptForTurn(
  blocks: Array<{ type: string; segment?: { text?: string; turn?: number }; turn?: number }>,
  index: number,
  turn: number,
): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const block = blocks[cursor]
    if (block?.type === 'user' && block.segment?.text && block.segment.text.trim() !== '') {
      if (parseBotMail(block.segment.text) || parseBriefing(block.segment.text)) continue
      if (block.segment.turn == null || block.segment.turn === turn) return splitCanvasMessage(block.segment.text).text
      break
    }
  }
  return ''
}

function continuedAfter(blocks: Array<{ type: string }>, index: number): boolean {
  return blocks.slice(index + 1).some(block => block.type === 'user')
}

function TurnFailurePanel({
  seconds,
  failure,
  retries,
  prompt,
  continued,
  canRetry,
  onRetry,
  showLabel,
}: {
  seconds?: number
  failure?: TurnFailure
  retries: RetryAttempt[]
  prompt: string
  continued: boolean
  canRetry: boolean
  onRetry: (text: string) => void
  showLabel: boolean
}) {
  const { t } = useI18n()
  const [used, setUsed] = useState(false)
  if (!failure && retries.length === 0) return null
  const spent = used || continued
  return (
    <div className="turn-failure">
      {showLabel ? (
        <p className="turn-failed-label">
          Failed
          {seconds != null ? (
            <>
              {' '}
              · <span className="duration">{seconds}s</span>
            </>
          ) : null}
        </p>
      ) : null}
      {retries.map(attempt => (
        <details key={`${attempt.retryId}:${attempt.retry}`} className="retry-row" open={attempt.state === 'scheduled'}>
          <summary>
            {attempt.state === 'started' ? 'Retried model request' : 'Retrying model request'} ({attempt.retry}/
            {attempt.maxRetries ?? '∞'}) · {Math.max(1, Math.ceil(attempt.delayMs / 1000))}s
          </summary>
          <p>Retry delay: {Math.round(attempt.delayMs)}ms</p>
          <p>Failure reason: {attempt.message}</p>
        </details>
      ))}
      {failure ? (
        <p className="turn-error" role="status">
          <span className="turn-error-title">This turn failed</span>
          <span>{failure.message}</span>
          {failure.code ? <code>{failure.code}</code> : null}
        </p>
      ) : null}
      {failure && prompt && !spent ? (
        <button
          type="button"
          className="retry-turn"
          disabled={!canRetry}
          onClick={() => {
            setUsed(true)
            onRetry(prompt)
          }}
        >
          {t('bot.retry')}
        </button>
      ) : null}
    </div>
  )
}

function TurnBlock({
  sessionId,
  block,
  index,
  blocks,
  failures,
  retries,
  turnEnds,
  latestTurn,
  background,
  byId,
  now,
  canRetry,
  onRetry,
  onSupply,
  onOpenSession,
  onOpenFile,
  chat = false,
  cwd,
  connectionPhase,
  approvals = [],
  questionWaits,
  onCompose,
  onOpenTool,
  selectedCallId = null,
  faceSessionId,
}: {
  sessionId?: string
  faceSessionId?: string
  block: { type: 'turn'; turn: number; seconds?: number; segments: Segment[] }
  index: number
  blocks: Array<{ type: string; segment?: { text?: string; turn?: number }; turn?: number }>
  failures: Record<number, TurnFailure>
  retries: Record<number, RetryAttempt[]>
  turnEnds: Record<number, string>
  latestTurn: number
  background: boolean
  byId: Map<string, WorkTicket>
  now: number
  canRetry: boolean
  onRetry: (text: string) => void
  onSupply: (ticketId: string, text: string) => Promise<string>
  onOpenSession: (sessionId: string) => void
  onOpenFile: (path: string, line?: number) => void
  chat?: boolean
  cwd?: string
  connectionPhase?: string
  approvals?: ToolApprovalView[]
  questionWaits?: Record<string, { remainingMs?: number; waitState?: UserQuestionWait }>
  onCompose?: (text: string) => void
  onOpenTool?: (segment: ToolSegment | null) => void
  selectedCallId?: string | null
}) {
  const { t } = useI18n()
  const pieces = turnPieces(block.segments)
  const waitOf = (callId: string) => questionWaits?.[callId] ?? questionWaits?.[`${sessionId}:${callId}`]
  const hasActivity = pieces.some(piece => piece.type === 'activity')
  const stopped =
    chat && turnEnds[block.turn] === 'aborted' && !failures[block.turn] && !(block.turn === latestTurn && background)
  return (
    <div>
      <div data-turn={`turn:${block.turn}`}>
        {pieces.map(piece => {
          if (piece.type === 'text') {
            return (
              <div
                data-segment={piece.segment.id}
                key={blockKey(piece.segment.id)}
                className={piece.segment.streaming ? 'assistant streaming' : 'assistant'}
              >
                <MarkdownView text={piece.segment.text} streaming={piece.segment.streaming} onOpenFile={onOpenFile} />
              </div>
            )
          }
          if (piece.type === 'question') {
            const wait = waitOf(piece.segment.callId)
            return (
              <UserQuestionCard
                key={piece.segment.id}
                segment={piece.segment}
                sessionId={sessionId}
                onCompose={onCompose}
                remainingMs={wait?.remainingMs}
                waitState={wait?.waitState}
              />
            )
          }
          if (piece.type === 'card') {
            return (
              <CardView
                key={piece.segment.id}
                segment={piece.segment}
                sessionId={sessionId}
                faceSessionId={faceSessionId}
                byId={byId}
                now={now}
                onSupply={onSupply}
                onOpenSession={onOpenSession}
                approvals={approvals}
              />
            )
          }
          const tools = piece.segments.filter(
            (segment): segment is Segment & { kind: 'tool' } => segment.kind === 'tool',
          )
          return (
            <Fragment key={piece.id}>
              <ActivityGroup
                segments={piece.segments}
                cwd={cwd}
                tickets={[...byId.values()]}
                connectionPhase={connectionPhase}
                onOpenTool={onOpenTool}
                selectedCallId={selectedCallId}
              />
              {tools
                .filter(segment => isBudgetRefusal(segment))
                .map(segment => (
                  <WorkRefusal key={segment.id} text={budgetRefusalText(segment.result, t)} />
                ))}
            </Fragment>
          )
        })}
        {stopped ? <p className="work-note">{t('bot.stopped')}</p> : null}
        <TurnFailurePanel
          seconds={block.seconds}
          failure={failures[block.turn]}
          retries={retries[block.turn] ?? []}
          prompt={promptForTurn(blocks, index, block.turn)}
          continued={continuedAfter(blocks, index)}
          canRetry={canRetry}
          onRetry={onRetry}
          showLabel={!hasActivity}
        />
        {block.turn === latestTurn && turnEnds[block.turn] === 'aborted' && background ? (
          <p className="work-note">{t('bot.stoppedBackground')}</p>
        ) : null}
      </div>
    </div>
  )
}
