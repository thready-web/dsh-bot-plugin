import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { mentionFrom } from '../../../../packages/dsh-canvas/src/mention.ts'
import { isCanvasAnchor, isCanvasPage, splitCanvasRoute } from './canvas-link'
import { mentionLabel } from './canvas-target'
import { adoptElement, type RawNode } from '../../../../packages/dsh-canvas/src/path.ts'
import { api } from './api'
import { placeCanvases } from './canvas-place'
import {
  applyCanvasRevision,
  emptyCanvasCache,
  nextFrameSrc,
  type CanvasCache,
  type CanvasRevisionDocument,
} from './canvas-sync'
import { useI18n } from './locale'
import type { MessageKey } from './i18n/index.ts'

const DEVICES = [
  { id: 'desktop', width: 1280, label: 'canvas.device.desktop' },
  { id: 'tablet', width: 768, label: 'canvas.device.tablet' },
  { id: 'phone', width: 390, label: 'canvas.device.phone' },
] as const satisfies ReadonlyArray<{ id: string; width: number; label: MessageKey }>

export interface CanvasSummary {
  id: string
  title: string
  ticketId: string | null
  previewRevision: number | null
  stableRevision: number | null
}

export interface CanvasLocation {
  revision: number | null
  page: string | null
  anchor: string | null
}

const emptyCanvasPlace = {
  byTicket: new Map<string, CanvasSummary>(),
  loose: [] as CanvasSummary[],
  open: (_id: string, _location?: CanvasLocation) => {},
}

const CanvasPlaceContext = createContext<{
  byTicket: Map<string, CanvasSummary>
  loose: readonly CanvasSummary[]
  open: (id: string, location?: CanvasLocation) => void
}>(emptyCanvasPlace)

export function useCanvasPlace() {
  return useContext(CanvasPlaceContext)
}

export interface RevisionSummary {
  revision: number
  kind: string
  status: 'preview' | 'stable' | 'failed'
  entry: string | null
  error: string | null
}

const CHANNEL = 'canvas-inspect'

export interface CanvasOpenOrigin {
  x: number
  y: number
}

/** A click in the last moment is the point the modal grows from. */
const CLICK_ORIGIN_MS = 150

function motionEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.animate === 'function'
}

export function CanvasPreview({
  title,
  revisions,
  activeRevision,
  phase,
  error,
  src,
  canvasId,
  onSelect,
  onRetry,
  onAdopt,
  onClose,
  origin = null,
  onOpened,
  onMention,
  routeStamp = 0,
  routePage = null,
  routeAnchor = null,
}: {
  title: string
  revisions: RevisionSummary[]
  activeRevision: number | null
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  src: string
  canvasId?: string
  onSelect: (revision: number) => void
  onRetry: () => void
  onAdopt: () => void
  onClose: () => void
  origin?: CanvasOpenOrigin | null
  /** The zoom-in has finished. The canvas document can render now. */
  onOpened?: () => void
  onMention?: (chip: { canvasId: string; revision: number; path: string; tag: string; label: string }) => void
  routeStamp?: number
  routePage?: string | null
  routeAnchor?: string | null
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened
  const closeRef = useRef<() => void>(() => {})
  const [motion, setMotion] = useState<'prepare' | 'enter' | 'settled' | 'leave'>(
    motionEnabled() ? 'prepare' : 'settled',
  )
  const [transformOrigin, setTransformOrigin] = useState('center center')
  const motionRef = useRef(motion)
  motionRef.current = motion
  const selectingRef = useRef(false)
  const pinnedRef = useRef<string | null>(null)
  const [device, setDevice] = useState<(typeof DEVICES)[number]['id']>('desktop')
  const [selecting, setSelecting] = useState(false)
  const [nonce, setNonce] = useState('')
  const [nonceSrc, setNonceSrc] = useState('')
  const [page, setPage] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const appliedRoute = useRef(0)
  const [source, setSource] = useState<RawNode | null>(null)
  const [pinnedPath, setPinnedPath] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const sourceRef = useRef<RawNode | null>(null)
  const mentionRef = useRef(onMention)
  const canvasRef = useRef(canvasId)
  const revisionRef = useRef(activeRevision)
  const nonceRef = useRef('')
  selectingRef.current = selecting
  nonceRef.current = nonce
  pinnedRef.current = pinnedPath
  sourceRef.current = source
  mentionRef.current = onMention
  canvasRef.current = canvasId
  revisionRef.current = activeRevision
  const linkedPage = routePage && isCanvasPage(routePage) ? routePage : null
  const linkedAnchor = routeAnchor && isCanvasAnchor(routeAnchor) ? routeAnchor : null
  const routeFresh = routeStamp > 0 && routeStamp !== appliedRoute.current
  if (src !== nonceSrc) {
    setNonceSrc(src)
    setNonce(src ? freshNonce() : '')
    if (src !== '') {
      if (routeStamp > 0) appliedRoute.current = routeStamp
      setPage(routeStamp > 0 ? linkedPage : null)
      setAnchor(routeStamp > 0 ? linkedAnchor : null)
      setSelecting(false)
      setPinnedPath(null)
      setReload(0)
    }
  } else if (routeFresh && src) {
    appliedRoute.current = routeStamp
    setPage(linkedPage)
    setAnchor(linkedAnchor)
    setSelecting(false)
    setPinnedPath(null)
  }
  const pageName = page ?? entryName(src)
  const frameSrc = frameAddress(src, nonce, pageName, reload, anchor)
  const sourceUrl = mediaPage(src, pageName)
  const name = title || t('canvas.card')
  const active = revisions.find(revision => revision.revision === activeRevision) ?? null
  const width = DEVICES.find(item => item.id === device)?.width ?? 1280

  const requestClose = () => {
    if (motionRef.current === 'leave') return
    if (!motionEnabled()) {
      onCloseRef.current()
      return
    }
    motionRef.current = 'leave'
    setMotion('leave')
  }
  closeRef.current = requestClose

  useLayoutEffect(() => {
    if (motion !== 'prepare') return
    const node = dialog.current
    if (node && origin) {
      const rect = node.getBoundingClientRect()
      setTransformOrigin(`${origin.x - rect.left}px ${origin.y - rect.top}px`)
    } else {
      setTransformOrigin('center center')
    }
    setMotion('enter')
  }, [motion, origin])

  useEffect(() => {
    if (motion !== 'enter') return
    const node = dialog.current
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      setMotion(current => (current === 'enter' ? 'settled' : current))
    }
    if (!node) {
      finish()
      return
    }
    const onEnd = (event: AnimationEvent) => {
      if (event.target === node && event.animationName === 'canvas-zoom-in') finish()
    }
    node.addEventListener('animationend', onEnd)
    const timer = window.setTimeout(finish, 260)
    return () => {
      node.removeEventListener('animationend', onEnd)
      window.clearTimeout(timer)
    }
  }, [motion])

  useEffect(() => {
    if (motion === 'settled') onOpenedRef.current?.()
  }, [motion])

  useEffect(() => {
    if (motion !== 'leave') return
    const node = dialog.current
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      onCloseRef.current()
    }
    if (!node) {
      finish()
      return
    }
    const onEnd = (event: AnimationEvent) => {
      if (event.target === node && event.animationName === 'canvas-zoom-out') finish()
    }
    node.addEventListener('animationend', onEnd)
    const timer = window.setTimeout(finish, 280)
    return () => {
      node.removeEventListener('animationend', onEnd)
      window.clearTimeout(timer)
    }
  }, [motion])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectingRef.current) {
          event.preventDefault()
          event.stopPropagation()
          setSelecting(false)
          const frame = frameRef.current?.contentWindow
          const currentNonce = nonceRef.current
          if (frame && typeof frame.postMessage === 'function' && currentNonce)
            frame.postMessage({ dsh: CHANNEL, nonce: currentNonce, type: 'disarm' }, '*')
          return
        }
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button, iframe, [href], [tabindex="0"]') ?? []),
      ]
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
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (motion !== 'settled' || !sourceUrl) return
    let cancel = false
    fetch(sourceUrl, { credentials: 'omit', cache: 'no-store' })
      .then(response => (response.ok ? response.text() : Promise.reject(new Error('load'))))
      .then(html => {
        if (!cancel) setSource(adoptElement(new DOMParser().parseFromString(html, 'text/html').body))
      })
      .catch(() => {
        if (!cancel) setSource(null)
      })
    return () => {
      cancel = true
    }
  }, [motion, sourceUrl])

  useEffect(() => {
    if (!nonce) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { dsh?: unknown; nonce?: unknown; type?: unknown; path?: unknown; rect?: unknown }
      if (!data || data.dsh !== CHANNEL || data.nonce !== nonce) return
      if (data.type === 'open' && typeof data.path === 'string') {
        const route = splitCanvasRoute(data.path)
        if (!route) return
        setPage(current =>
          current === route.page || (current == null && route.page === entryName(src)) ? current : route.page,
        )
        setAnchor(route.anchor)
        setPinnedPath(null)
        setSource(null)
        return
      }
      if (!selectingRef.current) return
      if (data.type === 'ready') {
        const path = pinnedRef.current
        if (path != null)
          frameRef.current?.contentWindow?.postMessage({ dsh: CHANNEL, nonce, type: 'pin', path }, '*')
        return
      }
      if (data.type !== 'select' || typeof data.path !== 'string') return
      const tree = sourceRef.current
      const mention = tree ? mentionFrom(tree, data.path) : null
      const id = canvasRef.current
      const revision = revisionRef.current
      if (!mention || !id || revision == null) return
      setPinnedPath(data.path)
      const from = viewportRect(frameRef.current, data.rect)
      const label = mentionLabel(
        name,
        t('canvas.revision', { revision: String(revision) }),
        mention.tag,
        mention.text,
      )
      const chip = { canvasId: id, revision, path: mention.path, tag: mention.tag, label }
      void flyToComposer(from, label).then(() => mentionRef.current?.(chip))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [nonce, src, t, name])

  const resetPage = () => {
    setSelecting(false)
    setPinnedPath(null)
    setPage(null)
    setAnchor(null)
    setReload(Date.now())
  }

  const tellFrame = (type: 'arm' | 'disarm') => {
    const frame = frameRef.current?.contentWindow
    if (!frame || typeof frame.postMessage !== 'function' || !nonce) return
    frame.postMessage({ dsh: CHANNEL, nonce, type }, '*')
  }

  return createPortal(
    <div
      className={motion === 'leave' ? 'canvas-modal leaving' : 'canvas-modal'}
      onClick={event => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialog}
        className={`canvas-dialog ${motion}`}
        style={{ transformOrigin }}
        role="dialog"
        aria-modal="true"
        aria-label={name}
      >
        <header className="canvas-toolbar">
          <div className="canvas-toolbar-title">
            <strong className="canvas-name" title={name}>
              {name}
            </strong>
            <button
              ref={closeButton}
              type="button"
              className="canvas-close"
              aria-label={t('canvas.close')}
              onClick={requestClose}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <div className="canvas-toolbar-controls">
            <button
              type="button"
              className="canvas-reset"
              title={t('canvas.reset.hint')}
              onClick={resetPage}
              disabled={!src}
            >
              {t('canvas.reset')}
            </button>
            <button
              type="button"
              className={selecting ? 'canvas-select on' : 'canvas-select'}
              aria-pressed={selecting}
              aria-label={t('canvas.select')}
              title={t('canvas.select')}
              disabled={!src}
              onClick={() => {
                if (selecting) {
                  setSelecting(false)
                  tellFrame('disarm')
                  return
                }
                setSelecting(true)
                tellFrame('arm')
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="6.4" y="6.4" width="11" height="11" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path
                  className="cursor"
                  d="M1.8 1.4 2.15 9.2 4.6 6.8 6.7 11.4 8 10.8 5.9 6.2 9.2 6.4Z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <div className="canvas-segment" role="group" aria-label={t('canvas.devices')}>
              {DEVICES.map(item => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={device === item.id}
                  onClick={() => setDevice(item.id)}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
            <div className="canvas-segment canvas-versions" role="group" aria-label={t('canvas.versions')}>
              {revisions.map(revision => (
                <button
                  key={revision.revision}
                  type="button"
                  aria-pressed={revision.revision === activeRevision}
                  disabled={revision.status === 'failed'}
                  title={revision.error ?? t('canvas.revision', { revision: String(revision.revision) })}
                  onClick={() => onSelect(revision.revision)}
                >
                  {t('canvas.revision', { revision: String(revision.revision) })}
                  <span className="canvas-version-status">{t(statusKey(revision.status))}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="canvas-adopt"
              onClick={onAdopt}
              disabled={active?.status !== 'preview' || phase === 'loading'}
            >
              {active?.status === 'stable' ? t('canvas.adopted') : t('canvas.adopt')}
            </button>
          </div>
        </header>
        <div className="canvas-stage">
          {phase === 'loading' ? <p className="canvas-status">{t('canvas.loading')}</p> : null}
          {phase === 'error' ? (
            <p className="canvas-status" role="alert">
              <span>{error || t('canvas.error')}</span>
              <button type="button" onClick={onRetry}>
                {t('canvas.retry')}
              </button>
            </p>
          ) : null}
          {motion === 'settled' && src ? (
            <div className="canvas-frame" style={{ width: `min(100%, ${width}px)` }}>
              <iframe
                ref={frameRef}
                title={name}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={frameSrc || undefined}
                onLoad={() => {
                  if (!nonce) return
                  const frame = frameRef.current?.contentWindow
                  if (!frame || typeof frame.postMessage !== 'function') return
                  frame.postMessage({ dsh: CHANNEL, nonce, type: 'hello' }, '*')
                  if (anchor && isCanvasAnchor(anchor))
                    frame.postMessage({ dsh: CHANNEL, nonce, type: 'focus', anchor }, '*')
                  if (selectingRef.current) frame.postMessage({ dsh: CHANNEL, nonce, type: 'arm' }, '*')
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function statusKey(status: RevisionSummary['status']): MessageKey {
  if (status === 'stable') return 'canvas.stable'
  if (status === 'failed') return 'canvas.failed'
  return 'canvas.preview'
}

function entryName(src: string): string {
  const match = /^\/dsh-bot\/canvas-media\/[A-Za-z0-9_-]{20,128}\/[1-9]\d{0,8}\/(.+)$/.exec(src.split('?')[0] ?? '')
  const page = match?.[1] ?? ''
  return isCanvasPage(page) ? page : 'index.html'
}

function mediaPage(src: string, page: string): string {
  const match = /^(\/dsh-bot\/canvas-media\/[A-Za-z0-9_-]{20,128}\/[1-9]\d{0,8}\/)/.exec(src.split('?')[0] ?? '')
  if (!match || !isCanvasPage(page)) return src
  return `${match[1]}${page}`
}

function frameAddress(src: string, nonce: string, page: string, reload: number, anchor: string | null): string {
  const match = /^\/dsh-bot\/canvas-media\/([A-Za-z0-9_-]{20,128})\/([1-9]\d{0,8})\//.exec(src.split('?')[0] ?? '')
  if (!match || !nonce || !isCanvasPage(page)) return ''
  const address = `/dsh-bot/canvas-inspect/${match[1]}/${match[2]}/${page}?nonce=${encodeURIComponent(nonce)}`
  const located = reload ? `${address}&r=${reload}` : address
  return anchor && isCanvasAnchor(anchor) ? `${located}#${anchor}` : located
}

function freshNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function viewportRect(frame: HTMLIFrameElement | null, value: unknown): DOMRect | null {
  if (!frame || !value || typeof value !== 'object') return null
  const row = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof row.x !== 'number' || typeof row.y !== 'number') return null
  if (typeof row.width !== 'number' || typeof row.height !== 'number') return null
  const box = frame.getBoundingClientRect()
  return new DOMRect(box.left + row.x, box.top + row.y, row.width, row.height)
}

function flyToComposer(from: DOMRect | null, label: string): Promise<void> {
  const card = document.querySelector('.composer-wrap .card')
  if (!from || !card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve()
  const to = card.getBoundingClientRect()
  const width = Math.min(Math.max(from.width, 120), 240)
  const height = 28
  const left = from.left + Math.min(from.width, 240) / 2 - width / 2
  const top = from.top + Math.min(from.height, 36) / 2 - height / 2
  const ghost = document.createElement('div')
  ghost.className = 'canvas-fly'
  ghost.textContent = label
  ghost.style.left = `${left}px`
  ghost.style.top = `${top}px`
  ghost.style.width = `${width}px`
  document.body.append(ghost)
  const animation = ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1)', opacity: 0.96 },
      { transform: `translate(${to.left + 16 - left}px, ${to.top + 8 - top}px) scale(0.86)`, opacity: 1 },
    ],
    { duration: 560, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
  )
  return animation.finished.then(
    () => ghost.remove(),
    () => ghost.remove(),
  )
}

function mediaUrl(token: string, revision: number, path: string) {
  return `/dsh-bot/canvas-media/${token}/${revision}/${path
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')}`
}

function asSummaries(body: Record<string, unknown>): CanvasSummary[] {
  if (!Array.isArray(body.canvases)) return []
  return body.canvases.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string') return []
    return [
      {
        id: row.id,
        title: typeof row.title === 'string' ? row.title : '',
        ticketId: typeof row.ticketId === 'string' ? row.ticketId : null,
        previewRevision: typeof row.previewRevision === 'number' ? row.previewRevision : null,
        stableRevision: typeof row.stableRevision === 'number' ? row.stableRevision : null,
      },
    ]
  })
}

function asRevisions(body: Record<string, unknown>): RevisionSummary[] {
  if (!Array.isArray(body.revisions)) return []
  return body.revisions.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.revision !== 'number') return []
    const status = row.status === 'stable' || row.status === 'failed' ? row.status : 'preview'
    return [
      {
        revision: row.revision,
        kind: typeof row.kind === 'string' ? row.kind : '',
        status,
        entry: typeof row.entry === 'string' ? row.entry : null,
        error: typeof row.error === 'string' ? row.error : null,
      },
    ]
  })
}

function asDocument(body: Record<string, unknown>): CanvasRevisionDocument | null {
  if ((body.kind !== 'snapshot' && body.kind !== 'delta') || typeof body.revision !== 'number') return null
  if (typeof body.entry !== 'string' || !Array.isArray(body.manifest)) return null
  const manifest = body.manifest.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.path !== 'string' || typeof row.hash !== 'string' || typeof row.bytes !== 'number') return []
    if (typeof row.type !== 'string') return []
    return [{ path: row.path, hash: row.hash, bytes: row.bytes, type: row.type }]
  })
  if (manifest.length !== body.manifest.length) return null
  return {
    kind: body.kind,
    revision: body.revision,
    baseRevision: typeof body.baseRevision === 'number' ? body.baseRevision : null,
    entry: body.entry,
    manifest,
  }
}

export function CanvasCard({ item, onOpen }: { item: CanvasSummary; onOpen: () => void }) {
  const { t } = useI18n()
  return (
    <button type="button" className="canvas-card" aria-haspopup="dialog" onClick={onOpen}>
      <span>{item.title || t('canvas.card')}</span>
      <small>
        {item.previewRevision != null
          ? t('canvas.revision', { revision: String(item.previewRevision) })
          : t('canvas.open')}
      </small>
    </button>
  )
}

/** Loads session canvases and keeps each delivered card on the turn that produced it. */
export function CanvasScope({
  sessionId,
  pulse,
  tickets,
  onMention,
  onActive,
  dismiss = 0,
  children,
}: {
  sessionId: string
  pulse: number
  tickets: readonly { id: string; status: string }[]
  onMention?: (chip: { canvasId: string; revision: number; path: string; tag: string; label: string }) => void
  onActive?: (open: boolean) => void
  dismiss?: number
  children: ReactNode
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<CanvasSummary[]>([])
  const [listError, setListError] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const openIdRef = useRef<string | null>(null)
  openIdRef.current = openId
  const [paint, setPaint] = useState(false)
  const [openTarget, setOpenTarget] = useState<{ id: string; stamp: number } & CanvasLocation | null>(null)
  const openStamp = useRef(0)
  const clickRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const [openOrigin, setOpenOrigin] = useState<CanvasOpenOrigin | null>(null)
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [shown, setShown] = useState<number | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [src, setSrc] = useState('')
  const cacheRef = useRef<CanvasCache>(emptyCanvasCache())
  const loadedCanvas = useRef<string | null>(null)
  const requestRef = useRef(0)
  const [seenDismiss, setSeenDismiss] = useState(dismiss)
  if (dismiss !== seenDismiss) {
    setSeenDismiss(dismiss)
    if (dismiss > 0) setOpenId(null)
  }
  const open = items.find(item => item.id === openId) ?? null
  const requested =
    openTarget && openTarget.id === openId && openTarget.revision != null ? openTarget.revision : null
  const followRevision = requested ?? open?.previewRevision ?? open?.stableRevision ?? null
  const showRef = useRef<(canvasId: string, revision: number) => Promise<void>>(async () => {})

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.detail === 0) return
      clickRef.current = { x: event.clientX, y: event.clientY, at: performance.now() }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  useEffect(() => {
    setOpenId(null)
    setItems([])
    setListError(false)
  }, [sessionId])

  useEffect(() => {
    onActive?.(openId != null)
  }, [openId, onActive])

  useEffect(() => () => onActive?.(false), [onActive])

  useEffect(() => {
    if (!sessionId) return
    let stop = false
    const load = async () => {
      const response = await api(`/canvas?sessionId=${encodeURIComponent(sessionId)}`)
      if (stop) return
      if (response.status !== 200) {
        setListError(true)
        return
      }
      setListError(false)
      setItems(asSummaries(response.body))
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [sessionId, pulse])

  useEffect(() => {
    if (!openId) return
    let stop = false
    void api(`/canvas/${openId}`).then(response => {
      if (stop || response.status !== 200) return
      setRevisions(asRevisions(response.body))
    })
    return () => {
      stop = true
    }
  }, [openId, pulse, followRevision])

  useEffect(() => {
    if (!openId || !paint || followRevision == null) return
    void showRef.current(openId, followRevision)
    return () => {
      requestRef.current += 1
    }
  }, [openId, followRevision, paint])

  async function show(canvasId: string, revision: number) {
    const ticket = ++requestRef.current
    if (loadedCanvas.current !== canvasId) {
      loadedCanvas.current = canvasId
      cacheRef.current = emptyCanvasCache()
      setSrc('')
    }
    setPhase('loading')
    setError('')
    const tokenResponse = await api(`/canvas/${canvasId}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision }),
    })
    if (ticket !== requestRef.current) return
    const token = tokenResponse.body.token
    if (tokenResponse.status !== 200 || typeof token !== 'string') {
      setPhase('error')
      setError(t('canvas.error'))
      return
    }
    const manifestResponse = await api(`/canvas/${canvasId}/revisions/${revision}`)
    if (ticket !== requestRef.current) return
    const doc = manifestResponse.status === 200 ? asDocument(manifestResponse.body) : null
    if (!doc) {
      setPhase('error')
      setError(t('canvas.error'))
      return
    }
    const applied = await applyCanvasRevision(cacheRef.current, doc, async path => {
      const response = await fetch(mediaUrl(token, revision, path), { credentials: 'omit', cache: 'no-store' })
      if (!response.ok) throw new Error(t('canvas.error'))
      return new Uint8Array(await response.arrayBuffer())
    })
    if (ticket !== requestRef.current) return
    if (!applied.ok) {
      cacheRef.current = applied.cache
      setPhase('error')
      setError(t('canvas.error'))
      return
    }
    cacheRef.current = applied.cache
    setSrc(current => nextFrameSrc(current, { ok: true, src: mediaUrl(token, doc.revision, doc.entry) }))
    setShown(doc.revision)
    setPhase('ready')
  }
  showRef.current = show

  const placed = useMemo(() => placeCanvases(items, tickets), [items, tickets])
  const place = useMemo(
    () => ({
      byTicket: placed.byTicket,
      loose: placed.loose,
      open: (id: string, location?: CanvasLocation) => {
        const point = clickRef.current
        const fresh = point != null && performance.now() - point.at < CLICK_ORIGIN_MS
        setOpenOrigin(fresh ? { x: point.x, y: point.y } : null)
        if (openIdRef.current == null) {
          setPaint(false)
          setSrc('')
          setPhase('idle')
        }
        openStamp.current += 1
        setOpenTarget({
          id,
          stamp: openStamp.current,
          revision: location?.revision ?? null,
          page: location?.page ?? null,
          anchor: location?.anchor ?? null,
        })
        setOpenId(id)
      },
    }),
    [placed.byTicket, placed.loose],
  )
  return (
    <CanvasPlaceContext.Provider value={place}>
      {children}
      {listError ? <p className="canvas-list-error">{t('canvas.unavailable')}</p> : null}
      {open ? (
        <CanvasPreview
          title={open.title}
          revisions={revisions}
          activeRevision={shown}
          phase={phase}
          error={error}
          src={src}
          onSelect={revision => void show(open.id, revision)}
          onRetry={() => {
            if (shown != null) void show(open.id, shown)
            else if (followRevision != null) void show(open.id, followRevision)
          }}
          onAdopt={() => {
            if (shown == null) return
            void api(`/canvas/${open.id}/adopt`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revision: shown }),
            }).then(response => {
              if (response.status !== 200) return
              void api(`/canvas/${open.id}`).then(detail => {
                if (detail.status === 200) setRevisions(asRevisions(detail.body))
              })
              void api(`/canvas?sessionId=${encodeURIComponent(sessionId)}`).then(list => {
                if (list.status === 200) setItems(asSummaries(list.body))
              })
            })
          }}
          onClose={() => setOpenId(null)}
          origin={openOrigin}
          onOpened={() => setPaint(true)}
          canvasId={open.id}
          onMention={onMention}
          routeStamp={openTarget?.id === open.id ? openTarget.stamp : 0}
          routePage={openTarget?.id === open.id ? openTarget.page : null}
          routeAnchor={openTarget?.id === open.id ? openTarget.anchor : null}
        />
      ) : null}
    </CanvasPlaceContext.Provider>
  )
}
