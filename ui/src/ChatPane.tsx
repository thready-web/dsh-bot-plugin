import {
  forwardRef,
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
import { FOLLOW_GAP } from './scroll-follow'
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
      const clearance = dock.hidden ? 0 : Math.max(0, dock.offsetHeight - fade)
      const next = clearance + FOLLOW_GAP
      const previous = Number.parseFloat(scroll.style.paddingBottom) || 0
      if (previous === next) return
      scroll.style.paddingBottom = `${next}px`
      stickIfFollowing()
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      scroll.style.paddingBottom = ''
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
}) {
  const { t } = useI18n()
  const locked = disabled || readOnly

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
          aria-label={readOnly ? placeholder : undefined}
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
              <button type="button" className="stop" aria-label={t('composer.cancel')} disabled={locked || stopDisabled} onClick={onStop}>
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
      {stats ? <p className="stats">{stats}</p> : null}
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
