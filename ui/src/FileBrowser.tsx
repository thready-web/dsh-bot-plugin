import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { useDrawerFrame } from './drawer-frame'
import { DRAWER_PREF, clampDrawerWidth, initialFileLocation } from './file-layout'
import { isMarkdownName } from './highlight'
import { useI18n } from './locale'
import { MarkdownView } from './MarkdownView'

const SourceEditor = lazy(() => import('./SourceEditor'))

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const DRAWER_WIDTH_KEY = 'dsh-bot.files-drawer-width'

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

interface Entry {
  name: string
  kind: 'dir' | 'file' | 'link'
  size: number
  mtime: string
}

interface Roots {
  workspace: string | null
  workspaceReason: string
  home: string | null
  homeReason: string
}

type Preview =
  | { kind: 'loading'; path: string; name: string }
  | { kind: 'text'; path: string; name: string; text: string; eof: boolean }
  | { kind: 'image'; path: string; name: string; url: string }
  | { kind: 'binary'; path: string; name: string; size: number }
  | { kind: 'error'; path: string; name: string }

type Shown =
  | { kind: 'list'; key: string; path: string; root: 'workspace' | 'home'; items: Entry[]; error: string }
  | {
      kind: 'file'
      key: string
      path: string
      root: 'workspace' | 'home'
      preview: Exclude<Preview, { kind: 'loading' }>
    }

export function FileBrowser({
  open,
  sessionId,
  focus,
  onClose,
}: {
  open: boolean
  sessionId: string
  focus: { path: string; line?: number; token: number } | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [roots, setRoots] = useState<Roots | null>(null)
  const [root, setRoot] = useState<'workspace' | 'home'>('workspace')
  const [path, setPath] = useState('')
  const [items, setItems] = useState<Entry[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [tick, setTick] = useState(0)
  const [width, setWidth] = useState(readDrawerWidth)
  const widthRef = useRef(width)
  const [resizing, setResizing] = useState(false)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [present, setPresent] = useState(open)
  const [motion, setMotion] = useState<'in' | 'out'>(open ? 'in' : 'out')
  const [highlightLine, setHighlightLine] = useState<number | undefined>()
  const [citedPath, setCitedPath] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [pending, setPending] = useState<File | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [needsOverwrite, setNeedsOverwrite] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [copiedPath, setCopiedPath] = useState('')
  const dragDepth = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const imageUrl = useRef('')
  const alive = useRef(true)
  const requestId = useRef(0)
  const focusRef = useRef(focus)
  const presentRef = useRef(present)
  const motionRef = useRef(motion)
  focusRef.current = focus
  presentRef.current = present
  motionRef.current = motion

  useEffect(
    () => () => {
      alive.current = false
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    },
    [],
  )

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
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const laidOut = clampDrawerWidth(width)

  useDrawerFrame({ present, narrow, motion, width: laidOut, resizing, viewport })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pending && progress == null) {
        setPending(null)
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, pending, progress])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setRoots(null)
    if (!focusRef.current) {
      setPath('')
      setPreview(null)
      setNotice('')
    }
    void api(`/files/roots?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        const workspace = typeof result.body.workspace === 'string' ? result.body.workspace : null
        const home = typeof result.body.home === 'string' ? result.body.home : null
        const workspaceReason = typeof result.body.workspaceReason === 'string' ? result.body.workspaceReason : ''
        const homeReason = typeof result.body.homeReason === 'string' ? result.body.homeReason : ''
        setRoots({ workspace, workspaceReason, home, homeReason })
        if (focusRef.current) return
        const location = initialFileLocation({ workspace, home, workspaceReason })
        if (location.kind === 'path') {
          setRoot(location.root)
          setPath(location.path)
        } else {
          setPhase('error')
          setNotice(t(location.notice))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPhase('error')
          setNotice(t('files.failed'))
        }
      })
    return () => controller.abort()
  }, [open, sessionId, t])

  useEffect(() => {
    if (!open || !focus || !roots) return
    const absolute = resolveFocusPath(roots.workspace, focus.path)
    if (!absolute) {
      const location = initialFileLocation(roots)
      setPhase('error')
      setNotice(t(location.kind === 'unavailable' ? location.notice : 'files.missing'))
      return
    }
    const request = ++requestId.current
    const controller = new AbortController()
    const name = absolute.split('/').filter(Boolean).at(-1) ?? absolute
    const located = rootFor(absolute, roots.workspace, roots.home)
    setHighlightLine(focus.line)
    setNotice('')
    if (located) setRoot(located)
    void api(`/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(absolute)}`, {
      signal: controller.signal,
    })
      .then(listed => {
        if (request !== requestId.current || !alive.current) return
        if (listed.status === 200 && Array.isArray(listed.body.items)) {
          setHighlightLine(undefined)
          setCitedPath('')
          setPreview(null)
          setPhase('loading')
          if (listed.body.root === 'workspace' || listed.body.root === 'home') setRoot(listed.body.root)
          setPath(typeof listed.body.path === 'string' ? listed.body.path : absolute)
          return
        }
        setCitedPath(absolute)
        setPath(parentDirectory(absolute))
        return openPreview(absolute, name, 0, request)
      })
      .catch(() => {
        if (request !== requestId.current || !alive.current || controller.signal.aborted) return
        setPreview({ kind: 'error', path: absolute, name })
      })
    return () => controller.abort()
  }, [open, focus, roots, sessionId, t])

  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    setPhase('loading')
    setNotice('')
    void api(`/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then(result => {
        if (controller.signal.aborted) return
        if (result.status !== 200 || !Array.isArray(result.body.items)) {
          setItems([])
          setPhase('error')
          setNotice(fileNotice(result.body.error, t))
          return
        }
        const canonical = typeof result.body.path === 'string' ? result.body.path : path
        setItems(result.body.items.filter(isEntry))
        setPhase('ready')
        if (result.body.root === 'workspace' || result.body.root === 'home') setRoot(result.body.root)
        if (canonical !== path) setPath(canonical)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPhase('error')
          setNotice(t('files.failed'))
        }
      })
    return () => controller.abort()
  }, [path, sessionId, tick, t])

  function rememberImage(url: string) {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    imageUrl.current = url
  }

  function chooseRoot(next: 'workspace' | 'home') {
    const target = next === 'workspace' ? roots?.workspace : roots?.home
    if (!target) return
    setRoot(next)
    setPreview(null)
    setPending(null)
    if (target === path) return
    setPhase('loading')
    setPath(target)
  }

  async function openEntry(entry: Entry) {
    const next = joinPath(path, entry.name)
    if (entry.kind === 'file') {
      await openPreview(next, entry.name, entry.size)
      return
    }
    if (entry.kind === 'link') {
      const listed = await api(`/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(next)}`)
      if (!alive.current) return
      if (listed.status !== 200) {
        if (listed.body.error === 'not_directory') {
          await openPreview(next, entry.name, entry.size)
          return
        }
        setNotice(fileNotice(listed.body.error, t))
        return
      }
      setPreview(null)
      setPhase('loading')
      setPath(typeof listed.body.path === 'string' ? listed.body.path : next)
      return
    }
    setPreview(null)
    setPhase('loading')
    setPath(next)
  }

  async function openAt(next: string) {
    const listed = await api(`/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(next)}`)
    if (!alive.current) return
    if (listed.status === 200 && Array.isArray(listed.body.items)) {
      setPreview(null)
      setPhase('loading')
      if (listed.body.root === 'workspace' || listed.body.root === 'home') setRoot(listed.body.root)
      setPath(typeof listed.body.path === 'string' ? listed.body.path : next)
      return
    }
    if (listed.body.error === 'not_directory') {
      const name = next.split('/').filter(Boolean).at(-1) ?? next
      await openPreview(next, name, 0)
      return
    }
    setNotice(fileNotice(listed.body.error, t))
  }

  async function openPreview(filePath: string, name: string, size: number, request = ++requestId.current) {
    const current = () => alive.current && request === requestId.current
    setPreview({ kind: 'loading', path: filePath, name })
    const image = imageType(name)
    if (image) {
      try {
        const response = await fetch(rawUrl(sessionId, filePath))
        if (!current()) return
        if (!response.ok) {
          setPreview({ kind: 'error', path: filePath, name })
          return
        }
        const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: image }))
        if (!current()) {
          URL.revokeObjectURL(url)
          return
        }
        rememberImage(url)
        setPreview({ kind: 'image', path: filePath, name, url })
      } catch {
        if (current()) setPreview({ kind: 'error', path: filePath, name })
      }
      return
    }
    const result = await api(
      `/files/text?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
    )
    if (!current()) return
    if (result.status === 415 || result.body.error === 'binary') {
      setPreview({ kind: 'binary', path: filePath, name, size })
      return
    }
    if (result.status !== 200 || typeof result.body.text !== 'string') {
      setPreview({ kind: 'error', path: filePath, name })
      return
    }
    setPreview({
      kind: 'text',
      path: filePath,
      name,
      text: result.body.text,
      eof: result.body.eof !== false,
    })
  }

  function stage(file: File) {
    if (progress != null) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice(t('files.tooLarge'))
      setPending(null)
      return
    }
    setNotice('')
    setOverwrite(false)
    setNeedsOverwrite(false)
    setProgress(null)
    setPending(file)
  }

  async function upload() {
    if (!pending || !path || progress != null) return
    setProgress(0)
    setNotice('')
    try {
      const result = await postFile(sessionId, path, pending, overwrite, setProgress)
      if (!alive.current) return
      if (result.status === 409) {
        setNeedsOverwrite(true)
        setNotice(t('files.exists'))
        setProgress(null)
        return
      }
      if (result.status !== 201 || typeof result.body.path !== 'string') {
        setNotice(fileNotice(result.body.error, t))
        setProgress(null)
        return
      }
      setPending(null)
      setProgress(null)
      setTick(value => value + 1)
    } catch {
      if (!alive.current) return
      setNotice(t('files.failed'))
      setProgress(null)
    }
  }

  const panelRef = useRef<Shown | null>(null)
  const swapToken = useRef(0)
  const [panel, setPanel] = useState<Shown | null>(null)
  const [concealed, setConcealed] = useState(false)

  useEffect(() => {
    let next: Shown | null = null
    if (preview) {
      if (preview.kind !== 'loading') next = { kind: 'file', key: `file:${preview.path}`, path, root, preview }
    } else if (path && phase !== 'loading') {
      next =
        phase === 'error'
          ? { kind: 'list', key: `dir:${path}`, path, root, items: [], error: notice || t('files.failed') }
          : { kind: 'list', key: `dir:${path}`, path, root, items, error: '' }
    }
    if (!next) {
      if (!path && !preview) {
        panelRef.current = null
        setPanel(null)
      }
      setConcealed(false)
      return
    }
    const current = panelRef.current
    if (current?.key === next.key) {
      const same =
        current.root === next.root &&
        current.path === next.path &&
        (current.kind === 'file' && next.kind === 'file'
          ? current.preview === next.preview
          : current.kind === 'list' &&
            next.kind === 'list' &&
            current.items === next.items &&
            current.error === next.error)
      if (same) return
      panelRef.current = next
      setPanel(next)
      return
    }
    if (!current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      panelRef.current = next
      setPanel(next)
      setConcealed(false)
      return
    }
    const token = ++swapToken.current
    setConcealed(true)
    const timer = window.setTimeout(() => {
      if (swapToken.current !== token) return
      panelRef.current = next
      setPanel(next)
      setConcealed(false)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [preview, items, phase, path, root, notice, t])

  useEffect(() => {
    const showingImage = panel?.kind === 'file' && panel.preview.kind === 'image'
    const incomingImage = preview?.kind === 'image' || preview?.kind === 'loading'
    if (showingImage || incomingImage || !imageUrl.current) return
    URL.revokeObjectURL(imageUrl.current)
    imageUrl.current = ''
  }, [panel, preview])

  const shownRoot = panel?.root ?? root
  const crumbPath = panel?.path || path
  const rootPath = shownRoot === 'workspace' ? roots?.workspace : roots?.home
  const crumbs = rootPath ? breadcrumb(rootPath, crumbPath) : []
  const fileCrumb = panel?.kind === 'file' ? { name: panel.preview.name, path: panel.preview.path } : null
  const listedError = panel?.kind === 'list' ? panel.error : ''

  function copyPath(target: string) {
    void navigator.clipboard.writeText(target).then(() => {
      setCopiedPath(target)
      window.setTimeout(() => setCopiedPath(current => (current === target ? '' : current)), 1000)
    })
  }
  const taken = pending != null && (needsOverwrite || items.some(item => item.name === pending.name))
  const uploading = progress != null
  if (!present) return null

  return createPortal(
    <div
      className={
        narrow
          ? `files-drawer narrow files-drawer-${motion}`
          : `files-drawer files-drawer-${motion}${resizing ? ' resizing' : ''}`
      }
      style={narrow ? undefined : { width: laidOut }}
      role="dialog"
      aria-label={t('files.title')}
      onAnimationEnd={event => {
        if (event.target !== event.currentTarget || event.animationName !== 'files-drawer-out') return
        if (motionRef.current === 'out') setPresent(false)
      }}
      onDragEnter={event => {
        event.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1
        if (dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragOver(false)
        }
      }}
      onDrop={event => {
        event.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        const file = event.dataTransfer.files[0]
        if (file) stage(file)
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
        <button type="button" className="files-icon-btn" aria-label={t('file.close')} onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="files-roots" role="tablist">
          <button
            type="button"
            role="tab"
            className="files-icon-btn"
            aria-selected={shownRoot === 'home'}
            aria-label={t('files.home')}
            disabled={!roots?.home}
            title={roots?.home || rootHint(roots?.homeReason, t)}
            onClick={() => chooseRoot('home')}
          >
            <HomeIcon />
          </button>
          <button
            type="button"
            role="tab"
            className="files-icon-btn"
            aria-selected={shownRoot === 'workspace'}
            aria-label={t('files.workspace')}
            disabled={!roots?.workspace}
            title={roots?.workspace ?? rootHint(roots?.workspaceReason, t)}
            onClick={() => chooseRoot('workspace')}
          >
            <FolderIcon />
          </button>
        </div>
        <nav className="files-crumbs" aria-label={t('files.title')}>
          {crumbs.length > 0 || fileCrumb ? <span aria-hidden="true">/</span> : null}
          {crumbs.map((crumb, index) => (
            <span key={crumb.path}>
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              <button
                type="button"
                title={crumb.path}
                onClick={() => {
                  if (crumb.path === path && !preview) return
                  setPreview(null)
                  if (crumb.path !== path) {
                    setPhase('loading')
                    setPath(crumb.path)
                  }
                }}
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {fileCrumb ? (
            <span>
              {crumbs.length > 0 ? <span aria-hidden="true">/</span> : null}
              <span className="files-crumb-current" title={fileCrumb.path}>
                {fileCrumb.name}
              </span>
            </span>
          ) : null}
          {crumbPath ? (
            <button
              type="button"
              className="files-icon-btn files-crumb-copy"
              aria-label={t('files.pathHint')}
              title={copiedPath === (fileCrumb?.path || crumbPath) ? t('files.copied') : t('files.pathHint')}
              onClick={() => copyPath(fileCrumb?.path || crumbPath)}
            >
              {copiedPath === (fileCrumb?.path || crumbPath) ? <CheckIcon /> : <CopyIcon />}
            </button>
          ) : null}
        </nav>
        <button
          type="button"
          className="files-icon-btn files-upload"
          aria-label={t('files.upload')}
          title={t('files.upload')}
          disabled={!path || uploading}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) stage(file)
          }}
        />
      </header>
      {notice && notice !== listedError ? <p className="files-notice">{notice}</p> : null}
      {dragOver ? <div className="files-drop">{t('files.drop')}</div> : null}
      <div className="files-body">
        {panel ? (
          <div className={concealed ? 'files-stage out' : 'files-stage in'}>
            {panel.kind === 'file' ? (
              <PreviewPane
                preview={panel.preview}
                sessionId={sessionId}
                line={panel.preview.path === citedPath ? highlightLine : undefined}
                onOpenPath={next => void openAt(next)}
              />
            ) : panel.error ? (
              <p className="files-status">{panel.error}</p>
            ) : panel.items.length === 0 ? (
              <div className="files-empty">
                <span className="files-empty-mark" aria-hidden="true">
                  <EmptyDirIcon />
                </span>
                <p>{t('files.empty')}</p>
              </div>
            ) : (
              <div className="files-table" role="table">
                <div className="files-row files-columns" role="row">
                  <span role="columnheader">{t('files.name')}</span>
                  <span className="files-col-type" role="columnheader">
                    {t('files.type')}
                  </span>
                  <span className="files-col-size" role="columnheader">
                    {t('files.size')}
                  </span>
                  <span className="files-col-time" role="columnheader">
                    {t('files.modified')}
                  </span>
                  <span />
                </div>
                {panel.items.map(entry => (
                  <div className="files-row" role="row" key={entry.name}>
                    <button type="button" className="files-name" onClick={() => void openEntry(entry)}>
                      <span className={entry.kind === 'dir' ? 'files-mark dir' : 'files-mark'}>
                        {markFor(entry.kind)}
                      </span>
                      <span>{entry.name}</span>
                    </button>
                    <span className="files-col-type">{typeLabel(entry, t)}</span>
                    <span className="files-col-size">{entry.kind === 'file' ? formatSize(entry.size) : '—'}</span>
                    <span className="files-col-time">{formatWhen(entry.mtime)}</span>
                    <span className="files-row-actions">
                      {entry.kind === 'file' ? (
                        <a className="files-action" href={rawUrl(sessionId, joinPath(path, entry.name))}>
                          <DownloadIcon />
                          {t('files.download')}
                        </a>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : phase === 'loading' ? (
          <p className="files-status">{t('files.loading')}</p>
        ) : null}
      </div>
      {pending ? (
        <div className="files-confirm">
          <p>{t('files.confirm')}</p>
          <p className="files-confirm-name">
            <strong>{pending.name}</strong>
            <span>{formatSize(pending.size)}</span>
          </p>
          <p className="files-confirm-dest">{path}</p>
          {uploading ? (
            <div
              className="files-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress ?? 0) * 100)}
            >
              <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
              <span>{t('files.uploading')}</span>
            </div>
          ) : null}
          {taken ? (
            <label className="files-check">
              <input
                type="checkbox"
                checked={overwrite}
                disabled={uploading}
                onChange={event => setOverwrite(event.target.checked)}
              />
              {t('files.overwrite')}
            </label>
          ) : null}
          <div className="files-confirm-actions">
            <button type="button" disabled={uploading} onClick={() => setPending(null)}>
              {t('files.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={uploading || (taken && !overwrite)}
              onClick={() => void upload()}
            >
              {t('files.upload')}
            </button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

function PreviewPane({
  preview,
  sessionId,
  line,
  onOpenPath,
}: {
  preview: Preview
  sessionId: string
  line?: number
  onOpenPath: (path: string) => void
}) {
  const { t } = useI18n()
  const markdown = preview.kind === 'text' && isMarkdownName(preview.name)
  const [mode, setMode] = useState<'preview' | 'source'>(markdown && line == null ? 'preview' : 'source')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setMode(markdown && line == null ? 'preview' : 'source')
    setCopied(false)
  }, [preview.path, markdown, line])
  if (preview.kind === 'loading') return <p className="files-status">{t('file.loading')}</p>
  if (preview.kind === 'error') return <p className="files-status">{t('file.error')}</p>
  const text = preview.kind === 'text' ? preview.text : ''
  const eof = preview.kind === 'text' ? preview.eof : true
  const showSource = preview.kind === 'text' && (!markdown || mode === 'source')
  return (
    <div className="files-preview">
      <div className="files-preview-bar">
        <span>
          {markdown ? (
            <span role="group" aria-label={t('files.previewMode')}>
              <button
                type="button"
                className="files-action"
                aria-pressed={mode === 'preview'}
                onClick={() => setMode('preview')}
              >
                <EyeIcon />
                {t('files.previewMode')}
              </button>
              <button
                type="button"
                className="files-action"
                aria-pressed={mode === 'source'}
                onClick={() => setMode('source')}
              >
                <CodeIcon />
                {t('files.sourceMode')}
              </button>
            </span>
          ) : null}
          {preview.kind === 'text' ? (
            <button
              type="button"
              className="files-action"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1000)
                })
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? t('files.copied') : t('files.copy')}
            </button>
          ) : null}
          <a className="files-action" href={rawUrl(sessionId, preview.path)}>
            <DownloadIcon />
            {t('files.download')}
          </a>
        </span>
      </div>
      {preview.kind === 'image' ? (
        <div className="files-image">
          <img src={preview.url} alt={preview.name} />
        </div>
      ) : preview.kind === 'binary' ? (
        <p className="files-status">
          {t('files.binary')} {formatSize(preview.size)}
        </p>
      ) : showSource ? (
        <>
          <Suspense fallback={<p className="files-status">{t('file.loading')}</p>}>
            <SourceEditor text={text} name={preview.name} line={line} />
          </Suspense>
          {eof ? null : <p className="file-modal-note">{t('files.truncated')}</p>}
        </>
      ) : (
        <div className="files-markdown">
          <MarkdownView
            text={text}
            onOpenFile={target => {
              const next = target.startsWith('/') ? target : resolveRelative(preview.path, target)
              if (next) onOpenPath(next)
            }}
            resolveImage={src => siblingImage(sessionId, preview.path, src)}
          />
          {eof ? null : <p className="file-modal-note">{t('files.truncated')}</p>}
        </div>
      )}
    </div>
  )
}

function rootHint(
  reason: string | undefined,
  t: (key: 'files.overlap' | 'files.denied' | 'files.missing') => string,
): string | undefined {
  if (reason === 'overlap') return t('files.overlap')
  if (reason === 'forbidden' || reason === 'invalid') return t('files.denied')
  if (reason === 'missing') return t('files.missing')
  return undefined
}

function resolveFocusPath(workspace: string | null, target: string): string | null {
  const cleaned = target.replace(/^\.\//, '')
  if (cleaned.startsWith('/')) return cleaned
  if (!workspace) return null
  return joinPath(workspace, cleaned)
}

function rootFor(filePath: string, workspace: string | null, home: string | null): 'workspace' | 'home' | null {
  if (workspace && (filePath === workspace || filePath.startsWith(`${workspace}/`))) return 'workspace'
  if (home && (filePath === home || filePath.startsWith(`${home}/`))) return 'home'
  return null
}

function parentDirectory(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  if (slash <= 0) return '/'
  return filePath.slice(0, slash)
}

function siblingImage(sessionId: string, filePath: string, src: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) return undefined
  const next = src.startsWith('/') ? src : resolveRelative(filePath, src)
  if (!next) return undefined
  return `${rawUrl(sessionId, next)}&inline=1`
}

function resolveRelative(filePath: string, relative: string): string | null {
  const directory = filePath.slice(0, filePath.lastIndexOf('/'))
  const base = directory === '' ? [] : directory.split('/').filter(Boolean)
  const parts = directory.startsWith('/') ? [...base] : base
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) return null
  return `/${parts.join('/')}`
}

function breadcrumb(rootPath: string, path: string): { name: string; path: string }[] {
  if (!path.startsWith(rootPath)) return []
  const rest = (rootPath === '/' ? path.slice(1) : path.slice(rootPath.length).replace(/^\//, ''))
    .split('/')
    .filter(Boolean)
  const items: { name: string; path: string }[] = []
  let acc = rootPath
  for (const part of rest) {
    acc = acc === '/' ? `/${part}` : `${acc}/${part}`
    items.push({ name: part, path: acc })
  }
  return items
}

function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/$/, '')}/${name}`
}

function rawUrl(sessionId: string, path: string): string {
  return `/dsh-bot/api/files/raw?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Entry
  return (
    typeof entry.name === 'string' &&
    (entry.kind === 'dir' || entry.kind === 'file' || entry.kind === 'link') &&
    typeof entry.size === 'number' &&
    typeof entry.mtime === 'string'
  )
}

function fileNotice(
  error: unknown,
  t: (
    key:
      | 'files.denied'
      | 'files.missing'
      | 'files.binary'
      | 'files.exists'
      | 'files.tooLarge'
      | 'files.overlap'
      | 'files.failed',
  ) => string,
): string {
  if (error === 'denied') return t('files.denied')
  if (error === 'missing') return t('files.missing')
  if (error === 'binary') return t('files.binary')
  if (error === 'exists') return t('files.exists')
  if (error === 'too_large') return t('files.tooLarge')
  if (error === 'overlap') return t('files.overlap')
  return t('files.failed')
}

function typeLabel(entry: Entry, t: (key: 'files.folder' | 'files.link' | 'files.file') => string): string {
  if (entry.kind === 'dir') return t('files.folder')
  if (entry.kind === 'link') return t('files.link')
  const ext = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '') : ''
  return ext ? ext.toUpperCase() : t('files.file')
}

function markFor(kind: Entry['kind']): string {
  if (kind === 'dir') return '▸'
  if (kind === 'link') return '↗'
  return '·'
}

function imageType(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute}`
}

function postFile(
  sessionId: string,
  dir: string,
  file: File,
  overwrite: boolean,
  onProgress: (value: number) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const query = `/dsh-bot/api/files?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&overwrite=${overwrite ? '1' : '0'}`
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', query)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(xhr.responseText)
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
      } catch {
        body = {}
      }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => reject(new Error('failed'))
    xhr.send(file)
  })
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

function EmptyDirIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.2 7.4c0-.9.7-1.6 1.6-1.6h4.4l1.6 1.7h8.4c.9 0 1.6.7 1.6 1.6v8.5c0 .9-.7 1.6-1.6 1.6H4.8c-.9 0-1.6-.7-1.6-1.6V7.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.8 5.1c0-.6.5-1.1 1.1-1.1h3.2l1.2 1.4h5.8c.6 0 1.1.5 1.1 1.1v5.9c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V5.1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.2 7.2 8 2.7l5.8 4.5V13H10V9.3H6V13H2.2V7.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 4.2h6.2v8.2H6zM4.2 11.6H3.6V2.8h6.6V4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.4 8.2 6.4 11.2 12.6 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.6v6.2M5.2 6.4 8 9.2l2.8-2.8M3.2 12.6h9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.6 8s2.2-3.3 6.4-3.3S14.4 8 14.4 8s-2.2 3.3-6.4 3.3S1.6 8 1.6 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 4.4 2.8 8 6 11.6M10 4.4 13.2 8 10 11.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.6v6.1M5.2 5.3 8 2.6l2.8 2.7M3.2 9.1V12.4h9.6V9.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
