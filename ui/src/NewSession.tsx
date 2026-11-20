import { useEffect, useState } from 'react'
import { api } from './api'
import { botFields, composeBotPersona, foundations, foundationsError } from './foundations'
import { useI18n } from './locale'

export function NewSessionSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (sessionId: string, note: string, name: string) => void
}) {
  const [name, setName] = useState('')
  const [style, setStyle] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { locale, setLocale, t: text } = useI18n()

  function patchName(value: string) {
    setName(value)
  }

  async function submit() {
    if (busy) return
    const botName = name.trim()
    if (botName === '') {
      setError(text('new.nameRequired'))
      return
    }
    setBusy(true)
    setError('')
    const created = await api('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ name: botName }),
    })
    const sessionId = typeof created.body.sessionId === 'string' ? created.body.sessionId : ''
    if (!sessionId) {
      const upstream = created.body.upstream as { message?: string } | undefined
      setError(upstream?.message || String(created.body.error || text('new.createFailed')))
      setBusy(false)
      return
    }
    const personaText = composeBotPersona(botName, style, task)
    const opened = await foundations('/dsh-bot/api/sessions/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, personaText, idempotencyKey: crypto.randomUUID() }),
    })
    if (opened.body.ok !== true) {
      setError(foundationsError(opened.body, text('new.personaFailed')))
      setBusy(false)
      return
    }
    const kickoff = task.trim() || text('new.kickoff')
    const prompted = await api('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId, text: kickoff }),
    })
    if (prompted.status !== 202) {
      const execution = prompted.body.execution as { reason?: string } | undefined
      const taskRecord = prompted.body.task as { reason?: string } | undefined
      setError(execution?.reason || taskRecord?.reason || text('new.turnFailed'))
      setBusy(false)
      return
    }
    onCreated(sessionId, text('new.created', { name: botName }), botName)
  }

  return (
    <div className="setup-mask" role="presentation" onMouseDown={onClose}>
      <form
        className="setup-card"
        role="dialog"
        aria-labelledby="new-session-title"
        onMouseDown={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="setup-head">
          <h2 id="new-session-title">{text('new.title')}</h2>
          <button type="button" className="setup-close" aria-label={text('new.close')} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="setup-lead">{text('new.lead')}</p>
        <label htmlFor="setup-name">{text('new.name')}</label>
        <input
          id="setup-name"
          value={name}
          placeholder={text('new.namePlaceholder')}
          onChange={event => patchName(event.target.value)}
        />
        <label htmlFor="setup-style">{text('new.style')}</label>
        <input
          id="setup-style"
          value={style}
          placeholder={text('new.stylePlaceholder')}
          onChange={event => setStyle(event.target.value)}
        />
        <label htmlFor="setup-task">{text('new.task')}</label>
        <textarea
          id="setup-task"
          rows={3}
          value={task}
          placeholder={text('new.taskPlaceholder')}
          onChange={event => setTask(event.target.value)}
        />
        {error ? <p className="setup-error">{error}</p> : null}
        <div className="setup-actions">
          <button type="button" onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>
            {text('lang.switch')}
          </button>
          <button type="button" onClick={onClose}>
            {text('new.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || name.trim() === ''}>
            {busy ? text('new.creating') : text('new.create')}
          </button>
        </div>
      </form>
    </div>
  )
}

export function useSessionBasis(sessionId: string, revision: number): string {
  const { t } = useI18n()
  const [line, setLine] = useState('')
  useEffect(() => {
    if (sessionId === '') {
      setLine('')
      return
    }
    let stop = false
    void (async () => {
      const status = await foundations(`/dsh-bot/api/status?sessionId=${encodeURIComponent(sessionId)}`)
      const memory = await foundations(`/dsh-bot/api/memory?sessionId=${encodeURIComponent(sessionId)}`)
      if (stop || status.body.ok !== true) return
      const binding = status.body.binding
      const kind = binding && typeof binding === 'object' ? (binding as { kind?: string }).kind : status.body.kind
      if (kind !== 'bot') {
        setLine(t('basis.plain'))
        return
      }
      const text = typeof status.body.personaText === 'string' ? status.body.personaText.trim() : ''
      const fields = botFields(text)
      const head = [fields.name, fields.style, fields.task].filter(part => part !== '').join(' · ')
      const facts = Array.isArray(memory.body.facts) ? memory.body.facts : []
      const active = facts.filter(
        item => item && typeof item === 'object' && (item as { status?: string }).status === 'active',
      ).length
      setLine(active > 0 ? t('basis.facts', { head: head || 'BOT', count: String(active) }) : head || 'BOT')
    })()
    return () => {
      stop = true
    }
  }, [sessionId, revision, t])
  return line
}
