import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

const emptyCanvasPlace = {
  byTicket: new Map<string, CanvasSummary>(),
  loose: [] as CanvasSummary[],
  open: (_id: string) => {},
}

const CanvasPlaceContext = createContext<{
  byTicket: Map<string, CanvasSummary>
  loose: readonly CanvasSummary[]
  open: (id: string) => void
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

export function CanvasPreview({
  title,
  revisions,
  activeRevision,
  phase,
  error,
  src,
  onSelect,
  onRetry,
  onAdopt,
  onClose,
}: {
  title: string
  revisions: RevisionSummary[]
  activeRevision: number | null
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  src: string
  onSelect: (revision: number) => void
  onRetry: () => void
  onAdopt: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [device, setDevice] = useState<(typeof DEVICES)[number]['id']>('desktop')
  const name = title || t('canvas.card')
  const active = revisions.find(revision => revision.revision === activeRevision) ?? null
  const width = DEVICES.find(item => item.id === device)?.width ?? 1280

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
    if (frameRef.current && src) frameRef.current.src = src
  }, [src])

  const resetPage = () => {
    const frame = frameRef.current
    if (!frame || !src) return
    const next = `${src}${src.includes('?') ? '&' : '?'}r=${Date.now()}`
    try {
      frame.contentWindow?.location.replace(new URL(next, window.location.href).href)
    } catch {
      frame.src = next
    }
  }

  return createPortal(
    <div
      className="canvas-modal"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={dialog} className="canvas-dialog" role="dialog" aria-modal="true" aria-label={name}>
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
              onClick={onClose}
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
          {src ? (
            <div className="canvas-frame" style={{ width: `min(100%, ${width}px)` }}>
              <iframe ref={frameRef} title={name} sandbox="" referrerPolicy="no-referrer" />
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
  children,
}: {
  sessionId: string
  pulse: number
  tickets: readonly { id: string; status: string }[]
  children: ReactNode
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<CanvasSummary[]>([])
  const [listError, setListError] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [shown, setShown] = useState<number | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [src, setSrc] = useState('')
  const cacheRef = useRef<CanvasCache>(emptyCanvasCache())
  const loadedCanvas = useRef<string | null>(null)
  const requestRef = useRef(0)
  const open = items.find(item => item.id === openId) ?? null
  const followRevision = open?.previewRevision ?? open?.stableRevision ?? null
  const showRef = useRef<(canvasId: string, revision: number) => Promise<void>>(async () => {})

  useEffect(() => {
    setOpenId(null)
    setItems([])
    setListError(false)
  }, [sessionId])

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
    if (!openId || followRevision == null) return
    void showRef.current(openId, followRevision)
    return () => {
      requestRef.current += 1
    }
  }, [openId, followRevision])

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
    () => ({ byTicket: placed.byTicket, loose: placed.loose, open: (id: string) => setOpenId(id) }),
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
        />
      ) : null}
    </CanvasPlaceContext.Provider>
  )
}
