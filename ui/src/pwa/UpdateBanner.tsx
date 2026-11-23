import { useEffect, useState } from 'react'
import { useI18n } from '../locale'
import { applyPwaUpdate } from './register'

/**
 * A waiting shell is offered, never forced. The worker keeps serving the current
 * release until the reader here says reload, so drafts and in-flight approvals are
 * not cut off mid-turn (docs/pwa-instant-start.md §6.1).
 */
export function PwaUpdateBanner() {
  const { t } = useI18n()
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    const onUpdate = () => setReady(true)
    window.addEventListener('dsh-bot:pwa-update', onUpdate)
    return () => window.removeEventListener('dsh-bot:pwa-update', onUpdate)
  }, [])
  if (!ready || dismissed) return null
  return (
    <div className="pwa-update" role="status" aria-live="polite">
      <p>{t('pwa.updateReady')}</p>
      <div className="pwa-update-actions">
        <button type="button" className="pwa-update-apply" onClick={() => applyPwaUpdate()}>
          {t('pwa.updateApply')}
        </button>
        <button type="button" className="pwa-update-later" onClick={() => setDismissed(true)}>
          {t('pwa.updateLater')}
        </button>
      </div>
    </div>
  )
}
