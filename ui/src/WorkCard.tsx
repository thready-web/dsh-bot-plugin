import { derivePresence } from '@tobs/bot-presence'
import { useState } from 'react'
import { Collapse } from './Collapse'
import { PresenceMark } from './presence/PresenceMark'
import { useI18n } from './locale'
import { MarkdownView } from './MarkdownView'
import { questionView, ticketFacts, workLabel, type WorkBriefing, type WorkTicket } from './work'

export function WorkCard({
  ticket,
  now,
  onSupply,
  onOpen,
  ownerSessionId,
}: {
  ticket: WorkTicket
  now: number
  onSupply: (ticketId: string, text: string) => Promise<string>
  onOpen: (sessionId: string) => void
  /** The main session whose face this worker wears. */
  ownerSessionId?: string
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const question = questionView(ticket)
  const live = ticket.status === 'started' || ticket.status === 'needs_user'
  const faceId = ownerSessionId || ticket.childSessionId || ticket.id
  const face = derivePresence({ sessionId: faceId, ticket: { status: ticket.status } })
  return (
    <article className="work-card">
      <header>
        <span className="work-face">
          <PresenceMark sessionId={faceId} state={face.state} still size={28} />
          <h3>{ticket.summary}</h3>
        </span>
        {ticket.status === 'ready' ? null : (
          <span className={live ? 'work-status live' : 'work-status'}>{workLabel(ticket.status, t)}</span>
        )}
      </header>
      {ticketFacts(ticket, now, t).map(line => (
        <p key={line}>{line}</p>
      ))}
      {ticket.childSessionId ? (
        <button type="button" className="work-open" onClick={() => onOpen(ticket.childSessionId ?? '')}>
          {t('work.openWorker')}
        </button>
      ) : null}
      {question ? (
        <p className={question.stale ? 'stale' : 'work-question'}>{question.text || t('work.questionEmpty')}</p>
      ) : null}
      {question?.stale ? <p className="work-quiet">{t('work.questionStale')}</p> : null}
      {ticket.status === 'needs_user' ? (
        <form
          className="work-reply"
          onSubmit={event => {
            event.preventDefault()
            const text = draft.trim()
            if (!text || sending) return
            setSending(true)
            setError('')
            void onSupply(ticket.id, text).then(message => {
              setSending(false)
              if (message) setError(message)
              else setDraft('')
            })
          }}
        >
          <label>
            <span>{t('work.answerLabel')}</span>
            <textarea value={draft} rows={2} disabled={sending} onChange={event => setDraft(event.target.value)} />
          </label>
          {error ? <p className="work-error">{error}</p> : null}
          <button type="submit" disabled={sending || draft.trim() === ''}>
            {t('work.answerSubmit')}
          </button>
        </form>
      ) : null}
    </article>
  )
}

export function BriefingCard({
  briefing,
  time,
  mark,
  onOpenFile,
}: {
  briefing: WorkBriefing
  time?: string
  mark?: string
  onOpenFile: (path: string, line?: number) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const preview =
    briefing.body
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  const facts = [
    briefing.wallMs != null ? t('work.duration', { value: formatBudget(briefing.wallMs, t) }) : '',
    briefing.maxTokens != null ? `token ${briefing.maxTokens.toLocaleString('en-US')}` : '',
    briefing.material ? t('work.material', { hash: briefing.material.slice(0, 8) }) : '',
  ].filter(Boolean)
  return (
    <div className="briefing-row" data-turn={mark}>
      <article className={open ? 'briefing-card open' : 'briefing-card'}>
        <button type="button" className="briefing-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span className="briefing-title">{briefing.cancel ? t('work.cancelTitle') : t('work.taskTitle')}</span>
          <span className="briefing-rev">{t('work.generation', { revision: String(briefing.revision) })}</span>
          <Chevron />
          {preview && !open ? <span className="briefing-preview">{preview}</span> : null}
        </button>
        <Collapse open={open}>
          <div className="briefing-body">
            {briefing.body ? <MarkdownView text={briefing.body} onOpenFile={onOpenFile} /> : null}
            {facts.length ? <p className="briefing-facts">{facts.join(' · ')}</p> : null}
            {briefing.notes.map(note => (
              <p key={note} className="briefing-note">
                {note}
              </p>
            ))}
          </div>
        </Collapse>
      </article>
      {time ? <time>{time}</time> : null}
    </div>
  )
}

function formatBudget(ms: number, t: ReturnType<typeof useI18n>['t']): string {
  if (ms % 60_000 === 0) return t('work.minutes', { count: String(ms / 60_000) })
  if (ms % 1000 === 0) return t('work.seconds', { count: String(ms / 1000) })
  return t('work.milliseconds', { count: String(ms) })
}

function Chevron() {
  return (
    <svg className="briefing-chevron" viewBox="0 0 16 16" aria-hidden="true">
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

export function WorkRefusal({ text }: { text: string }) {
  return <p className="work-refused">{text}</p>
}
