import { redactText } from './activity'
import { Fragment, useRef, useState } from 'react'
import { useI18n } from './locale'
import { CanvasCard, useCanvasPlace } from './CanvasPreview'
import { BriefingCard, WorkCard, WorkRefusal } from './WorkCard'
import {
  backgroundOpen,
  budgetRefusalText,
  cardsToShow,
  dispatchTicketId,
  isBudgetRefusal,
  isTicketNotice,
  parseBriefing,
  type WorkTicket,
} from './work'
import { InboxLine } from './BotChatView'
import { inboxSummary } from './bot-chat'
import { parseBotMail } from './bot-message'
import { turnPieces } from './follow'
import { MarkdownView } from './MarkdownView'
import { ActivityGroup } from './ProcessRow'
import { UserQuestionCard } from './UserQuestionCard'
import { ToolApprovalCard, type ToolApprovalView } from './ToolApprovalCard'
import type { UserQuestionWait } from './user-question'
import type { RetryAttempt, Segment, TurnFailure } from './types'
import {
  blockKey,
  resolveApprovals,
  resolveFloatingWorks,
  resolveLooseCanvases,
  type ApprovalSpot,
} from './transcript-place'

function clock(time: number | undefined, locale: string): string {
  if (!time) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' })
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
}: {
  sessionId?: string
  segments: Segment[]
  completed: Record<number, number>
  failures: Record<number, TurnFailure>
  retries: Record<number, RetryAttempt[]>
  turnEnds: Record<number, string>
  tickets: WorkTicket[]
  now: number
  canRetry: boolean
  onRetry: (text: string) => void
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
}) {
  const blocks: Array<
    | { type: 'user'; segment: Segment & { kind: 'user' } }
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
    const turn = segment.turn ?? -1
    if (!turnBlock || turnBlock.turn !== turn) {
      flush()
      turnBlock = { type: 'turn', turn, seconds: completed[turn], segments: [] }
    }
    turnBlock.segments.push(segment)
  }
  flush()
  const seen = new Set(blocks.flatMap(block => (block.type === 'turn' ? [block.turn] : [])))
  for (const key of Object.keys(failures)) {
    const turn = Number(key)
    if (!seen.has(turn)) blocks.push({ type: 'turn', turn, seconds: completed[turn], segments: [] })
  }
  const safeTickets = tickets.map(ticket => ({
    ...ticket,
    summary: redactText(ticket.summary),
    events: ticket.events.map(event => ({ ...event, text: redactText(event.text) })),
  }))
  const byId = new Map(safeTickets.map(ticket => [ticket.id, ticket]))
  const anchorAt = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'turn') continue
    for (const piece of turnPieces(block.segments)) {
      if (piece.type !== 'activity') continue
      for (const segment of piece.segments) {
        if (segment.kind !== 'tool') continue
        const id = dispatchTicketId(segment)
        if (id && byId.has(id) && !anchorAt.has(id)) anchorAt.set(id, segment.id)
      }
    }
  }
  const latestTurn = blocks.reduce((max, block) => (block.type === 'turn' ? Math.max(max, block.turn) : max), -1)
  const open = backgroundOpen(tickets)
  const canvasPlace = useCanvasPlace()
  const pinState = useRef<{
    sessionId: string | undefined
    work: Map<string, string>
    canvas: Map<string, string>
    approval: Map<string, ApprovalSpot>
  }>({ sessionId, work: new Map(), canvas: new Map(), approval: new Map() })
  if (pinState.current.sessionId !== sessionId) {
    pinState.current = { sessionId, work: new Map(), canvas: new Map(), approval: new Map() }
  }
  const here = blocks.length > 0 ? blockKey(blocks[blocks.length - 1]!) : 'start'
  const anchored = new Set(anchorAt.keys())
  const floating = resolveFloatingWorks(cardsToShow(safeTickets), anchored, pinState.current.work, here)
  for (const [id, key] of pinState.current.work) {
    if (byId.has(id)) floating.set(id, key)
  }
  const covered = new Set<string>()
  for (const id of anchored) {
    if (byId.has(id) && !floating.has(id)) covered.add(id)
  }
  for (const id of floating.keys()) {
    if (byId.has(id)) covered.add(id)
  }
  const loosePins = resolveLooseCanvases(
    [...canvasPlace.loose, ...canvasPlace.byTicket.values()],
    covered,
    pinState.current.canvas,
    here,
  )
  const callTurn = new Map<string, number>()
  for (const block of blocks) {
    if (block.type !== 'turn') continue
    for (const segment of block.segments) {
      if (segment.kind === 'tool' && segment.callId && !callTurn.has(segment.callId)) {
        callTurn.set(segment.callId, block.turn)
      }
    }
  }
  const approvalSpots = resolveApprovals(approvals, callTurn, pinState.current.approval, latestTurn)
  const canvasById = new Map([...canvasPlace.loose, ...canvasPlace.byTicket.values()].map(item => [item.id, item]))
  const canvasForTicket = (ticketId: string) => {
    const canvas = canvasPlace.byTicket.get(ticketId)
    if (!canvas || loosePins.has(canvas.id)) return null
    return canvas
  }
  const pinnedAfter = (key: string) => {
    const workIds = [...floating.entries()].filter(([, pin]) => pin === key).map(([id]) => id)
    const canvasIds = [...loosePins.entries()].filter(([, pin]) => pin === key).map(([id]) => id)
    if (workIds.length === 0 && canvasIds.length === 0) return null
    return (
      <Fragment key={`pin:${key}`}>
        {workIds.map(id => {
          const ticket = byId.get(id)
          if (!ticket) return null
          const canvas = canvasForTicket(id)
          return (
            <Fragment key={ticket.id}>
              <WorkCard ticket={ticket} now={now} onSupply={onSupply} onOpen={onOpenSession} />
              {canvas ? <CanvasCard item={canvas} onOpen={() => canvasPlace.open(canvas.id)} /> : null}
            </Fragment>
          )
        })}
        {canvasIds.map(id => {
          const canvas = canvasById.get(id)
          if (!canvas) return null
          return <CanvasCard key={canvas.id} item={canvas} onOpen={() => canvasPlace.open(canvas.id)} />
        })}
      </Fragment>
    )
  }
  return (
    <>
      {pinnedAfter('start')}
      {blocks.map((block, index) => (
        <Fragment key={block.type === 'user' ? block.segment.id : `${sessionId}:turn-${block.turn}`}>
          {block.type === 'user' ? (
            <UserBlock segment={block.segment} botLabel={botLabel} onOpenInbox={onOpenInbox} onOpenFile={onOpenFile} />
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
              anchorAt={anchorAt}
              now={now}
              canRetry={canRetry}
              onRetry={onRetry}
              onSupply={onSupply}
              onOpenSession={onOpenSession}
              onOpenFile={onOpenFile}
              chat={chat}
              approvals={approvals}
              approvalSpots={approvalSpots}
              questionWaits={questionWaits}
              onCompose={onCompose}
              skipTickets={floating}
              looseCanvasIds={loosePins}
            />
          )}
          {pinnedAfter(blockKey(block))}
        </Fragment>
      ))}
    </>
  )
}

function UserBlock({
  segment,
  botLabel,
  onOpenInbox,
  onOpenFile,
}: {
  segment: Segment & { kind: 'user' }
  botLabel: (sessionId: string) => string
  onOpenInbox: () => void
  onOpenFile: (path: string, line?: number) => void
}) {
  const mail = parseBotMail(segment.text)
  const briefing = parseBriefing(segment.text)
  const { locale } = useI18n()
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
      <div className="user-bubble">{segment.text}</div>
      {stamp ? <time>{stamp}</time> : null}
    </div>
  )
}

function promptForTurn(
  blocks: Array<{ type: string; segment?: Segment & { kind: 'user' }; turn?: number }>,
  index: number,
  turn: number,
): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const block = blocks[cursor]
    if (block?.type === 'user' && block.segment && block.segment.text.trim() !== '') {
      if (parseBotMail(block.segment.text) || parseBriefing(block.segment.text)) continue
      if (block.segment.turn == null || block.segment.turn === turn) return block.segment.text
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
  anchorAt,
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
  approvalSpots,
  questionWaits,
  onCompose,
  skipTickets,
  looseCanvasIds,
}: {
  sessionId?: string
  block: { type: 'turn'; turn: number; seconds?: number; segments: Segment[] }
  index: number
  blocks: Array<{ type: string; segment?: Segment & { kind: 'user' }; turn?: number }>
  failures: Record<number, TurnFailure>
  retries: Record<number, RetryAttempt[]>
  turnEnds: Record<number, string>
  latestTurn: number
  background: boolean
  byId: Map<string, WorkTicket>
  anchorAt: Map<string, string>
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
  approvalSpots: Map<string, ApprovalSpot>
  questionWaits?: Record<string, { remainingMs?: number; waitState?: UserQuestionWait }>
  onCompose?: (text: string) => void
  skipTickets: Map<string, string>
  looseCanvasIds: Map<string, string>
}) {
  const { t } = useI18n()
  const canvasPlace = useCanvasPlace()
  const pieces = turnPieces(block.segments)
  const takenApprovals = new Set<string>()
  const waitOf = (callId: string) => questionWaits?.[callId] ?? questionWaits?.[`${sessionId}:${callId}`]
  const approvalsFor = (callIds: string[]) =>
    approvals.filter(item => {
      const spot = approvalSpots.get(item.requestId)
      if (!spot || spot.turn !== block.turn || !spot.callId || !callIds.includes(spot.callId)) return false
      if (takenApprovals.has(item.requestId)) return false
      takenApprovals.add(item.requestId)
      return true
    })
  const leftoverApprovals = () =>
    approvals.filter(item => {
      const spot = approvalSpots.get(item.requestId)
      if (!spot || spot.turn !== block.turn || takenApprovals.has(item.requestId)) return false
      takenApprovals.add(item.requestId)
      return true
    })
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
                key={piece.segment.id}
                className={piece.segment.streaming ? 'assistant streaming' : 'assistant'}
              >
                <MarkdownView text={piece.segment.text} streaming={piece.segment.streaming} onOpenFile={onOpenFile} />
              </div>
            )
          }
          if (piece.type === 'question') {
            const wait = waitOf(piece.segment.callId)
            return (
              <Fragment key={piece.segment.id}>
                <UserQuestionCard
                  segment={piece.segment}
                  sessionId={sessionId}
                  onCompose={onCompose}
                  remainingMs={wait?.remainingMs}
                  waitState={wait?.waitState}
                />
                {approvalsFor([piece.segment.callId]).map(item => (
                  <ToolApprovalCard key={item.requestId} approval={item} sessionId={sessionId} />
                ))}
              </Fragment>
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
              />
              {approvalsFor(tools.map(segment => segment.callId)).map(item => (
                <ToolApprovalCard key={item.requestId} approval={item} sessionId={sessionId} />
              ))}
              {tools
                .filter(segment => isBudgetRefusal(segment))
                .map(segment => (
                  <WorkRefusal key={segment.id} text={redactText(budgetRefusalText(segment.result, t))} />
                ))}
              {tools.flatMap(segment => {
                const id = dispatchTicketId(segment)
                const ticket = id ? byId.get(id) : undefined
                if (!id || !ticket || anchorAt.get(id) !== segment.id || skipTickets.has(id)) return []
                const canvas = canvasPlace.byTicket.get(ticket.id)
                const pinnedCanvas = canvas && looseCanvasIds.has(canvas.id) ? null : canvas
                return [
                  <WorkCard key={ticket.id} ticket={ticket} now={now} onSupply={onSupply} onOpen={onOpenSession} />,
                  pinnedCanvas ? (
                    <CanvasCard
                      key={pinnedCanvas.id}
                      item={pinnedCanvas}
                      onOpen={() => canvasPlace.open(pinnedCanvas.id)}
                    />
                  ) : null,
                ]
              })}
            </Fragment>
          )
        })}
        {leftoverApprovals().map(item => (
          <ToolApprovalCard key={item.requestId} approval={item} sessionId={sessionId} />
        ))}
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
