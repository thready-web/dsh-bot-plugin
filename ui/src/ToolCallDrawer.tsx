import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerFrame } from './drawer-frame'
import { DRAWER_PREF, clampDrawerWidth } from './file-layout'
import { useI18n } from './locale'
import { ToolCallDetail, toolCallHeadline } from './ToolCallDetail'
import type { ToolSegment } from './types'
import type { WorkTicket } from './work'

const DRAWER_WIDTH_KEY = 'dsh-bot.tool-drawer-width'

function readDrawerWidth() {
  try {
    const stored = localStorage.getItem(DRAWER_WIDTH_KEY)
    if (stored == null || stored === '') return DRAWER_PREF
    return clampDrawerWidth(Number(stored))
  } catch {
    return DRAWER_PREF
  }
}

function writeDrawerWidth(width: number) {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(width))
  } catch {
    /* private mode */
  }
}

/** Right-hand tool detail. Same frame as the file and memory drawers. */
export function ToolCallDrawer({
  open,
  segment,
  cwd,
  tickets = [],
  stale = false,
  onClose,
}: {
  open: boolean
  segment: ToolSegment | null
  cwd?: string
  tickets?: readonly WorkTicket[]
  stale?: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const retained = useRef<ToolSegment | null>(segment)
  if (segment) retained.current = segment
  const shown = segment ?? retained.current
  const [width, setWidth] = useState(readDrawerWidth)
  const widthRef = useRef(width)
  const [resizing, setResizing] = useState(false)
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  const [narrow, setNarrow] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 800px)').matches,
  )
  const [present, setPresent] = useState(open)
  const [motion, setMotion] = useState<'in' | 'out'>(open ? 'in' : 'out')
  const presentRef = useRef(present)
  const motionRef = useRef(motion)
  presentRef.current = present
  motionRef.current = motion
  const laidOut = clampDrawerWidth(width)

  useDrawerFrame({ present: present && shown != null, narrow, motion, width: laidOut, resizing, viewport })

  useEffect(() => {
    if (open) {
      setPresent(true)
      setMotion('in')
      return
    }
    if (!presentRef.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
      return
    }
    setMotion('out')
  }, [open])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)')
    const apply = () => setNarrow(media.matches)
    if (typeof media.addEventListener !== 'function') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!present) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [present, onClose])

  if (!present || !shown) return null
  const headline = toolCallHeadline(shown, cwd, tickets, t)

  return createPortal(
    <div
      className={
        narrow
          ? `files-drawer tool-drawer narrow files-drawer-${motion}`
          : `files-drawer tool-drawer files-drawer-${motion}${resizing ? ' resizing' : ''}`
      }
      style={narrow ? undefined : { width: laidOut }}
      role="dialog"
      aria-label={t('activity.toolDetail')}
      onAnimationEnd={event => {
        if (event.target !== event.currentTarget || event.animationName !== 'files-drawer-out') return
        if (motionRef.current === 'out') setPresent(false)
      }}
    >
      {narrow ? null : (
        <div
          className="files-resize"
          onPointerDown={event => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
            const move = (pointer: PointerEvent) => {
              const next = clampDrawerWidth(window.innerWidth - pointer.clientX)
              widthRef.current = next
              setWidth(next)
            }
            const up = () => {
              setResizing(false)
              writeDrawerWidth(widthRef.current)
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        />
      )}
      <header className="files-head">
        <button type="button" className="files-icon-btn" aria-label={t('activity.close')} onClick={onClose}>
          <CloseIcon />
        </button>
        <nav className="files-crumbs" aria-label={t('activity.toolDetail')}>
          <span>{shown.name}</span>
          {headline && headline !== shown.name ? (
            <span>
              <span aria-hidden="true"> / </span>
              <span className="files-crumb-current">{headline}</span>
            </span>
          ) : null}
        </nav>
      </header>
      <div className="files-body">
        <ToolCallDetail segment={shown} cwd={cwd} tickets={tickets} stale={stale} />
      </div>
    </div>,
    document.body,
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.2 4.2L11.8 11.8M11.8 4.2L4.2 11.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
