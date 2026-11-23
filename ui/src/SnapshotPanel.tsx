import { useCallback, useEffect, useState } from 'react'
import { SettingsDrawer } from './SettingsPanels'
import { isWorkerSession } from './work'
import { useI18n } from './locale'

type SnapshotItem = {
  snapshotId: string
  sourceSessionId: string
  createdAt: string
  throughSeq: number
  count: number
  sha256: string
  bytes: number
}

async function backupJson(
  path: string,
  options?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', ...(options?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
}

function asSnapshots(value: unknown): SnapshotItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is SnapshotItem => {
    if (!item || typeof item !== 'object') return false
    const row = item as SnapshotItem
    return typeof row.snapshotId === 'string' && typeof row.createdAt === 'string'
  })
}

export function SnapshotPanel({
  sessionId,
  isBot,
  onClose,
}: {
  sessionId: string
  isBot: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const worker = isWorkerSession(sessionId)
  const allowed = sessionId !== '' && isBot && !worker
  const [items, setItems] = useState<SnapshotItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!allowed) return
    setLoading(true)
    setError('')
    try {
      const response = await backupJson(`/api/dsh-bot/backups?sessionId=${encodeURIComponent(sessionId)}`)
      if (response.status !== 200) {
        setError(typeof response.body.message === 'string' ? response.body.message : t('snapshot.failed'))
        setItems([])
        return
      }
      setItems(asSnapshots(response.body.snapshots))
    } catch {
      setError(t('snapshot.failed'))
    } finally {
      setLoading(false)
    }
  }, [allowed, sessionId, t])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    if (!allowed || creating) return
    setCreating(true)
    setError('')
    try {
      const response = await backupJson(`/api/dsh-bot/backups?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (response.status !== 201) {
        setError(typeof response.body.message === 'string' ? response.body.message : t('snapshot.createFailed'))
        return
      }
      await load()
    } catch {
      setError(t('snapshot.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <SettingsDrawer title={t('snapshot.title')} closeLabel={t('snapshot.close')} onClose={onClose}>
      <p className="user-question-hint">{t('snapshot.scope')}</p>
      <p className="user-question-hint">{t('snapshot.sensitive')}</p>
      {!allowed ? (
        <p className="user-question-hint">{worker ? t('snapshot.worker') : t('snapshot.ordinary')}</p>
      ) : (
        <div className="user-question-row">
          <button type="button" className="user-question-send" disabled={creating} onClick={() => void create()}>
            {creating ? t('snapshot.creating') : t('snapshot.create')}
          </button>
          <button
            type="button"
            className="user-question-skip"
            disabled={loading || creating}
            onClick={() => void load()}
          >
            {t('snapshot.refresh')}
          </button>
        </div>
      )}
      {error ? <p className="user-question-hint">{error}</p> : null}
      {allowed && loading && items.length === 0 ? <p className="user-question-hint">{t('snapshot.loading')}</p> : null}
      {allowed && !loading && items.length === 0 && !error ? (
        <p className="user-question-hint">{t('snapshot.empty')}</p>
      ) : null}
      <ul className="user-question-list">
        {items.map(item => (
          <li key={item.snapshotId} className="user-question-row">
            <div>
              <p className="user-question-text">{item.snapshotId}</p>
              <p className="user-question-hint">
                {item.createdAt} · {t('snapshot.cutoff', { seq: String(item.throughSeq) })} ·{' '}
                {t('snapshot.count', { count: String(item.count) })}
              </p>
              <p className="user-question-hint">{t('snapshot.checksum', { hash: item.sha256 })}</p>
            </div>
            <div>
              <a
                className="user-question-skip"
                href={`/api/dsh-bot/backups/events?snapshotId=${encodeURIComponent(item.snapshotId)}`}
              >
                {t('snapshot.downloadLog')}
              </a>{' '}
              <a
                className="user-question-skip"
                href={`/api/dsh-bot/backups/archive?snapshotId=${encodeURIComponent(item.snapshotId)}`}
              >
                {t('snapshot.downloadArchive')}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </SettingsDrawer>
  )
}
