import { useI18n } from './locale'

/**
 * The session list before the first `/sessions` answer arrives.
 *
 * Desktop keeps the sidebar rhythm: compact rows with a face-sized circle and two
 * text lines. Mobile shows the same information as full-width cards, because the
 * list owns the whole screen there. Both are hidden from assistive technology; the
 * wrapper announces a single loading status.
 */
export function SessionListSkeleton() {
  const { t } = useI18n()
  return (
    <div className="session-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{t('session.loading')}</span>
      <div className="session-skeleton-desktop" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <span className="skeleton-session" key={index}>
            <span className="skeleton-avatar" />
            <span className="skeleton-copy">
              <span className="skeleton-line name" />
              <span className="skeleton-line preview" />
            </span>
          </span>
        ))}
      </div>
      <div className="session-skeleton-mobile" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span className="skeleton-card" key={index}>
            <span className="skeleton-avatar" />
            <span className="skeleton-copy">
              <span className="skeleton-line name" />
              <span className="skeleton-line preview" />
            </span>
            <span className="skeleton-pill" />
          </span>
        ))}
      </div>
    </div>
  )
}
