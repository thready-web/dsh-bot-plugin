import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowIcon, HistoryLoading, PlusIcon } from './chrome'
import { useI18n } from './locale'
import { scrollPaddingForDock } from './scroll-follow'
import { useScrollFollow } from './use-scroll-follow'

/**
 * The production chat surface: scrolling transcript, composer dock, and jump-to-latest.
 * The workbench and the event-log replay preview both render this component.
 */
export type ChatPaneHandle = {
  pin: (behavior?: ScrollBehavior) => void
}

export const ChatPane = forwardRef<
  ChatPaneHandle,
  {
    scrollKey: string
    header?: ReactNode
    beforeBody?: ReactNode
    busy?: boolean
    progress?: { loaded: number; total: number } | null
    /** Inbox view parks the jump control in the transcript instead of the composer. */
    jumpInBody?: boolean
    composerHidden?: boolean
    composerLift?: boolean
    scrollClassName?: string
    markReadonly?: boolean
    rail?: (root: RefObject<HTMLDivElement | null>) => ReactNode
    activity?: ReactNode
    composer: ReactNode
    children: ReactNode
  }
>(function ChatPane(
  {
    scrollKey,
    header,
    beforeBody,
    busy = false,
    progress = null,
    jumpInBody = false,
    composerHidden = false,
    composerLift = false,
    scrollClassName,
    markReadonly = false,
    rail,
    activity,
    composer,
    children,
  },
  ref,
) {
  const { t } = useI18n()
  const { scrollRef, contentRef, detached, pin, stickIfFollowing } = useScrollFollow(scrollKey)
  const composerRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ pin }), [pin])

  useLayoutEffect(() => {
    const dock = composerRef.current
    const scroll = scrollRef.current
    if (!dock || !scroll) return
    const apply = () => {
      const fade = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--composer-fade')) || 0
      const next = scrollPaddingForDock(dock, fade)
      if (next == null) return
      const previous = Number.parseFloat(scroll.style.paddingBottom) || 0
      if (previous === next) return
      scroll.style.paddingBottom = `${next}px`
      stickIfFollowing()
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    // Keep the pad across lift and session changes. Clearing it clamps the transcript, then the refill eases it back.
    return () => {
      observer.disconnect()
    }
  }, [scrollKey, composerHidden, composerLift, scrollRef, stickIfFollowing])

  const jump = detached ? <LatestButton label={t('scroll.latest')} onClick={() => pin('smooth')} /> : null

  return (
    <section className="chat">
      {header}
      {beforeBody}
      <div className="chat-body">
        <HistoryLoading active={busy} progress={progress} />
        {jumpInBody ? jump : null}
        <div
          className={scrollClassName ? `scroll ${scrollClassName}` : 'scroll'}
          ref={scrollRef}
          data-readonly={markReadonly ? 'true' : undefined}
          aria-busy={busy || undefined}
        >
          <div className="column" ref={contentRef}>
            <div className="thread">
              {children}
              {activity}
            </div>
          </div>
        </div>
        {rail?.(scrollRef)}
      </div>
      <ComposerDock ref={composerRef} lift={composerLift} hidden={composerHidden}>
        {jumpInBody ? null : jump}
        {composer}
      </ComposerDock>
    </section>
  )
})

export function ChatComposer({
  onSubmit,
  chips,
  mentions,
  textareaRef,
  value,
  placeholder,
  disabled = false,
  readOnly = false,
  onChange,
  onSelect,
  onKeyDown,
  toolsRef,
  addDisabled = false,
  addExpanded = false,
  onAdd,
  addMenu,
  permission,
  model,
  showStop = false,
  stopDisabled = false,
  onStop,
  showSend = true,
  sendDisabled = false,
  stats,
  inputLabel,
}: {
  onSubmit?: () => void
  chips?: ReactNode
  mentions?: ReactNode
  textareaRef?: { current: HTMLTextAreaElement | null }
  value: string
  placeholder: string
  disabled?: boolean
  readOnly?: boolean
  onChange?: (value: string, cursor: number) => void
  onSelect?: (cursor: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  toolsRef?: { current: HTMLDivElement | null }
  addDisabled?: boolean
  addExpanded?: boolean
  onAdd?: () => void
  addMenu?: ReactNode
  permission?: ReactNode
  model?: string
  showStop?: boolean
  stopDisabled?: boolean
  onStop?: () => void
  showSend?: boolean
  sendDisabled?: boolean
  stats?: ReactNode
  inputLabel?: string
}) {
  const { t } = useI18n()
  const locked = disabled || readOnly
  useLayoutEffect(() => {
    const node = textareaRef?.current
    if (!node) return
    const narrow = window.matchMedia('(max-width: 800px)').matches
    const limit = narrow ? Math.min(160, window.innerHeight * 0.3) : 160
    node.style.height = 'auto'
    const next = Math.min(Math.max(node.scrollHeight, 36), limit)
    node.style.height = `${next}px`
    node.style.overflowY = node.scrollHeight > limit ? 'auto' : 'hidden'
  }, [textareaRef, value])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    onSubmit?.()
  }

  return (
    <form className="column" onSubmit={submit}>
      <div className="card">
        {chips}
        {mentions}
        <textarea
          ref={node => {
            if (textareaRef) textareaRef.current = node
          }}
          value={value}
          rows={1}
          placeholder={placeholder}
          disabled={disabled || readOnly}
          readOnly={readOnly}
          aria-label={inputLabel || placeholder}
          onChange={event => onChange?.(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onSelect={event => onSelect?.(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <div className="card-row">
          <div
            className="tools"
            ref={node => {
              if (toolsRef) toolsRef.current = node
            }}
          >
            <button
              type="button"
              className="add"
              aria-label={t('composer.add')}
              aria-haspopup={onAdd ? 'menu' : undefined}
              aria-expanded={onAdd ? addExpanded : undefined}
              disabled={locked || addDisabled}
              onClick={onAdd}
            >
              <PlusIcon />
            </button>
            {locked ? null : addMenu}
            {locked ? null : permission}
          </div>
          <div className="trailing">
            {model ? <span className="model">{model}</span> : null}
            {showStop ? (
              <button
                type="button"
                className="stop"
                aria-label={t('composer.cancel')}
                disabled={locked || stopDisabled}
                onClick={onStop}
              >
                <span className="stop-icon" />
              </button>
            ) : null}
            {showSend ? (
              <button type="submit" className="send" aria-label={t('composer.send')} disabled={locked || sendDisabled}>
                <ArrowIcon />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {/* An empty caption still holds its line, so a session swap cannot shrink the dock. */}
      {stats != null ? <p className="stats">{stats}</p> : null}
    </form>
  )
}

function LatestButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="jump-latest" aria-label={label} onClick={onClick}>
      <ArrowIcon />
    </button>
  )
}

const ComposerDock = forwardRef<HTMLDivElement, { lift: boolean; hidden: boolean; children: ReactNode }>(
  function ComposerDock({ lift, hidden, children }, ref) {
    const [box, setBox] = useState<{ left: number; width: number } | null>(null)
    useEffect(() => {
      const viewport = window.visualViewport
      if (!viewport) return
      const apply = () => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
      }
      apply()
      viewport.addEventListener('resize', apply)
      viewport.addEventListener('scroll', apply)
      return () => {
        viewport.removeEventListener('resize', apply)
        viewport.removeEventListener('scroll', apply)
        document.documentElement.style.setProperty('--keyboard-inset', '0px')
      }
    }, [])
    useLayoutEffect(() => {
      if (!lift) return
      const chat = document.querySelector('section.chat')
      const place = () => {
        const rect = chat?.getBoundingClientRect()
        if (!rect) return
        setBox({ left: rect.left, width: rect.width })
      }
      place()
      window.addEventListener('resize', place)
      return () => window.removeEventListener('resize', place)
    }, [lift])
    // The canvas stage reserves this height so the floating composer does not cover the design.
    useLayoutEffect(() => {
      if (!lift) return
      const node = ref && typeof ref === 'object' ? ref.current : null
      if (!node) return
      const root = document.documentElement
      const apply = () => root.style.setProperty('--composer-lift', `${node.offsetHeight}px`)
      apply()
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
      observer?.observe(node)
      window.addEventListener('resize', apply)
      return () => {
        observer?.disconnect()
        window.removeEventListener('resize', apply)
        root.style.setProperty('--composer-lift', '0px')
      }
    }, [lift, hidden, ref])
    const node = (
      <div
        ref={ref}
        className={lift ? 'composer-wrap lifted' : 'composer-wrap'}
        hidden={hidden}
        style={lift && box ? { left: box.left, width: box.width, right: 'auto' } : undefined}
      >
        {children}
      </div>
    )
    return lift && box ? createPortal(node, document.body) : node
  },
)
