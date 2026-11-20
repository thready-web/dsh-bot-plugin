import { useState } from 'react'
import { api } from './api.ts'
import { useI18n } from './locale'
import type { ToolApprovalView } from './tool-approval'

export type { ToolApprovalView } from './tool-approval'

export function ToolApprovalCard({ approval, sessionId }: { approval: ToolApprovalView; sessionId?: string }) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState(approval.state)
  const shown = state === 'recorded' ? approval.state : state
  const interactive = Boolean(sessionId) && shown === 'open'
  const reason =
    locale.startsWith('zh') && approval.displayReason?.zh
      ? approval.displayReason.zh
      : approval.displayReason?.en || approval.reason

  async function decide(outcome: 'allowed-once' | 'rejected') {
    if (!sessionId || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await api('/approvals/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, requestId: approval.requestId, outcome }),
      })
      if (response.status === 200 && response.body.ok !== false) {
        setState(outcome)
        return
      }
      if (response.status === 409) {
        setState(outcome)
        return
      }
      setError(typeof response.body.message === 'string' ? response.body.message : t('approval.submitFailed'))
    } catch {
      setError(t('approval.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  const status =
    shown === 'allowed-once'
      ? t('approval.allowed')
      : shown === 'rejected'
        ? t('approval.rejected')
        : shown === 'cancelled'
          ? t('approval.cancelled')
          : shown === 'unavailable'
            ? t('approval.failed')
            : null

  return (
    <section
      className="user-question-card"
      data-kind="tool-approval"
      data-state={shown}
      data-request={approval.requestId}
      data-session={sessionId || undefined}
    >
      <h3 className="user-question-header">{t('approval.title')}</h3>
      <p className="user-question-text">{approval.toolName}</p>
      {reason ? <p className="user-question-hint">{reason}</p> : null}
      {interactive ? (
        <div className="user-question-row">
          <button type="button" className="user-question-skip" disabled={busy} onClick={() => void decide('rejected')}>
            {t('approval.reject')}
          </button>
          <button
            type="button"
            className="user-question-submit"
            disabled={busy}
            onClick={() => void decide('allowed-once')}
          >
            {busy ? t('question.submitting') : t('approval.allowOnce')}
          </button>
        </div>
      ) : status ? (
        <p className={state === 'allowed-once' ? 'user-question-status' : 'user-question-status exception'}>{status}</p>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </section>
  )
}
