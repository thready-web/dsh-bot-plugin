import { useEffect, useState } from 'react'
import { currentActivity, type CurrentActivityInput } from './current-activity'
import { useI18n } from './locale'

/** Compact composer status; the detailed event timeline stays in its original order. */
export function CurrentActivity(props: Omit<CurrentActivityInput, 't'>) {
  const { t } = useI18n()
  const summary = currentActivity({ ...props, t })
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    update()
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  if (!summary) return null
  return (
    <div
      className="composer-activity"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-moving={summary.moving && visible ? 'true' : 'false'}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="composer-activity-text" title={summary.text}>
        {summary.text}
      </span>
    </div>
  )
}
