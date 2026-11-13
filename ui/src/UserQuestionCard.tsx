import { useEffect, useMemo, useRef, useState } from 'react'
import { redactText } from './activity.ts'
import { api } from './api.ts'
import { useI18n } from './locale'
import { MarkdownView } from './MarkdownView'
import type { ToolSegment } from './types'
import {
  approvalIntentOf,
  isAnswerableQuestion,
  localizedText,
  optionPresentation,
  planReviewOf,
  userQuestionView,
  type UserQuestionItem,
  type UserQuestionState,
} from './user-question'

const STATE_LABEL: Record<
  Exclude<UserQuestionState, 'open' | 'continued'>,
  'question.aborted' | 'question.failed' | 'question.answered'
> = {
  aborted: 'question.aborted',
  failed: 'question.failed',
  answered: 'question.answered',
}

type Draft = { selected: string[]; custom: string; skipped: boolean }

function emptyDraft(item: UserQuestionItem): Draft {
  return { selected: [...item.selected], custom: item.custom, skipped: item.skipped }
}

function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

function OptionList({
  item,
  draft,
  interactive,
  disabled,
  onToggle,
}: {
  item: UserQuestionItem
  draft: Draft
  interactive: boolean
  disabled: boolean
  onToggle: (label: string) => void
}) {
  const { t } = useI18n()
  if (!item.options.length) return null
  const chosen = new Set(draft.selected)
  return (
    <ul className="user-question-options">
      {item.options.map(option => {
        const selected = chosen.has(option.label)
        const presentation = optionPresentation(option.label, option.recommended)
        const className = selected ? 'user-question-option selected' : 'user-question-option'
        const body = (
          <>
            <span className="user-question-option-label">
              {redactText(option.label)}
              {presentation.recommended ? (
                <span className="user-question-badge">{t('question.recommended')}</span>
              ) : null}
            </span>
            {option.description ? (
              <span className="user-question-option-desc">{redactText(option.description)}</span>
            ) : null}
          </>
        )
        return (
          <li key={option.label}>
            {interactive ? (
              <button
                type="button"
                className={className}
                data-selected={selected ? 'true' : 'false'}
                aria-pressed={item.multiSelect ? selected : undefined}
                disabled={disabled}
                onClick={() => onToggle(option.label)}
              >
                {body}
              </button>
            ) : (
              <div className={className} data-selected={selected ? 'true' : 'false'}>
                {body}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function WaitLine({
  interactive,
  waitLabel,
  onTakeTime,
  busy,
}: {
  interactive: boolean
  waitLabel: string | null
  onTakeTime: () => void
  busy: boolean
}) {
  const { t } = useI18n()
  if (!waitLabel) return null
  return (
    <div className="user-question-wait">
      <p className="user-question-hint">{waitLabel}</p>
      {interactive && waitLabel !== t('question.continued') && waitLabel !== t('question.waitingNoTimer') ? (
        <button type="button" className="user-question-skip" disabled={busy} onClick={onTakeTime}>
          {t('question.takeTime')}
        </button>
      ) : null}
    </div>
  )
}

export function UserQuestionCard({
  segment,
  sessionId,
  onCompose,
  remainingMs,
  waitState,
}: {
  segment: ToolSegment
  sessionId?: string
  onCompose?: (text: string) => void
  remainingMs?: number
  waitState?: 'none' | 'counting' | 'waiting' | 'continued'
}) {
  const view = userQuestionView(segment)
  if (!view) return null
  if (view.presentation === 'plan-review') {
    return (
      <PlanReviewCard
        segment={segment}
        sessionId={sessionId}
        onCompose={onCompose}
        remainingMs={remainingMs}
        waitState={waitState}
      />
    )
  }
  if (view.presentation === 'approval') {
    return (
      <ApprovalIntentCard segment={segment} sessionId={sessionId} remainingMs={remainingMs} waitState={waitState} />
    )
  }
  return <GenericQuestionCard segment={segment} sessionId={sessionId} remainingMs={remainingMs} waitState={waitState} />
}

function useQuestionWait(
  sessionId: string | undefined,
  callId: string,
  view: ReturnType<typeof userQuestionView>,
  remainingMs?: number,
  waitState?: 'none' | 'counting' | 'waiting' | 'continued',
) {
  const { t } = useI18n()
  const answerable = Boolean(view && isAnswerableQuestion(view.state))
  const [held, setHeld] = useState(waitState === 'waiting' || view?.wait === 'waiting')
  const [continued, setContinued] = useState(waitState === 'continued' || view?.state === 'continued')
  const [left, setLeft] = useState<number | undefined>(remainingMs ?? view?.timeoutMs)
  const deadline = useRef<number | null>(null)
  const timed =
    (waitState === 'counting' || view?.wait === 'counting' || typeof (remainingMs ?? view?.timeoutMs) === 'number') &&
    !held &&
    !continued

  useEffect(() => {
    if (waitState === 'waiting') setHeld(true)
    if (waitState === 'continued' || view?.state === 'continued') setContinued(true)
    if (typeof remainingMs === 'number') {
      deadline.current = Date.now() + remainingMs
      setLeft(remainingMs)
    }
  }, [remainingMs, waitState, view?.state])

  useEffect(() => {
    if (!answerable || !timed) return
    const start = remainingMs ?? left ?? view?.timeoutMs
    if (typeof start !== 'number') return
    if (deadline.current == null) deadline.current = Date.now() + start
    const tick = () => {
      const next = Math.max(0, (deadline.current ?? Date.now()) - Date.now())
      setLeft(next)
      if (next <= 0) {
        setContinued(true)
        if (sessionId) {
          void api('/questions/timeout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, callId }),
          })
        }
        return false
      }
      return true
    }
    if (!tick()) return
    const id = window.setInterval(() => {
      if (!tick()) window.clearInterval(id)
    }, 250)
    return () => window.clearInterval(id)
  }, [answerable, timed, sessionId, callId, remainingMs, left, view?.timeoutMs])

  async function takeTime() {
    setHeld(true)
    deadline.current = null
    if (!sessionId) return
    await api('/questions/take-time', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, callId }),
    })
  }

  const waitLabel = continued
    ? t('question.continued')
    : held
      ? t('question.waitingNoTimer')
      : timed && typeof left === 'number'
        ? t('question.remaining', { time: formatRemaining(left) })
        : null

  return { answerable, held, continued, waitLabel, takeTime, markHeld: () => setHeld(true) }
}

function GenericQuestionCard({
  segment,
  sessionId,
  remainingMs,
  waitState,
}: {
  segment: ToolSegment
  sessionId?: string
  remainingMs?: number
  waitState?: 'none' | 'counting' | 'waiting' | 'continued'
}) {
  const { t } = useI18n()
  const view = userQuestionView(segment)!
  const wait = useQuestionWait(sessionId, view.callId, view, remainingMs, waitState)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const items = view.questions
  const draftOf = useMemo(() => {
    const next: Record<string, Draft> = {}
    for (const item of items) next[item.id] = drafts[item.id] ?? emptyDraft(item)
    return next
  }, [drafts, items])
  const interactive = Boolean(sessionId) && wait.answerable
  const needsBatch = items.length > 1 || items.some(item => item.multiSelect || item.options.length === 0)

  function update(id: string, patch: Partial<Draft>) {
    wait.markHeld()
    setDrafts(current => {
      const item = items.find(entry => entry.id === id)
      const base = current[id] ?? (item ? emptyDraft(item) : { selected: [], custom: '', skipped: false })
      return { ...current, [id]: { ...base, ...patch } }
    })
  }

  async function submit(answers: Array<{ id: string; selected: string[]; custom?: string }>) {
    if (!sessionId || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await api('/questions/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, callId: view.callId, answers }),
      })
      if (response.status === 200 && response.body.ok !== false) return
      if (response.status === 409) return
      const message = typeof response.body.message === 'string' ? response.body.message : t('question.submitFailed')
      setError(message)
    } catch {
      setError(t('question.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  function completeItem(
    item: UserQuestionItem,
    draft: Draft,
  ): { id: string; selected: string[]; custom?: string } | null {
    if (draft.skipped) return { id: item.id, selected: [] }
    if (draft.custom.trim() && (item.multiSelect || draft.selected.length === 0 || item.options.length === 0)) {
      return item.multiSelect
        ? { id: item.id, selected: draft.selected, custom: draft.custom }
        : { id: item.id, selected: [], custom: draft.custom }
    }
    if (draft.selected.length) return { id: item.id, selected: [...draft.selected] }
    return null
  }

  function submitDrafts() {
    const answers = items.map(item => completeItem(item, draftOf[item.id] ?? emptyDraft(item)))
    if (answers.some(item => item == null)) {
      setError(t('question.incomplete'))
      return
    }
    void submit(answers as Array<{ id: string; selected: string[]; custom?: string }>)
  }

  function toggle(item: UserQuestionItem, label: string) {
    if (!interactive || busy) return
    if (!item.multiSelect && items.length === 1 && !draftOf[item.id]?.custom) {
      void submit([{ id: item.id, selected: [label] }])
      return
    }
    const current = draftOf[item.id] ?? emptyDraft(item)
    const selected = item.multiSelect
      ? current.selected.includes(label)
        ? current.selected.filter(value => value !== label)
        : [...current.selected, label]
      : [label]
    update(item.id, { selected, skipped: false, custom: item.multiSelect ? current.custom : '' })
  }

  return (
    <section
      className="user-question-card"
      data-segment={segment.id}
      data-state={wait.continued ? 'continued' : view.state}
      data-call={view.callId}
      data-session={sessionId || undefined}
      data-kind="question"
    >
      <WaitLine
        interactive={interactive}
        waitLabel={wait.waitLabel}
        onTakeTime={() => void wait.takeTime()}
        busy={busy}
      />
      {view.questions.map(item => {
        const draft = draftOf[item.id] ?? emptyDraft(item)
        return (
          <article key={item.id} className="user-question" data-question={item.id}>
            {item.header ? <h3 className="user-question-header">{redactText(item.header)}</h3> : null}
            <p className="user-question-text">{redactText(item.question)}</p>
            {item.detail ? <p className="user-question-hint">{redactText(item.detail)}</p> : null}
            {item.multiSelect && wait.answerable ? (
              <p className="user-question-hint">{t('question.multiSelect')}</p>
            ) : null}
            <OptionList
              item={item}
              draft={wait.answerable ? draft : { selected: item.selected, custom: item.custom, skipped: item.skipped }}
              interactive={interactive}
              disabled={busy}
              onToggle={label => toggle(item, label)}
            />
            {interactive ? (
              <div className="user-question-actions">
                <label className="user-question-custom">
                  <span>{t('question.customLabel')}</span>
                  <textarea
                    value={draft.custom}
                    disabled={busy}
                    rows={2}
                    placeholder={t('question.customPlaceholder')}
                    onChange={event => update(item.id, { custom: event.target.value, skipped: false })}
                  />
                </label>
                <button
                  type="button"
                  className="user-question-skip"
                  disabled={busy}
                  onClick={() => {
                    if (items.length === 1) {
                      void submit([{ id: item.id, selected: [] }])
                      return
                    }
                    update(item.id, { skipped: true, selected: [], custom: '' })
                  }}
                >
                  {t('question.skip')}
                </button>
              </div>
            ) : null}
            {!interactive && item.custom ? (
              <p className="user-question-hint">{t('question.custom', { text: redactText(item.custom) })}</p>
            ) : null}
            {(item.skipped || draft.skipped) && (view.state !== 'open' || interactive) ? (
              <p className="user-question-hint">{t('question.skipped')}</p>
            ) : null}
          </article>
        )
      })}
      {interactive && (needsBatch || items.some(item => (draftOf[item.id]?.custom ?? '').trim() !== '')) ? (
        <button type="button" className="user-question-submit" disabled={busy} onClick={submitDrafts}>
          {busy ? t('question.submitting') : t('question.submit')}
        </button>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
      {!wait.answerable && view.state !== 'open' && view.state !== 'continued' ? (
        <p className={view.state === 'answered' ? 'user-question-status' : 'user-question-status exception'}>
          {t(STATE_LABEL[view.state])}
        </p>
      ) : null}
    </section>
  )
}

function PlanReviewCard({
  segment,
  sessionId,
  onCompose,
  remainingMs,
  waitState,
}: {
  segment: ToolSegment
  sessionId?: string
  onCompose?: (text: string) => void
  remainingMs?: number
  waitState?: 'none' | 'counting' | 'waiting' | 'continued'
}) {
  const { t } = useI18n()
  const view = userQuestionView(segment)!
  const review = planReviewOf(view.questions)!
  const wait = useQuestionWait(sessionId, view.callId, view, remainingMs, waitState)
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const interactive = Boolean(sessionId) && wait.answerable
  const selected = review.item.selected[0]
  const approved = selected === review.approve.label

  async function approve() {
    if (!sessionId || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await api('/questions/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          callId: view.callId,
          answers: [{ id: review.item.id, selected: [review.approve.label] }],
        }),
      })
      if (response.status === 200 && response.body.ok !== false) return
      if (response.status === 409) return
      setError(typeof response.body.message === 'string' ? response.body.message : t('question.submitFailed'))
    } catch {
      setError(t('question.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function requestChanges() {
    if (!sessionId || busy) return
    const text = comments.trim()
    if (!text) {
      setError(t('question.changesNeeded'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await api('/questions/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, callId: view.callId }),
      })
      if (response.status === 200 && response.body.ok !== false) {
        onCompose?.(text)
        return
      }
      if (response.status === 409) {
        onCompose?.(text)
        return
      }
      setError(typeof response.body.message === 'string' ? response.body.message : t('question.submitFailed'))
    } catch {
      setError(t('question.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="user-question-card"
      data-segment={segment.id}
      data-state={wait.continued ? 'continued' : view.state}
      data-call={view.callId}
      data-session={sessionId || undefined}
      data-kind="plan-review"
    >
      <h3 className="user-question-header">{t('question.planTitle')}</h3>
      <p className="user-question-text">{redactText(review.item.question)}</p>
      <WaitLine
        interactive={interactive}
        waitLabel={wait.waitLabel}
        onTakeTime={() => void wait.takeTime()}
        busy={busy}
      />
      {review.plan ? (
        open ? (
          <div className="user-question-plan">
            <MarkdownView text={review.plan} />
          </div>
        ) : (
          <p className="user-question-hint">
            {redactText(review.plan).split('\n').filter(Boolean).slice(0, 2).join(' ')}
          </p>
        )
      ) : null}
      {review.plan ? (
        <button type="button" className="user-question-skip" onClick={() => setOpen(value => !value)}>
          {open ? t('question.hidePlan') : t('question.viewFull')}
        </button>
      ) : null}
      {interactive ? (
        <div className="user-question-actions">
          <label className="user-question-custom">
            <span>{t('question.changeComments')}</span>
            <textarea
              value={comments}
              disabled={busy}
              rows={3}
              placeholder={t('question.changePlaceholder')}
              onChange={event => {
                wait.markHeld()
                setComments(event.target.value)
              }}
            />
          </label>
          <div className="user-question-row">
            <button type="button" className="user-question-skip" disabled={busy} onClick={() => void requestChanges()}>
              {t('question.requestChanges')}
            </button>
            <button type="button" className="user-question-submit" disabled={busy} onClick={() => void approve()}>
              {busy ? t('question.submitting') : t('question.approvePlan')}
            </button>
          </div>
        </div>
      ) : selected ? (
        <p className="user-question-status">{approved ? t('question.approvePlan') : redactText(selected)}</p>
      ) : view.state === 'aborted' ? (
        <p className="user-question-status exception">{t('question.aborted')}</p>
      ) : view.state === 'failed' ? (
        <p className="user-question-status exception">{t('question.failed')}</p>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </section>
  )
}

function ApprovalIntentCard({
  segment,
  sessionId,
  remainingMs,
  waitState,
}: {
  segment: ToolSegment
  sessionId?: string
  remainingMs?: number
  waitState?: 'none' | 'counting' | 'waiting' | 'continued'
}) {
  const { t, locale } = useI18n()
  const view = userQuestionView(segment)!
  const approval = approvalIntentOf(view.questions)!
  const wait = useQuestionWait(sessionId, view.callId, view, remainingMs, waitState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const interactive = Boolean(sessionId) && wait.answerable
  const question = localizedText(approval.intent.display?.question, locale, approval.item.question)
  const detail = localizedText(approval.intent.display?.detail, locale, approval.item.detail)
  const approveLabel = localizedText(approval.intent.display?.approve, locale, approval.approve.label)
  const chosen = approval.item.selected[0]

  async function choose(label: string) {
    if (!sessionId || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await api('/questions/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          callId: view.callId,
          answers: [{ id: approval.item.id, selected: [label] }],
        }),
      })
      if (response.status === 200 && response.body.ok !== false) return
      if (response.status === 409) return
      setError(typeof response.body.message === 'string' ? response.body.message : t('question.submitFailed'))
    } catch {
      setError(t('question.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="user-question-card"
      data-segment={segment.id}
      data-state={wait.continued ? 'continued' : view.state}
      data-call={view.callId}
      data-session={sessionId || undefined}
      data-kind="approval"
    >
      {approval.intent.subject?.name ? (
        <h3 className="user-question-header">{redactText(approval.intent.subject.name)}</h3>
      ) : null}
      <p className="user-question-text">{redactText(question)}</p>
      {detail ? <p className="user-question-hint">{redactText(detail)}</p> : null}
      <WaitLine
        interactive={interactive}
        waitLabel={wait.waitLabel}
        onTakeTime={() => void wait.takeTime()}
        busy={busy}
      />
      {interactive ? (
        <div className="user-question-row">
          <button
            type="button"
            className="user-question-skip"
            disabled={busy}
            onClick={() => void choose(approval.reject.label)}
          >
            {t('question.reject')}
          </button>
          <button
            type="button"
            className="user-question-submit"
            disabled={busy}
            onClick={() => void choose(approval.approve.label)}
          >
            {busy ? t('question.submitting') : redactText(approveLabel) || t('question.allow')}
          </button>
          {approval.always ? (
            <button
              type="button"
              className="user-question-submit"
              disabled={busy}
              onClick={() => void choose(approval.always!.label)}
            >
              {t('question.alwaysAllow')}
            </button>
          ) : null}
        </div>
      ) : chosen ? (
        <p className="user-question-status">{t('question.approvalAnswered')}</p>
      ) : view.state === 'aborted' ? (
        <p className="user-question-status exception">{t('question.aborted')}</p>
      ) : view.state === 'failed' ? (
        <p className="user-question-status exception">{t('question.failed')}</p>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </section>
  )
}
