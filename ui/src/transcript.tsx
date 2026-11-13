import { redactText } from './activity'
import { Fragment, useState } from 'react'
import { useI18n } from './locale'
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
  const shown = cardsToShow(safeTickets)
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
  return (
    <>
      {blocks.map((block, index) =>
        block.type === 'user' ? (
          <UserBlock
            key={block.segment.id}
            segment={block.segment}
            botLabel={botLabel}
            onOpenInbox={onOpenInbox}
            onOpenFile={onOpenFile}
          />
        ) : (
          <TurnBlock
            sessionId={sessionId}
            cwd={cwd}
            connectionPhase={connectionPhase}
            key={`${sessionId}:turn-${block.turn}`}
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
            questionWaits={questionWaits}
            onCompose={onCompose}
            trailingApprovals={index === blocks.length - 1}
          />
        ),
      )}
      {shown
        .filter(ticket => !anchorAt.has(ticket.id))
        .map(ticket => (
          <WorkCard key={ticket.id} ticket={ticket} now={now} onSupply={onSupply} onOpen={onOpenSession} />
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
  questionWaits,
  onCompose,
  trailingApprovals = false,
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
  questionWaits?: Record<string, { remainingMs?: number; waitState?: UserQuestionWait }>
  onCompose?: (text: string) => void
  trailingApprovals?: boolean
}) {
  const { t } = useI18n()
  const pieces = turnPieces(block.segments)
  const seenApprovals = new Set<string>()
  const waitOf = (callId: string) => questionWaits?.[callId] ?? questionWaits?.[`${sessionId}:${callId}`]
  const approvalsFor = (callIds: string[]) =>
    approvals.filter(item => {
      if (seenApprovals.has(item.requestId)) return false
      if (item.callId && callIds.includes(item.callId)) {
        seenApprovals.add(item.requestId)
        return true
      }
      return false
    })
  const leftoverApprovals = () =>
    trailingApprovals
      ? approvals.filter(item => {
          if (seenApprovals.has(item.requestId)) return false
          seenApprovals.add(item.requestId)
          return true
        })
      : []
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
                if (!id || !ticket || anchorAt.get(id) !== segment.id) return []
                return [
                  <WorkCard key={ticket.id} ticket={ticket} now={now} onSupply={onSupply} onOpen={onOpenSession} />,
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
