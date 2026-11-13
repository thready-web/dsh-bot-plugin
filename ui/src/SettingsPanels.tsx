import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.ts'
import { useI18n } from './locale'
import { createAuthorizationCatalog } from './interaction-sync'
import { presetDisplayName } from './permission-label.ts'

type PermissionOption = { value: string; name: string; description?: string }

type PermissionBody = {
  available?: boolean
  currentValue?: string
  options?: PermissionOption[]
  autoAvailable?: boolean
  message?: string
}

export function SettingsDrawer({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const node = (
    <div className="settings-drawer">
      <div className="settings-drawer-mask" onClick={onClose} />
      <div className="settings-drawer-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="settings-drawer-handle" aria-hidden="true" />
        <div className="settings-head">
          <h3>{title}</h3>
          <button type="button" className="user-question-skip" onClick={onClose}>
            {closeLabel}
          </button>
        </div>
        <div className="settings-drawer-body">{children}</div>
      </div>
    </div>
  )
  if (typeof document === 'undefined' || !document.body) return node
  return createPortal(node, document.body)
}

export function PermissionPanel({
  sessionId,
  current,
  onClose,
  onChanged,
}: {
  sessionId: string
  current?: string
  onClose: () => void
  onChanged?: (value: string) => void
}) {
  const { t } = useI18n()
  const [view, setView] = useState<PermissionBody | null>(null)
  const [confirm, setConfirm] = useState<PermissionOption | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api(`/permissions?sessionId=${encodeURIComponent(sessionId)}`).then(response => setView(response.body))
  }, [sessionId])

  async function apply(name: string) {
    setBusy(true)
    setError('')
    try {
      const response = await api('/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, name }),
      })
      if (response.status === 200 && response.body.ok !== false) {
        setView(response.body)
        setConfirm(null)
        if (typeof response.body.currentValue === 'string') onChanged?.(response.body.currentValue)
        return
      }
      setError(typeof response.body.message === 'string' ? response.body.message : t('permission.failed'))
    } catch {
      setError(t('permission.failed'))
    } finally {
      setBusy(false)
    }
  }

  function choose(option: PermissionOption) {
    if (option.value === view?.currentValue || option.value === 'custom') return
    if (option.value === 'danger-full-access' || option.value === 'auto') {
      setConfirm(option)
      return
    }
    void apply(option.value)
  }

  const options = view?.options ?? []

  const currentOption = options.find(option => option.value === (view?.currentValue ?? current))

  return (
    <SettingsDrawer title={t('permission.title')} closeLabel={t('permission.close')} onClose={onClose}>
      {view && view.available === false ? <p className="user-question-hint">{t('permission.unavailable')}</p> : null}
      {view?.currentValue || current ? (
        <p className="user-question-hint">
          {t('permission.current')}:{' '}
          {presetDisplayName(view?.currentValue ?? current ?? '', currentOption?.name, t) || '—'}
        </p>
      ) : null}
      <ul className="user-question-options">
        {options.map(option => (
          <li key={option.value}>
            <button
              type="button"
              className={option.value === view?.currentValue ? 'user-question-option selected' : 'user-question-option'}
              disabled={busy || option.value === 'custom'}
              onClick={() => choose(option)}
            >
              <span className="user-question-option-label">{presetDisplayName(option.value, option.name, t)}</span>
              {option.description ? <span className="user-question-option-desc">{option.description}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {confirm ? (
        <div className="settings-confirm">
          <p className="user-question-text">{t('permission.confirmTitle')}</p>
          <p className="user-question-hint">
            {confirm.value === 'auto' ? t('permission.confirmAuto') : t('permission.confirmFull')}
          </p>
          <div className="user-question-row">
            <button type="button" className="user-question-skip" disabled={busy} onClick={() => setConfirm(null)}>
              {t('permission.cancel')}
            </button>
            <button
              type="button"
              className="user-question-submit"
              disabled={busy}
              onClick={() => void apply(confirm.value)}
            >
              {t('permission.confirm')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </SettingsDrawer>
  )
}

type AuthPrompt = {
  promptId: string
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string; description?: string }>
}

type AuthEntry = {
  key: unknown
  label: string
  methods: Array<{ id: string; label: string }>
  inFlight: boolean
}

type AuthNotice = { message: string; url?: string; code?: string }

export function AuthorizationPanel({
  onClose,
  authorization,
  catalog,
}: {
  onClose: () => void
  authorization?: Record<string, unknown>
  catalog?: ReturnType<typeof createAuthorizationCatalog>
}) {
  const { t } = useI18n()
  const [available, setAvailable] = useState(true)
  const [entries, setEntries] = useState<AuthEntry[]>([])
  const [notices, setNotices] = useState<AuthNotice[]>([])
  const [prompts, setPrompts] = useState<AuthPrompt[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [localCatalog] = useState(() =>
    createAuthorizationCatalog(async () => {
      const response = await api('/authorization')
      if (response.status !== 200) throw new Error('Authorization catalog unavailable')
      return response.body
    }),
  )
  const directory = catalog ?? localCatalog
  const mounted = useRef(true)
  const generation = useRef(0)
  async function refresh(invalidate = false) {
    if (document.hidden) return
    if (invalidate) directory.invalidate()
    const request = ++generation.current
    try {
      const body = await directory.get()
      if (!mounted.current || request !== generation.current) return
      setAvailable(body.available !== false)
      setEntries(Array.isArray(body.entries) ? (body.entries as AuthEntry[]) : [])
      if (!authorization) {
        setNotices(Array.isArray(body.notices) ? (body.notices as AuthNotice[]) : [])
        setPrompts(Array.isArray(body.prompts) ? (body.prompts as AuthPrompt[]) : [])
      }
    } catch {
      if (mounted.current && request === generation.current) setError(t('auth.failed'))
    }
  }
  useEffect(() => {
    if (!authorization) return
    setAvailable(authorization.available !== false)
    if (
      (Array.isArray(authorization.prompts) && authorization.prompts.length > 0) ||
      (Array.isArray(authorization.inFlight) && authorization.inFlight.length > 0)
    )
      setBusy(false)
    setNotices(Array.isArray(authorization.notices) ? (authorization.notices as AuthNotice[]) : [])
    setPrompts(Array.isArray(authorization.prompts) ? (authorization.prompts as AuthPrompt[]) : [])
  }, [authorization])
  useEffect(() => {
    mounted.current = true
    void refresh()
    // Native catalog registration has no reliable change hook. Revalidate only
    // while the drawer is visible, and on resume/flow changes (not every token).
    const resume = () => {
      if (!document.hidden) void refresh(true)
    }
    const id = window.setInterval(() => void refresh(), 30_000)
    document.addEventListener('visibilitychange', resume)
    return () => {
      mounted.current = false
      generation.current++
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [directory, authorization?.catalogRevision])

  async function begin(entry: AuthEntry, method?: string) {
    setBusy(true)
    setError('')
    try {
      const response = await api('/authorization/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: entry.key, method }),
      })
      if (response.status !== 200 || response.body.ok === false) {
        setError(typeof response.body.message === 'string' ? response.body.message : t('auth.failed'))
      }
      await refresh(true)
    } catch {
      setError(t('auth.failed'))
    } finally {
      setBusy(false)
    }
  }

  async function answer(prompt: AuthPrompt, declined = false, value?: string) {
    setBusy(true)
    setError('')
    try {
      const response = await api('/authorization/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promptId: prompt.promptId,
          value: declined ? undefined : (value ?? drafts[prompt.promptId] ?? ''),
          declined,
        }),
      })
      if (response.status !== 200 || response.body.ok === false) {
        setError(typeof response.body.message === 'string' ? response.body.message : t('auth.failed'))
      }
      await refresh(true)
    } catch {
      setError(t('auth.failed'))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(entry: AuthEntry) {
    setBusy(true)
    try {
      await api('/authorization/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: entry.key }),
      })
      await refresh(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsDrawer title={t('auth.title')} closeLabel={t('auth.close')} onClose={onClose}>
      {!available ? <p className="user-question-hint">{t('auth.unavailable')}</p> : null}
      {available && entries.length === 0 && prompts.length === 0 ? (
        <p className="user-question-hint">{t('auth.empty')}</p>
      ) : null}
      {notices.map((notice, index) => (
        <p key={`${notice.message}-${index}`} className="user-question-hint">
          {notice.message}
          {notice.code ? ` · ${notice.code}` : ''}
          {notice.url ? (
            <>
              {' '}
              <a href={notice.url} target="_blank" rel="noreferrer">
                {notice.url}
              </a>
            </>
          ) : null}
        </p>
      ))}
      {prompts.map(prompt => (
        <article key={prompt.promptId} className="user-question">
          <p className="user-question-text">{prompt.message}</p>
          {prompt.kind === 'select' ? (
            <ul className="user-question-options">
              {(prompt.options ?? []).map(option => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="user-question-option"
                    disabled={busy}
                    onClick={() => void answer(prompt, false, option.id)}
                  >
                    <span className="user-question-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="user-question-option-desc">{option.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : prompt.kind === 'secret' ? (
            <label className="user-question-custom">
              <span className="user-question-secret">{t('auth.secretMask')}</span>
              <input
                type="text"
                className="user-question-secret-input"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={drafts[prompt.promptId] ?? ''}
                placeholder={prompt.placeholder}
                disabled={busy}
                onChange={event => setDrafts(current => ({ ...current, [prompt.promptId]: event.target.value }))}
              />
            </label>
          ) : (
            <label className="user-question-custom">
              <input
                type="text"
                value={drafts[prompt.promptId] ?? ''}
                placeholder={prompt.placeholder}
                disabled={busy}
                onChange={event => setDrafts(current => ({ ...current, [prompt.promptId]: event.target.value }))}
              />
            </label>
          )}
          <div className="user-question-row">
            <button
              type="button"
              className="user-question-skip"
              disabled={busy}
              onClick={() => void answer(prompt, true)}
            >
              {t('auth.cancel')}
            </button>
            {prompt.kind !== 'select' ? (
              <button
                type="button"
                className="user-question-submit"
                disabled={busy || (prompt.kind !== 'secret' && !(drafts[prompt.promptId] ?? '').trim())}
                onClick={() => void answer(prompt)}
              >
                {t('auth.writeVault')}
              </button>
            ) : null}
          </div>
        </article>
      ))}
      {entries.map(original => {
        const entry = {
          ...original,
          inFlight:
            original.inFlight ||
            (Array.isArray(authorization?.inFlight) &&
              authorization.inFlight.some(key => JSON.stringify(key) === JSON.stringify(original.key))),
        }
        return (
          <article key={JSON.stringify(entry.key)} className="user-question">
            <p className="user-question-text">{entry.label}</p>
            <div className="user-question-row">
              {entry.methods.map(method => (
                <button
                  key={method.id}
                  type="button"
                  className="user-question-submit"
                  disabled={busy || entry.inFlight}
                  onClick={() => void begin(entry, method.id)}
                >
                  {method.label || t('auth.start')}
                </button>
              ))}
              {entry.inFlight ? (
                <button type="button" className="user-question-skip" disabled={busy} onClick={() => void cancel(entry)}>
                  {t('auth.cancel')}
                </button>
              ) : null}
            </div>
          </article>
        )
      })}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </SettingsDrawer>
  )
}

type CuaGrant = { id: string; name: string; executablePath?: string }

export function CuaPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n()
  const [available, setAvailable] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [system, setSystem] = useState<{ accessibility?: boolean; screenRecording?: boolean } | null>(null)
  const [allowed, setAllowed] = useState<CuaGrant[]>([])
  const [blocked, setBlocked] = useState<CuaGrant[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const response = await api(`/cua?locale=${encodeURIComponent(locale)}`)
    setLoaded(true)
    setAvailable(response.body.available === true)
    const status = response.body.systemStatus
    setSystem(
      status && typeof status === 'object' ? (status as { accessibility?: boolean; screenRecording?: boolean }) : null,
    )
    const applications = response.body.applications
    if (applications && typeof applications === 'object') {
      const row = applications as { allowedApps?: CuaGrant[]; blockedApps?: CuaGrant[] }
      setAllowed(Array.isArray(row.allowedApps) ? row.allowedApps : [])
      setBlocked(Array.isArray(row.blockedApps) ? row.blockedApps : [])
    }
  }

  useEffect(() => {
    void refresh()
  }, [locale])

  async function run(action: string, extra: Record<string, string> = {}) {
    setBusy(true)
    setError('')
    try {
      const response = await api('/cua', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, locale, ...extra }),
      })
      if (response.status !== 200 || response.body.ok === false) {
        setError(typeof response.body.message === 'string' ? response.body.message : t('cua.failed'))
      }
      await refresh()
    } catch {
      setError(t('cua.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (loaded && !available) return null

  return (
    <SettingsDrawer title={t('cua.title')} closeLabel={t('cua.close')} onClose={onClose}>
      <h4 className="user-question-header">{t('cua.system')}</h4>
      {(['accessibility', 'screenRecording'] as const).map(permission => (
        <div key={permission} className="user-question-row">
          <p className="user-question-text">
            {t(permission === 'accessibility' ? 'cua.accessibility' : 'cua.screenRecording')}
            <span className="user-question-hint">{system?.[permission] ? t('cua.granted') : t('cua.missing')}</span>
          </p>
          <button
            type="button"
            className="user-question-submit"
            disabled={busy}
            onClick={() => void run('requestPermission', { permission })}
          >
            {t('cua.request')}
          </button>
          <button
            type="button"
            className="user-question-skip"
            disabled={busy}
            onClick={() => void run('openSettings', { permission })}
          >
            {t('cua.openSettings')}
          </button>
        </div>
      ))}
      <h4 className="user-question-header">{t('cua.grants')}</h4>
      {allowed.length === 0 ? <p className="user-question-hint">{t('cua.emptyGrants')}</p> : null}
      {allowed.map(app => (
        <div key={app.id} className="user-question-row">
          <p className="user-question-text">{app.name}</p>
          <button
            type="button"
            className="user-question-skip"
            disabled={busy}
            onClick={() => void run('revoke', { id: app.id })}
          >
            {t('cua.revoke')}
          </button>
        </div>
      ))}
      <h4 className="user-question-header">{t('cua.blocked')}</h4>
      {blocked.length === 0 ? <p className="user-question-hint">{t('cua.emptyBlocked')}</p> : null}
      {blocked.map(app => (
        <div key={app.id} className="user-question-row">
          <p className="user-question-text">{app.name}</p>
          <button
            type="button"
            className="user-question-submit"
            disabled={busy}
            onClick={() => void run('retryApproval', { id: app.id })}
          >
            {t('cua.askAgain')}
          </button>
        </div>
      ))}
      {error ? <p className="user-question-status exception">{error}</p> : null}
    </SettingsDrawer>
  )
}
