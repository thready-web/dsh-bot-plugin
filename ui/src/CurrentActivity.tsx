import type { PresenceState } from './presence/lib/index.ts'
import { useEffect, useState } from 'react'
import { currentActivity, type CurrentActivityInput } from './current-activity'
import { useI18n } from './locale'
import { PresenceMark } from './presence/PresenceMark'

/** Status for the latest chat line. The detailed event timeline stays in its original order. */
export function CurrentActivity({
  sessionId = '',
  presence = 'thinking',
  ...props
}: Omit<CurrentActivityInput, 't'> & { sessionId?: string; presence?: PresenceState }) {
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
      className="chat-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-moving={summary.moving && visible ? 'true' : 'false'}
    >
      {sessionId ? (
        <PresenceMark sessionId={sessionId} state={presence} still={!(summary.moving && visible)} size={28} />
      ) : (
        <span className="chat-status-mark" aria-hidden="true">
          <span />
          <span />
        </span>
      )}
      <span className="chat-status-text" title={summary.text}>
        {summary.text}
      </span>
    </div>
  )
}
