import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from './locale'
import { ImageFailureContext } from './ImageFailureScope'
import { createImageFailures } from './image-failures'

/** A compact Markdown thumbnail with a viewport-fit, scrollable original-size viewer. */
export function ImagePreview({ src, alt = '', title }: { src?: string; alt?: string; title?: string }) {
  const { t } = useI18n()
  const scope = useContext(ImageFailureContext)
  const [localFailures] = useState(createImageFailures)
  const failures = scope ?? localFailures
  const cachedFailure = useSyncExternalStore(
    failures.subscribe,
    () => failures.has(src ?? ''),
    () => false,
  )
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const failed = cachedFailure || failedSource === src

  const [open, setOpen] = useState(false)
  const [original, setOriginal] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const name = alt || t('image.untitled')

  useEffect(() => {
    if (!open || failed) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex="0"]') ?? [])]
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault()
        last?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault()
        first?.focus()
      }
    }
    const onFocus = (event: FocusEvent) => {
      if (!dialog.current?.contains(event.target as Node)) closeButton.current?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
      else retryButton.current?.focus()
    }
  }, [open, failed])

  // A replaced image starts fitted, rather than inheriting another image's scroll position.
  useEffect(() => {
    setOriginal(false)
    setOpen(false)
  }, [src])

  function toggleSize() {
    setOriginal(value => !value)
    if (stage.current) {
      stage.current.scrollLeft = 0
      stage.current.scrollTop = 0
    }
  }

  function unavailable() {
    if (src) {
      failures.fail(src)
      setFailedSource(src)
    }
    setOpen(false)
  }

  if (!src || failed) {
    const filename = src?.split(/[?#]/)[0]?.split('/').at(-1)
    return (
      <span className="image-unavailable" role="status">
        <strong>{alt || filename || t('image.untitled')}</strong>
        <span>{t('image.unavailable')}</span>
        {src && (
          <button
            ref={retryButton}
            type="button"
            onClick={() => {
              setOpen(false)
              setFailedSource(null)
              failures.retry(src)
            }}
          >
            {t('image.retry')}
          </button>
        )}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        className="image-preview-trigger"
        aria-label={t('image.open', { name })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('image.open', { name })}
        onClick={() => {
          setOriginal(false)
          setOpen(true)
        }}
      >
        <img
          className="image-preview-thumbnail"
          src={src}
          alt={alt}
          title={title}
          loading="lazy"
          onError={unavailable}
        />
        <span className="image-preview-hint" aria-hidden="true">
          {t('image.enlarge')}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            className="image-lightbox"
            onClick={event => {
              if (event.target === event.currentTarget) setOpen(false)
            }}
          >
            <div ref={dialog} className="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label={name}>
              <header className="image-lightbox-toolbar">
                <span className="image-lightbox-name" title={name}>
                  {name}
                </span>
                <button type="button" onClick={toggleSize} aria-pressed={original}>
                  {original ? t('image.fit') : t('image.original')}
                </button>
                <button ref={closeButton} type="button" onClick={() => setOpen(false)} aria-label={t('image.close')}>
                  {t('image.close')}
                </button>
              </header>
              <div
                ref={stage}
                className={original ? 'image-lightbox-stage original' : 'image-lightbox-stage'}
                tabIndex={0}
                role="region"
                aria-label={original ? t('image.scroll') : t('image.fit')}
              >
                <img src={src} alt={alt} title={title} draggable={false} onError={unavailable} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
