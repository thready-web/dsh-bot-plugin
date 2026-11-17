import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerFrame } from './drawer-frame.ts'
import { DRAWER_PREF, clampDrawerWidth } from './file-layout.ts'
import { foundations } from './foundations.ts'
import type { Copy, MessageKey } from './i18n/index.ts'
import { useI18n } from './locale.tsx'
import {
  MEMORY_TYPES,
  readCitations,
  readEntities,
  readEntity,
  readFrames,
  type CitationForm,
  type MemoryCitation,
  type MemoryCreator,
  type MemoryEntity,
  type MemoryFrame,
  type MemoryLifecycle,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
} from './memory.ts'

type ScopeFilter = MemoryScope | 'all'
type LifeFilter = MemoryLifecycle | 'all'
type TypeFilter = MemoryType | 'all'
type FrameChoice = 'auto' | 'none' | number

const DRAWER_WIDTH_KEY = 'dsh-bot.memory-drawer-width'

const TYPE_KEY: Record<MemoryType, MessageKey> = {
  persona: 'memory.type.persona',
  profile: 'memory.type.profile',
  fact: 'memory.type.fact',
  episodic: 'memory.type.episodic',
  procedural: 'memory.type.procedural',
  state: 'memory.type.state',
  skill: 'memory.type.skill',
}

const SCOPE_KEY: Record<MemoryScope, MessageKey> = {
  user: 'memory.scope.user',
  session: 'memory.scope.session',
  work: 'memory.scope.work',
  skill: 'memory.scope.skill',
}

const LIFE_KEY: Record<MemoryLifecycle, MessageKey> = {
  active: 'memory.lifecycle.active',
  corrected: 'memory.lifecycle.corrected',
  forgotten: 'memory.lifecycle.forgotten',
  candidate: 'memory.lifecycle.candidate',
}

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

export function MemoryPanel({ open, sessionId, onClose }: { open: boolean; sessionId: string; onClose: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [lifecycle, setLifecycle] = useState<LifeFilter>('all')
  const [type, setType] = useState<TypeFilter>('all')
  const [entities, setEntities] = useState<MemoryEntity[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [capped, setCapped] = useState(false)
  const [frames, setFrames] = useState<MemoryFrame[]>([])
  const [frameChoice, setFrameChoice] = useState<FrameChoice>('auto')
  const [citations, setCitations] = useState<MemoryCitation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MemoryEntity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [width, setWidth] = useState(readDrawerWidth)
  const widthRef = useRef(width)
  const [resizing, setResizing] = useState(false)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [present, setPresent] = useState(open)
  const [motion, setMotion] = useState<'in' | 'out'>(open ? 'in' : 'out')
  const presentRef = useRef(present)
  const motionRef = useRef(motion)
  presentRef.current = present
  motionRef.current = motion
  const laidOut = clampDrawerWidth(width)

  useDrawerFrame({ present, narrow, motion, width: laidOut, resizing, viewport })

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

  useEffect(() => {
    setDraft('')
    setQuery('')
    setSelectedId(null)
    setDetail(null)
    setFrameChoice('auto')
    setEntities([])
    setFrames([])
    setCitations([])
    setNextCursor(null)
  }, [sessionId])

  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 200)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    setError('')
    void foundations(entityPath(sessionId, { query, scope, lifecycle, type }, null)).then(response => {
      if (stop) return
      if (response.status !== 200 || response.body.ok === false) {
        setEntities([])
        setNextCursor(null)
        setError(failureText(response.status, t))
        setLoading(false)
        return
      }
      setEntities(readEntities(response.body))
      setNextCursor(typeof response.body.nextCursor === 'string' ? response.body.nextCursor : null)
      setCapped(response.body.capped === true)
      setLoading(false)
    })
    return () => {
      stop = true
    }
  }, [open, sessionId, query, scope, lifecycle, type, refresh, t])

  useEffect(() => {
    if (!open) return
    let stop = false
    void foundations(`/dsh-bot/api/memory/frames?sessionId=${encodeURIComponent(sessionId)}`).then(response => {
      if (stop || response.body.ok === false) return
      setFrames(readFrames(response.body))
    })
    return () => {
      stop = true
    }
  }, [open, sessionId, refresh])

  const revision = frameChoice === 'none' ? null : frameChoice === 'auto' ? (frames[0]?.revision ?? null) : frameChoice
  const idKey = entities.map(entity => entity.id).join(',')

  useEffect(() => {
    if (!open || revision == null || idKey === '') {
      setCitations([])
      return
    }
    let stop = false
    const params = new URLSearchParams({
      sessionId,
      revision: String(revision),
      ids: idKey,
    })
    void foundations(`/dsh-bot/api/memory/context?${params}`).then(response => {
      if (stop || response.body.ok === false) return
      setCitations(readCitations(response.body))
    })
    return () => {
      stop = true
    }
  }, [open, sessionId, revision, idKey])

  useEffect(() => {
    if (!open || selectedId == null) {
      setDetail(null)
      return
    }
    let stop = false
    const params = new URLSearchParams({ sessionId })
    void foundations(`/dsh-bot/api/memory/entities/${encodeURIComponent(selectedId)}?${params}`).then(response => {
      if (stop) return
      setDetail(response.body.ok === false ? null : readEntity(response.body))
    })
    return () => {
      stop = true
    }
  }, [open, sessionId, selectedId, refresh])

  useEffect(() => {
    if (!present) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (selectedId != null) {
        setSelectedId(null)
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [present, selectedId, onClose])

  async function more() {
    if (nextCursor == null) return
    const response = await foundations(entityPath(sessionId, { query, scope, lifecycle, type }, nextCursor))
    if (response.status !== 200 || response.body.ok === false) {
      setError(failureText(response.status, t))
      return
    }
    setEntities(current => [...current, ...readEntities(response.body)])
    setNextCursor(typeof response.body.nextCursor === 'string' ? response.body.nextCursor : null)
  }

  const selected = entities.find(entity => entity.id === selectedId) ?? null
  const shown = detail && detail.id === selectedId ? detail : selected
  const citationFor = (id: string): MemoryCitation | null => {
    if (revision == null) return null
    return citations.find(item => item.id === id) ?? { id, form: 'unknown', reason: 'no_manifest' }
  }

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
      aria-label={t('memory.title')}
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
        <button type="button" className="files-icon-btn" aria-label={t('memory.close')} onClick={onClose}>
          <CloseIcon />
        </button>
        <nav className="files-crumbs" aria-label={t('memory.title')}>
          <button type="button" onClick={() => setSelectedId(null)}>
            {t('memory.title')}
          </button>
          {shown ? (
            <span>
              <span aria-hidden="true">/</span>
              <span className="files-crumb-current">{rowLabel(shown, t('memory.missing'))}</span>
            </span>
          ) : null}
        </nav>
        <button
          type="button"
          className="files-icon-btn files-upload"
          aria-label={t('memory.refresh')}
          onClick={() => setRefresh(value => value + 1)}
        >
          <RefreshIcon />
        </button>
      </header>
      {shown ? null : (
        <div className="memory-bar">
          <input
            className="memory-search"
            value={draft}
            placeholder={t('memory.search')}
            aria-label={t('memory.search')}
            onChange={event => setDraft(event.target.value)}
          />
          <select
            aria-label={t('memory.scope')}
            value={scope}
            onChange={event => setScope(event.target.value as ScopeFilter)}
          >
            <option value="all">{t('memory.scope.all')}</option>
            <option value="user">{t('memory.scope.user')}</option>
            <option value="session">{t('memory.scope.session')}</option>
            <option value="work">{t('memory.scope.work')}</option>
            <option value="skill">{t('memory.scope.skill')}</option>
          </select>
          <select
            aria-label={t('memory.lifecycle')}
            value={lifecycle}
            onChange={event => setLifecycle(event.target.value as LifeFilter)}
          >
            <option value="all">{t('memory.lifecycle.all')}</option>
            <option value="active">{t('memory.lifecycle.active')}</option>
            <option value="corrected">{t('memory.lifecycle.corrected')}</option>
            <option value="forgotten">{t('memory.lifecycle.forgotten')}</option>
            <option value="candidate">{t('memory.lifecycle.candidate')}</option>
          </select>
          <select
            aria-label={t('memory.kind')}
            value={type}
            onChange={event => setType(event.target.value as TypeFilter)}
          >
            <option value="all">{t('memory.type.all')}</option>
            {MEMORY_TYPES.map(kind => (
              <option key={kind} value={kind}>
                {t(TYPE_KEY[kind])}
              </option>
            ))}
          </select>
          {frames.length === 0 ? (
            <span className="memory-note">{t('memory.frame.none')}</span>
          ) : (
            <select
              id="memory-frame"
              aria-label={t('memory.frame')}
              title={t('memory.frame.hint')}
              value={revision == null ? 'none' : String(revision)}
              onChange={event => {
                const value = event.target.value
                setFrameChoice(value === 'none' ? 'none' : Number(value))
              }}
            >
              <option value="none">{t('memory.frame.unselected')}</option>
              {frames.map(frame => (
                <option key={frame.revision} value={frame.revision}>
                  {t('memory.frame.option', { revision: String(frame.revision) })}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="files-body">
        <div className="files-stage in">
          {shown ? (
            <MemoryDetail
              entity={shown}
              citation={citationFor(shown.id)}
              sourceReady={detail?.id === shown.id}
              t={t}
              onClose={() => setSelectedId(null)}
              onSelect={setSelectedId}
            />
          ) : error ? (
            <p className="files-status memory-error">{error}</p>
          ) : loading && entities.length === 0 ? (
            <p className="files-status">{t('memory.loading')}</p>
          ) : entities.length === 0 ? (
            <div className="files-empty">
              <span className="files-empty-mark" aria-hidden="true">
                <EmptyIcon />
              </span>
              <p>{t('memory.empty')}</p>
            </div>
          ) : (
            <>
              {revision != null ? <p className="memory-note">{t('memory.frame.note')}</p> : null}
              {capped ? <p className="memory-note">{t('memory.capped')}</p> : null}
              <div className="files-table" role="table">
                <div className="files-row files-columns memory-row" role="row">
                  <span role="columnheader">{t('files.name')}</span>
                  <span className="files-col-type" role="columnheader">
                    {t('memory.kind')}
                  </span>
                  <span className="files-col-size" role="columnheader">
                    {t('memory.lifecycle')}
                  </span>
                  <span className="files-col-time" role="columnheader">
                    {t('files.modified')}
                  </span>
                </div>
                {entities.map(entity => (
                  <MemoryCard
                    key={entity.id}
                    entity={entity}
                    selected={entity.id === selectedId}
                    t={t}
                    onSelect={setSelectedId}
                  />
                ))}
              </div>
              {nextCursor ? (
                <button type="button" className="memory-more" onClick={() => void more()}>
                  {t('memory.more')}
                </button>
              ) : null}
              <p className="memory-readonly">{t('memory.readonly')}</p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function MemoryCard({
  entity,
  selected,
  t,
  onSelect,
}: {
  entity: MemoryEntity
  selected: boolean
  t: Copy
  onSelect: (id: string) => void
}) {
  const label = entity.tombstone ? t('memory.tombstone') : rowLabel(entity, t('memory.missing'))
  return (
    <div className="files-row memory-row" role="row">
      <button type="button" className="files-name" aria-pressed={selected} onClick={() => onSelect(entity.id)}>
        <TypeMark type={entity.type} />
        <span>{label}</span>
      </button>
      <span className="files-col-type">{t(TYPE_KEY[entity.type])}</span>
      <span className="files-col-size">{t(LIFE_KEY[entity.lifecycle])}</span>
      <span className="files-col-time" title={formatWhenFull(entity.updatedAt)}>
        {formatWhen(entity.updatedAt, t('memory.missing'))}
      </span>
    </div>
  )
}

export function MemoryDetail({
  entity,
  citation,
  sourceReady,
  t,
  onClose,
  onSelect,
}: {
  entity: MemoryEntity
  citation: MemoryCitation | null
  sourceReady: boolean
  t: Copy
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const showBody =
    !entity.tombstone &&
    entity.bodyState === 'visible' &&
    typeof entity.body === 'string' &&
    entity.body.trim() !== entity.summary.trim()
  return (
    <div className={`files-preview memory-doc memory-doc-${entity.type}`}>
      <div className="files-preview-bar">
        <span>
          {t(TYPE_KEY[entity.type])}
          <span aria-hidden="true"> · </span>
          {t(SCOPE_KEY[entity.scope])}
          <span aria-hidden="true"> · </span>
          {t(LIFE_KEY[entity.lifecycle])}
        </span>
        <span>
          {citation ? (
            <span className={`memory-cite memory-cite-${citation.form}`}>{t(citeKey(citation.form))}</span>
          ) : null}
          <button type="button" onClick={onClose}>
            {t('memory.back')}
          </button>
        </span>
      </div>
      <div className="files-markdown">
        <MemoryBody entity={entity} citation={citation} t={t} />
        {entity.type === 'episodic' && !entity.tombstone ? (
          <p className="memory-participants">{t('memory.episode.participants')}</p>
        ) : null}
        {showBody ? <pre className="memory-body">{entity.body}</pre> : null}
        {entity.bodyState === 'hidden' ? <p className="memory-body-note">{t('memory.body.hidden')}</p> : null}
        {entity.bodyState === 'mismatch' ? <p className="memory-body-note">{t('memory.body.mismatch')}</p> : null}
        {entity.bodyState === 'absent' ? <p className="memory-body-note">{t('memory.body.absent')}</p> : null}
        {entity.note ? (
          <p className="memory-note-line">
            <span>{t('memory.note')}</span>
            {entity.note}
          </p>
        ) : null}
        {sourceReady ? <SourceBlock source={entity.source} t={t} /> : null}
        {citation ? <p className="memory-cite-reason">{t(reasonKey(citation.reason))}</p> : null}
        {entity.chain && entity.chain.length > 1 ? (
          <section className="memory-chain">
            <h5>{t('memory.chain')}</h5>
            <ul>
              {entity.chain.map(item => (
                <li key={item.id}>
                  <button type="button" disabled={item.id === entity.id} onClick={() => onSelect(item.id)}>
                    {item.tombstone ? t('memory.tombstone') : item.summary || item.id}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {entity.changes && entity.changes.length > 0 ? (
          <section className="memory-changes">
            <h5>{t('memory.changes')}</h5>
            <ul>
              {entity.changes.map(change => (
                <li key={change.id}>
                  {toolLabel(change.tool, t)} · {formatWhen(change.at, t('memory.missing'))}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}

function MemoryBody({ entity, citation, t }: { entity: MemoryEntity; citation: MemoryCitation | null; t: Copy }) {
  if (entity.tombstone) return <p className="memory-tombstone">{t('memory.tombstone')}</p>
  if (entity.type === 'persona') {
    return (
      <div className="memory-persona">
        {entity.versionLabel ? (
          <p className="memory-version">{t('memory.version', { version: entity.versionLabel })}</p>
        ) : null}
        {entity.title ? <p className="memory-persona-title">{entity.title}</p> : null}
        {entity.summary && entity.summary !== entity.title ? <p className="memory-excerpt">{entity.summary}</p> : null}
      </div>
    )
  }
  if (entity.type === 'profile') {
    return entity.attributes && entity.attributes.length > 0 ? (
      <dl className="memory-attributes">
        {entity.attributes.map(attribute => (
          <div key={`${attribute.name}:${attribute.value}`}>
            <dt>{attribute.name}</dt>
            <dd>{attribute.value}</dd>
          </div>
        ))}
      </dl>
    ) : (
      <p className="memory-profile-empty">{entity.summary || t('memory.profile.empty')}</p>
    )
  }
  if (entity.type === 'fact') {
    return (
      <div className="memory-fact">
        <p className="memory-proposition">{entity.summary || t('memory.missing')}</p>
        {entity.priority != null ? (
          <p className="memory-priority">{t('memory.priority', { priority: String(entity.priority) })}</p>
        ) : null}
      </div>
    )
  }
  if (entity.type === 'episodic') {
    return (
      <div className="memory-episode">
        <time dateTime={entity.updatedAt ?? undefined}>{formatWhen(entity.updatedAt, t('memory.missing'))}</time>
        {entity.title ? <p className="memory-scene-title">{entity.title}</p> : null}
        <p className="memory-scene">{entity.summary || t('memory.missing')}</p>
      </div>
    )
  }
  if (entity.type === 'procedural') {
    return entity.steps && entity.steps.length > 0 ? (
      <ol className="memory-steps">
        {entity.steps.map((step, index) => (
          <li key={`${index}:${step}`}>{step}</li>
        ))}
      </ol>
    ) : (
      <p className="memory-procedure-empty">{t('memory.procedure.empty')}</p>
    )
  }
  if (entity.type === 'state') {
    return (
      <div className="memory-state">
        <p className="memory-goal">
          <span>{t('memory.state.goal')}</span>
          {entity.goal || t('memory.missing')}
        </p>
        <div className="memory-blockers">
          <span>{t('memory.state.blockers')}</span>
          {entity.blockers && entity.blockers.length > 0 ? (
            <ul>
              {entity.blockers.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>{t('memory.missing')}</p>
          )}
        </div>
        <p className="memory-next">
          <span>{t('memory.state.next')}</span>
          {entity.next || t('memory.missing')}
        </p>
      </div>
    )
  }
  const binding = entity.bindingScope === 'private' ? t('memory.skill.private') : t('memory.skill.public')
  return (
    <div className="memory-skill">
      <p className="memory-skill-name">{entity.title}</p>
      {entity.summary ? <p className="memory-skill-summary">{entity.summary}</p> : null}
      <p className="memory-skill-load">{citation ? t(citeKey(citation.form)) : t('memory.skill.loadUnknown')}</p>
      {entity.bindingScope ? (
        <p className="memory-skill-file">{t('memory.skill.binding', { scope: binding })}</p>
      ) : null}
      {entity.enabled === false ? <p className="memory-skill-flag">{t('memory.skill.disabled')}</p> : null}
    </div>
  )
}

function SourceBlock({ source, t }: { source: MemorySource | undefined; t: Copy }) {
  if (!source?.recorded) {
    return (
      <section className="memory-source">
        <h5>{t('memory.source')}</h5>
        <p>{t('memory.source.unrecorded')}</p>
      </section>
    )
  }
  return (
    <section className="memory-source">
      <h5>{t('memory.source')}</h5>
      <p>{t(creatorKey(source.creator))}</p>
      {source.createdAt ? (
        <p>{t('memory.source.created', { time: formatWhen(source.createdAt, t('memory.missing')) })}</p>
      ) : null}
      {source.updatedAt ? (
        <p>{t('memory.source.updated', { time: formatWhen(source.updatedAt, t('memory.missing')) })}</p>
      ) : null}
    </section>
  )
}

function TypeMark({ type }: { type: MemoryType }) {
  return (
    <span className="files-mark memory-mark" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        {type === 'persona' ? (
          <>
            <circle cx="8" cy="5.4" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M3.6 13.2c.7-2.3 2.3-3.4 4.4-3.4s3.7 1.1 4.4 3.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </>
        ) : null}
        {type === 'profile' ? (
          <path
            d="M4 3.6h8v8.8H4zM6.2 6.4h3.6M6.2 8.6h3.6M6.2 10.8h2.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {type === 'fact' ? (
          <path d="M4 5.2h8M4 8h8M4 10.8h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : null}
        {type === 'episodic' ? (
          <>
            <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 5.6V8l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </>
        ) : null}
        {type === 'procedural' ? (
          <path
            d="M4.2 4.6h7.6M4.2 8h7.6M4.2 11.4h7.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ) : null}
        {type === 'state' ? (
          <>
            <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          </>
        ) : null}
        {type === 'skill' ? (
          <path
            d="M5.2 3.4v9.2M10.8 3.4v9.2M3.4 6h9.2M3.4 10h9.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
    </span>
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.2 8a5.2 5.2 0 1 1-1.4-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M13.4 2.6V5.2H10.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function EmptyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h14v11H5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 10.5h8M8 13.5h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function rowLabel(entity: MemoryEntity, missing: string): string {
  if (entity.tombstone) return missing
  if (entity.type === 'persona') return entity.title || entity.summary || missing
  if (entity.type === 'profile') {
    const first = entity.attributes?.[0]
    if (first) return `${first.name} ${first.value}`
    return entity.summary || missing
  }
  if (entity.type === 'fact') return entity.summary || missing
  if (entity.type === 'episodic') return entity.title || entity.summary || missing
  if (entity.type === 'procedural') return entity.steps?.[0] || entity.summary || missing
  if (entity.type === 'state') return entity.goal || entity.summary || missing
  return entity.title || entity.summary || missing
}

function entityPath(
  sessionId: string,
  filter: { query: string; scope: ScopeFilter; lifecycle: LifeFilter; type: TypeFilter },
  cursor: string | null,
): string {
  const params = new URLSearchParams({ sessionId })
  if (filter.query !== '') params.set('q', filter.query)
  if (filter.scope !== 'all') params.set('scope', filter.scope)
  if (filter.lifecycle !== 'all') params.set('lifecycle', filter.lifecycle)
  if (filter.type !== 'all') params.set('type', filter.type)
  if (cursor) params.set('cursor', cursor)
  return `/dsh-bot/api/memory/entities?${params}`
}

function failureText(status: number, t: Copy): string {
  if (status === 401 || status === 403) return t('memory.denied')
  return t('memory.failed')
}

function citeKey(form: CitationForm): MessageKey {
  if (form === 'full') return 'memory.cite.full'
  if (form === 'summary') return 'memory.cite.summary'
  if (form === 'index') return 'memory.cite.index'
  if (form === 'recall') return 'memory.cite.recall'
  if (form === 'absent') return 'memory.cite.absent'
  return 'memory.cite.unknown'
}

function reasonKey(reason: string): MessageKey {
  if (reason === 'no_frame') return 'memory.cite.reason.no_frame'
  return 'memory.cite.reason.no_manifest'
}

function creatorKey(creator: MemoryCreator): MessageKey {
  if (creator === 'user') return 'memory.source.user'
  if (creator === 'model') return 'memory.source.model'
  if (creator === 'system') return 'memory.source.system'
  if (creator === 'tool') return 'memory.source.tool'
  return 'memory.source.unknown'
}

function toolLabel(tool: string, t: Copy): string {
  if (tool === 'foundations_remember') return t('memory.tool.foundations_remember')
  if (tool === 'foundations_correct') return t('memory.tool.foundations_correct')
  if (tool === 'foundations_forget') return t('memory.tool.foundations_forget')
  if (tool === 'foundations_state_update') return t('memory.tool.foundations_state_update')
  return tool
}

function formatWhen(value: string | null, missing: string): string {
  if (!value) return missing
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return missing
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute}`
}

function formatWhenFull(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString()
}
