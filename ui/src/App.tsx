import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { readDeleteEvents, type DeleteEvent } from './delete-job'
import { forgetLogCache } from './sync/checkpoint'
import { foundations, foundationsError } from './foundations'
import { useI18n } from './locale'
import {
  botSignal,
  composerLocked,
  isWorkerSession,
  readLiveBoard,
  workerTicketId,
  workPlaceholder,
  workPreview,
  type WorkTicket,
} from './work'
import { FileBrowser } from './FileBrowser'
import { NewSessionSheet, useSessionBasis } from './NewSession'
import { BotChatView } from './BotChatView'
import { TurnRail } from './TurnRail'
import { createInteractionSync, createAuthorizationCatalog } from './interaction-sync'
import { ImageFailureScope } from './ImageFailureScope'
import { CurrentActivity } from './CurrentActivity'
import { currentActivity } from './current-activity'
import { MemoryPanel } from './MemoryPanel'
import { CanvasScope } from './CanvasPreview'
import { formatCanvasTarget, type CanvasChip } from './canvas-target'
import { AuthorizationPanel, CuaPanel, PermissionPanel } from './SettingsPanels'
import { presetLabel } from './permission-label.ts'
import type { ToolApprovalView } from './ToolApprovalCard'
import type { UserQuestionWait } from './user-question'
import { railMarks } from './turn-marks'
import { botExchange, mainSegments } from './bot-chat'
import { applyLogEvent, applyEphemeralFrame, previewOf } from './follow'
import { applyValue } from './live-patch'
import {
  createCdcSnapshotTransport,
  createEventLogReader,
  createIdbCheckpoint,
  createOfficialPageTransport,
  createPluginRangeTransport,
  createWsFollowTransport,
  sessionAddress,
  type EventLogReader,
  type SyncStatus,
} from './sync'
import { filterMentions, insertMention, mentionQuery, type MentionTarget } from './mentions'
import {
  emptyThread,
  type HealthBody,
  type SessionItem,
  type TaskRecord,
  type ThreadState,
  type UsageBody,
} from './types'
import {
  ArrowIcon,
  BotDot,
  HistoryLoading,
  PermissionIcon,
  PlusIcon,
  SearchIcon,
  Status,
  hostText,
  statsLine,
} from './chrome'
import { Transcript } from './transcript'
import { FOLLOW_GAP } from './scroll-follow'
import { useScrollFollow } from './use-scroll-follow'

function LatestButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="jump-latest" aria-label={label} onClick={onClick}>
      <ArrowIcon />
    </button>
  )
}

function hashSession(): string {
  const parts = location.hash.replace(/^#\/?/, '').split('/')
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    const value = parts[i + 1]
    if (key === 's' && value) return decodeURIComponent(value)
  }
  return ''
}

function dropStored(key: string, current: Record<string, string>, id: string) {
  if (!(id in current)) return current
  const next = { ...current }
  delete next[id]
  sessionStorage.setItem(key, JSON.stringify(next))
  return next
}

function loadMap(key: string): Record<string, string> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || '{}') as unknown
    return value && typeof value === 'object' ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function previewMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [id, text] of Object.entries(value)) {
    if (typeof text === 'string' && text !== '') next[id] = text
  }
  return next
}

function putPreviews(body: Record<string, unknown>) {
  void fetch('/dsh-bot/api/sessions/previews', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
}

function baseName(cwd?: string): string {
  const parts = (cwd ?? '').split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

function loadArchivedIds(): Promise<string[]> {
  return new Promise(resolve => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${proto}//${location.host}/api/remote.mux`)
    const timer = window.setTimeout(() => {
      socket.close()
      resolve([])
    }, 4000)
    const finish = (ids: string[]) => {
      window.clearTimeout(timer)
      socket.close()
      resolve(ids)
    }
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'open',
          streamId: 'archive',
          endpoint: 'workspace/follow',
          payload: { args: {} },
        }),
      )
    })
    socket.addEventListener('message', event => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          value?: { type?: string; value?: { archivedSessionIds?: unknown } }
        }
        const ids = frame.value?.type === 'baseline' ? frame.value.value?.archivedSessionIds : undefined
        if (!Array.isArray(ids)) return
        finish(ids.filter(id => typeof id === 'string'))
      } catch {
        // A non-JSON frame is not the archive baseline.
      }
    })
    socket.addEventListener('error', () => finish([]))
  })
}

export function App() {
  const { t, locale, setLocale } = useI18n()
  const [sessionId, setSessionId] = useState(hashSession)
  const [items, setItems] = useState<SessionItem[]>([])
  const [sessionNote, setSessionNote] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [titles, setTitles] = useState(() => loadMap('dsh-bot.titles'))
  const [previews, setPreviews] = useState(() => loadMap('dsh-bot.previews'))
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [historySession, setHistorySession] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [threadSession, setThreadSession] = useState(sessionId)
  if (threadSession !== sessionId) {
    setThreadSession(sessionId)
    setThread(emptyThread())
  }
  const [task, setTask] = useState<TaskRecord | null>(null)
  const [execution, setExecution] = useState({ ready: false, reason: 'loading' })
  const [health, setHealth] = useState<HealthBody | null>(null)
  const [usage, setUsage] = useState<UsageBody | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [canvasMentions, setCanvasMentions] = useState<CanvasChip[]>([])
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [canvasDismiss, setCanvasDismiss] = useState(0)
  useEffect(() => {
    setCanvasMentions([])
  }, [sessionId])
  const [cursor, setCursor] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosed, setMentionClosed] = useState('')
  const [reason, setReason] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [deleteJob, setDeleteJob] = useState<{ id: string; phase: string; percent: number; error: string } | null>(null)
  const [settings, setSettings] = useState<'permission' | 'authorization' | 'cua' | 'memory' | null>(null)
  const [approvals, setApprovals] = useState<ToolApprovalView[]>([])
  const [questionWaits, setQuestionWaits] = useState<
    Record<string, { remainingMs?: number; waitState?: UserQuestionWait }>
  >({})
  const [cuaAvailable, setCuaAvailable] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authorization, setAuthorization] = useState<Record<string, unknown>>({})
  const [authorizationCatalog] = useState(() =>
    createAuthorizationCatalog(async () => {
      const response = await api('/authorization')
      if (response.status !== 200) throw new Error('Authorization catalog unavailable')
      return { available: response.body.available, entries: response.body.entries }
    }),
  )
  const authorizationRevision = useRef<unknown>(undefined)
  const interactionSync = useRef<ReturnType<typeof createInteractionSync> | null>(null)
  const [filePreview, setFilePreview] = useState<{ path: string; line?: number; token: number } | null>(null)
  const [canvasPulse, setCanvasPulse] = useState(0)
  const [filesOpen, setFilesOpen] = useState(false)
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => new Set())
  const [freshBots, setFreshBots] = useState<ReadonlySet<string>>(() => new Set())
  const [setupOpen, setSetupOpen] = useState(false)
  const [botChat, setBotChat] = useState(false)
  const [setupNote, setSetupNote] = useState('')
  const [basisRevision, setBasisRevision] = useState(0)
  const [bots, setBots] = useState<ReadonlySet<string>>(() => new Set())
  const [botNames, setBotNames] = useState<Record<string, string>>({})
  const [workCards, setWorkCards] = useState<Record<string, WorkTicket[]>>({})
  const [workReady, setWorkReady] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState<Record<string, string[]>>({})
  const [workNow, setWorkNow] = useState(() => Date.now())
  const [workerOwner, setWorkerOwner] = useState('')
  const basis = useSessionBasis(sessionId, basisRevision)

  useEffect(() => {
    setApprovals([])
    setQuestionWaits({})
    const sync = createInteractionSync({
      visible: !document.hidden,
      fetch: async signal => {
        const response = await api(`/interactions?compact=1&sessionId=${encodeURIComponent(sessionId)}`, { signal })
        if (response.status !== 200) throw new Error('Interactions unavailable')
        return response.body
      },
      active: value => {
        const body = value as Record<string, any>
        return Boolean(
          body.questions?.length ||
            body.approvals?.some((item: any) => item.state === 'open') ||
            body.authorization?.prompts?.length ||
            body.authorization?.inFlight?.length,
        )
      },
      apply: value => {
        const body = value as Record<string, unknown>
        const nextApprovals = Array.isArray(body.approvals) ? (body.approvals as ToolApprovalView[]) : []
        setApprovals(nextApprovals)
        const waits: Record<string, { remainingMs?: number; waitState?: UserQuestionWait }> = {}
        if (Array.isArray(body.questions)) {
          for (const item of body.questions as Array<{
            callId?: string
            remainingMs?: number
            waitState?: UserQuestionWait
          }>) {
            if (typeof item.callId === 'string' && item.callId !== '') {
              waits[item.callId] = { remainingMs: item.remainingMs, waitState: item.waitState }
            }
          }
        }
        setQuestionWaits(waits)
        const nextAuthorization = body.authorization
        const prompts =
          nextAuthorization && typeof nextAuthorization === 'object'
            ? (nextAuthorization as { prompts?: unknown }).prompts
            : []
        setAuthPending(Array.isArray(prompts) && prompts.length > 0)
        const auth =
          nextAuthorization && typeof nextAuthorization === 'object'
            ? (nextAuthorization as Record<string, unknown>)
            : {}
        const revision = JSON.stringify([auth.catalogRevision, auth.available])
        if (authorizationRevision.current !== revision) {
          authorizationRevision.current = revision
          authorizationCatalog.invalidate()
        }
        setAuthorization(current => (JSON.stringify(current) === JSON.stringify(auth) ? current : auth))
      },
      schedule: (fn, ms) => {
        const timer = window.setTimeout(fn, ms)
        return () => window.clearTimeout(timer)
      },
    })
    interactionSync.current = sync
    const visibility = () => sync.setVisible(!document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      sync.close()
      if (interactionSync.current === sync) interactionSync.current = null
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [sessionId, authorizationCatalog])

  useEffect(() => {
    void api('/cua').then(response => setCuaAvailable(response.body.available === true))
  }, [])
  const { scrollRef, contentRef, detached, pin, stickIfFollowing } = useScrollFollow(
    `${botChat ? 'bot' : 'main'}:${sessionId}`,
  )
  const composerRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const deletedSessions = useRef(new Set<string>())
  const localSeq = useRef(0)
  const previewQueue = useRef(new Map<string, string>())
  const previewTimer = useRef(0)
  const previewKnown = useRef(new Map<string, string>())
  const previewSeeded = useRef(false)
  const sessionRef = useRef(sessionId)
  const readerRef = useRef<EventLogReader | null>(null)
  sessionRef.current = sessionId

  function sessionName(item: { sessionId: string; cwd?: string; title?: string | null }): string {
    return (
      botNames[item.sessionId] || titles[item.sessionId] || item.title || baseName(item.cwd) || t('session.unnamed')
    )
  }
  function botLabel(id: string): string {
    const item = items.find(entry => entry.sessionId === id)
    if (item) return sessionName(item)
    return botNames[id] || titles[id] || ''
  }
  const exchange = botExchange(thread.segments)
  const historyLoading =
    sessionId !== '' &&
    historySession !== sessionId &&
    (syncStatus == null ||
      syncStatus.phase === 'restoring' ||
      syncStatus.phase === 'connecting' ||
      (syncStatus.phase === 'syncing' && historySession !== sessionId))
  const chunkProgress =
    syncStatus?.fraction != null ? { loaded: Math.round(syncStatus.fraction * 1000), total: 1000 } : null
  const chunkBusy = syncStatus?.phase === 'syncing' && syncStatus.fraction != null
  const conversation = useMemo(() => mainSegments(thread.segments), [thread.segments])
  const marks = useMemo(() => railMarks(conversation), [conversation])
  const title = sessionId
    ? sessionName({
        sessionId,
        cwd: items.find(item => item.sessionId === sessionId)?.cwd,
        title: thread.title || null,
      })
    : t('app.title')
  const nativeHref = sessionId ? `/#/s/${encodeURIComponent(sessionId)}` : '/'

  function selectSession(id: string) {
    setBotChat(false)
    setSessionId(id)
    setMenuOpen(false)
    setFilesOpen(false)
    setFilePreview(null)
    setTask(null)
    setReason('')
    setSetupNote('')
    const next = id ? `#/s/${encodeURIComponent(id)}` : '#/'
    if (location.hash !== next) history.replaceState(null, '', next)
  }

  function openWorkerSession(id: string) {
    if (!id || id === sessionId) return
    const owner = sessionId
    setBotChat(false)
    setSessionId(id)
    setMenuOpen(false)
    setFilesOpen(false)
    setFilePreview(null)
    setTask(null)
    setReason('')
    setSetupNote('')
    const next = `#/s/${encodeURIComponent(id)}`
    if (location.hash !== next) history.pushState({ kind: 'worker', owner }, '', next)
  }

  function leaveWorker() {
    setBotChat(false)
    setMenuOpen(false)
    setFilesOpen(false)
    setFilePreview(null)
    const state = history.state as { kind?: string } | null
    if (state?.kind === 'worker') {
      history.back()
      return
    }
    if (workerOwner) selectSession(workerOwner)
  }

  useEffect(() => {
    let stop = false
    void loadArchivedIds().then(ids => {
      if (!stop) setArchived(new Set(ids))
    })
    return () => {
      stop = true
    }
  }, [])

  function applyLiveDocument(body: Record<string, unknown>) {
    const board = readLiveBoard(body)
    if (board) {
      setRemoteStatus(board.signals)
      setWorkCards(board.cards)
      setWorkReady(true)
    }
    const desk = body.desk
    if (!desk || typeof desk !== 'object' || Array.isArray(desk)) return
    const row = desk as Record<string, unknown>
    const sessions = row.sessions
    if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
      const sessionBody = sessions as Record<string, unknown>
      const value = sessionBody.result as
        | { ok?: boolean; value?: { items?: SessionItem[] }; error?: { message?: string } }
        | undefined
      if (value?.ok !== true) {
        setSessionNote(value?.error?.message || String(sessionBody.error || t('session.listUnavailable')))
      } else {
        setSessionNote('')
        setItems(acceptSessions(value.value?.items))
        takePreviews(sessionBody.previews)
        if (!previewSeeded.current) {
          previewSeeded.current = true
          const disk = previewMap(sessionBody.previews)
          const missing: Record<string, string> = {}
          for (const [id, text] of Object.entries(loadMap('dsh-bot.previews'))) {
            if (deletedSessions.current.has(id) || disk[id] || !text) continue
            missing[id] = text
          }
          if (Object.keys(missing).length > 0) putPreviews({ previews: missing })
        }
      }
    }
    const roster = row.bots
    if (roster && typeof roster === 'object' && !Array.isArray(roster) && (roster as { ok?: unknown }).ok === true) {
      const botsBody = roster as { bots?: unknown; sessionIds?: unknown }
      const cards = Array.isArray(botsBody.bots) ? botsBody.bots : []
      const ids = cards.flatMap(card => {
        if (!card || typeof card !== 'object') return []
        const id = (card as { sessionId?: unknown }).sessionId
        return typeof id === 'string' ? [id] : []
      })
      const names: Record<string, string> = {}
      for (const card of cards) {
        if (!card || typeof card !== 'object') continue
        const id = (card as { sessionId?: unknown }).sessionId
        const label = (card as { name?: unknown }).name
        if (typeof id === 'string' && typeof label === 'string' && label !== '') names[id] = label
      }
      if (ids.length === 0 && Array.isArray(botsBody.sessionIds)) {
        for (const id of botsBody.sessionIds) if (typeof id === 'string') ids.push(id)
      }
      setBots(new Set(ids))
      setBotNames(names)
    }
    const health = row.health
    if (health && typeof health === 'object' && !Array.isArray(health)) {
      const healthBody = health as HealthBody
      setHealth(healthBody)
      if (healthBody.execution) {
        setExecution({
          ready: healthBody.execution.ready === true,
          reason: healthBody.execution.reason || (healthBody.execution.ready === true ? '' : 'catalog_unreadable'),
        })
      }
    }
    const usage = row.usage
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) setUsage(usage as UsageBody)
  }

  useEffect(() => {
    let stop = false
    void (async () => {
      try {
        const listed = await api('/sessions')
        if (stop) return
        const result = listed.body.result as
          | { ok?: boolean; value?: { items?: SessionItem[] }; error?: { message?: string } }
          | undefined
        if (result?.ok === true) {
          setSessionNote('')
          setItems(acceptSessions(result.value?.items))
          takePreviews(listed.body.previews)
        } else if (listed.status !== 200) {
          setSessionNote(result?.error?.message || t('session.listUnavailable'))
        }
      } catch {
        /* the live stream still fills the list */
      }
      try {
        const roster = await api('/sessions/bots')
        if (stop || roster.body.ok !== true) return
        const cards = Array.isArray(roster.body.bots) ? roster.body.bots : []
        const ids = cards.flatMap(card => {
          if (!card || typeof card !== 'object') return []
          const id = (card as { sessionId?: unknown }).sessionId
          return typeof id === 'string' ? [id] : []
        })
        const names: Record<string, string> = {}
        for (const card of cards) {
          if (!card || typeof card !== 'object') continue
          const id = (card as { sessionId?: unknown }).sessionId
          const label = (card as { name?: unknown }).name
          if (typeof id === 'string' && typeof label === 'string' && label !== '') names[id] = label
        }
        if (ids.length === 0 && Array.isArray(roster.body.sessionIds)) {
          for (const id of roster.body.sessionIds) if (typeof id === 'string') ids.push(id)
        }
        setBots(new Set(ids))
        setBotNames(names)
      } catch {
        /* the live desk still carries the roster */
      }
    })()
    return () => {
      stop = true
    }
  }, [])

  useEffect(() => {
    let stop = false
    let source: EventSource | null = null
    let timer = 0
    let reconnectDelay = 2000
    let deskDoc: unknown
    let workDoc: unknown
    const take = (event: Event) => {
      let row: Record<string, unknown>
      try {
        row = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>
      } catch {
        return null
      }
      return row.ok === true ? row : null
    }
    const connect = () => {
      source?.close()
      deskDoc = undefined
      workDoc = undefined
      if (stop || document.hidden || typeof EventSource === 'undefined') return
      const next = new EventSource(`/dsh-bot/api/live?sessionId=${encodeURIComponent(sessionId)}`)
      source = next
      next.addEventListener('interaction-error', () => {
        if (!stop && source === next) interactionSync.current?.disconnected()
      })
      next.addEventListener('interactions', event => {
        if (stop || source !== next) return
        const row = take(event)
        if (row?.sessionId === sessionId) {
          reconnectDelay = 2000
          interactionSync.current?.ingest(row)
        }
      })
      next.addEventListener('canvas', event => {
        if (stop || source !== next) return
        const row = take(event)
        if (!row || !Array.isArray(row.events) || row.events.length === 0) return
        reconnectDelay = 2000
        setCanvasPulse(value => value + 1)
      })
      next.addEventListener('snapshot', event => {
        if (stop || source !== next) return
        const row = take(event)
        if (!row) return
        reconnectDelay = 2000
        if (row.desk !== undefined) deskDoc = row.desk
        if (row.work !== undefined) workDoc = row.work
        applyLiveDocument(row)
      })
      next.addEventListener('delta', event => {
        if (stop || source !== next) return
        const row = take(event)
        if (!row) return
        const merged: Record<string, unknown> = { ok: true }
        if (row.desk !== undefined && deskDoc !== undefined) {
          deskDoc = applyValue(deskDoc, row.desk)
          merged.desk = deskDoc
        }
        if (row.work !== undefined && workDoc !== undefined) {
          workDoc = applyValue(workDoc, row.work)
          merged.work = workDoc
        }
        if (merged.desk !== undefined || merged.work !== undefined) applyLiveDocument(merged)
      })
      next.addEventListener('error', () => {
        if (stop || source !== next) return
        interactionSync.current?.disconnected()
        next.close()
        if (source === next) source = null
        timer = window.setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(15_000, reconnectDelay * 2)
      })
    }
    const visibility = () => {
      window.clearTimeout(timer)
      if (document.hidden) {
        source?.close()
        source = null
      } else {
        reconnectDelay = 2000
        connect()
      }
    }
    document.addEventListener('visibilitychange', visibility)
    connect()
    return () => {
      stop = true
      document.removeEventListener('visibilitychange', visibility)
      window.clearTimeout(timer)
      source?.close()
    }
  }, [sessionId])

  useEffect(() => {
    const onHash = () => {
      setBotChat(false)
      setMenuOpen(false)
      setFilesOpen(false)
      setFilePreview(null)
      setTask(null)
      setReason('')
      setSetupNote('')
      setSessionId(hashSession())
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let cancelled = false
    const checkpointReady = createIdbCheckpoint()
    void checkpointReady.then(checkpoint => {
      if (cancelled) return
      readerRef.current = createEventLogReader({
        follow: createWsFollowTransport({
          addressOf: id => sessionAddress(id),
        }),
        page: createOfficialPageTransport({
          addressOf: id => sessionAddress(id),
        }),
        cdc: createCdcSnapshotTransport({ cache: checkpoint }),
        range: createPluginRangeTransport(),
        checkpoint,
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sessionId) {
      setHistorySession('')
      setSyncStatus(null)
      return
    }
    setThread(emptyThread())
    setSyncStatus(null)
    let stop = false
    let sub: { close(): void } | null = null
    void (async () => {
      const checkpoint = await createIdbCheckpoint()
      if (stop) return
      const reader =
        readerRef.current ??
        createEventLogReader({
          follow: createWsFollowTransport({ addressOf: id => sessionAddress(id) }),
          page: createOfficialPageTransport({ addressOf: id => sessionAddress(id) }),
          cdc: createCdcSnapshotTransport({ cache: checkpoint }),
          range: createPluginRangeTransport(),
          checkpoint,
        })
      readerRef.current = reader
      const subscription = reader.open(sessionId, { enhancement: 'auto' })
      sub = subscription
      subscription.onBatch(batch => {
        if (stop || sessionRef.current !== sessionId) return
        setThread(current => {
          let next = current
          for (const event of batch.events) next = applyLogEvent(next, event as any)
          return next
        })
        setHistorySession(sessionId)
      })
      subscription.onEphemeral(frame => {
        if (stop || sessionRef.current !== sessionId) return
        setThread(current => applyEphemeralFrame(current, frame))
      })
      subscription.onStatus(status => {
        if (stop || sessionRef.current !== sessionId) return
        setSyncStatus(status)
        if (status.phase === 'live' || status.phase === 'stalled' || status.phase === 'error')
          setHistorySession(sessionId)
      })
    })()
    return () => {
      stop = true
      sub?.close()
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || threadSession !== sessionId || !thread.title || botNames[sessionId]) return
    setTitles(current => {
      if (current[sessionId] === thread.title) return current
      const next = { ...current, [sessionId]: thread.title }
      sessionStorage.setItem('dsh-bot.titles', JSON.stringify(next))
      return next
    })
  }, [sessionId, threadSession, thread.title, botNames])

  const isBotSession = Boolean(sessionId) && bots.has(sessionId)
  const works = isBotSession && workReady ? (workCards[sessionId] ?? []) : []
  const loadedWorkSession = isBotSession && workReady ? sessionId : ''
  useEffect(() => {
    if (!sessionId || !isWorkerSession(sessionId)) {
      setWorkerOwner('')
      return
    }
    let stop = false
    const ticketId = workerTicketId(sessionId)
    void foundations(`/dsh-bot/api/work/ticket?id=${encodeURIComponent(ticketId)}`).then(result => {
      if (stop || result.body.ok !== true || !result.body.ticket || typeof result.body.ticket !== 'object') return
      const owner = (result.body.ticket as { owner_session_id?: unknown }).owner_session_id
      if (typeof owner === 'string') setWorkerOwner(owner)
    })
    return () => {
      stop = true
    }
  }, [sessionId])

  const workTicking = works.some(ticket => ticket.status === 'started')
  useEffect(() => {
    if (!workTicking) return
    const timer = window.setInterval(() => setWorkNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [workTicking])

  function takePreviews(value: unknown) {
    const incoming = previewMap(value)
    if (Object.keys(incoming).length === 0) return
    setPreviews(current => {
      let changed = false
      const next = { ...current }
      for (const [id, text] of Object.entries(incoming)) {
        if (next[id]) continue
        next[id] = text
        changed = true
      }
      if (!changed) return current
      sessionStorage.setItem('dsh-bot.previews', JSON.stringify(next))
      return next
    })
  }

  function flushPreviews() {
    window.clearTimeout(previewTimer.current)
    previewTimer.current = 0
    const queued = [...previewQueue.current]
    previewQueue.current.clear()
    if (queued.length === 0) return
    if (queued.length === 1) {
      const [id, preview] = queued[0] ?? []
      if (id && preview) putPreviews({ sessionId: id, preview })
      return
    }
    putPreviews({ previews: Object.fromEntries(queued) })
  }

  useEffect(
    () => () => {
      flushPreviews()
    },
    [],
  )

  useEffect(() => {
    if (!sessionId || threadSession !== sessionId) return
    const preview = previewOf(thread.segments)
    if (!preview || previewKnown.current.get(sessionId) === preview) return
    previewKnown.current.set(sessionId, preview)
    setPreviews(current => {
      if (current[sessionId] === preview) return current
      const next = { ...current, [sessionId]: preview }
      sessionStorage.setItem('dsh-bot.previews', JSON.stringify(next))
      return next
    })
    previewQueue.current.set(sessionId, preview)
    window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(flushPreviews, 400)
  }, [sessionId, threadSession, thread.segments])

  useLayoutEffect(() => {
    const node = sessionMenuRef.current
    if (!node || !sessionMenu) return
    const rect = node.getBoundingClientRect()
    const x = Math.max(8, Math.min(sessionMenu.x, window.innerWidth - rect.width - 8))
    const y = Math.max(8, Math.min(sessionMenu.y, window.innerHeight - rect.height - 8))
    if (x !== sessionMenu.x || y !== sessionMenu.y)
      setSessionMenu(current => (current ? { ...current, x, y } : current))
    node.querySelector('button')?.focus()
  }, [sessionMenu])

  useEffect(() => {
    if (!sessionMenu) return
    const close = () => setSessionMenu(null)
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && sessionMenuRef.current?.contains(target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', close, true)
    }
  }, [sessionMenu])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    setBotChat(false)
  }, [sessionId])

  useLayoutEffect(() => {
    const composer = composerRef.current
    const scroll = scrollRef.current
    if (!composer || !scroll) return
    const apply = () => {
      const fade = Number.parseFloat(getComputedStyle(composer).getPropertyValue('--composer-fade')) || 0
      const clearance = composer.hidden ? 0 : Math.max(0, composer.offsetHeight - fade)
      // Clearance hides the composer card. FOLLOW_GAP is the empty tail above it.
      const next = clearance + FOLLOW_GAP
      const previous = Number.parseFloat(scroll.style.paddingBottom) || 0
      if (previous === next) return
      scroll.style.paddingBottom = `${next}px`
      stickIfFollowing()
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(composer)
    return () => {
      observer.disconnect()
      scroll.style.paddingBottom = ''
    }
  }, [botChat, canvasOpen, scrollRef, stickIfFollowing])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter(item => {
      if (isWorkerSession(item.sessionId) || archived.has(item.sessionId)) return false
      if (item.blank === true && !freshBots.has(item.sessionId)) return false
      if (!needle) return true
      const name = sessionName(item)
      return [name, item.cwd ?? '', previews[item.sessionId] ?? ''].join(' ').toLowerCase().includes(needle)
    })
  }, [items, query, titles, previews, archived, botNames, freshBots])
  const conversations = visible
  const mentionTargets = useMemo(() => {
    if (!sessionId || !bots.has(sessionId)) return []
    return items.flatMap(item => {
      if (
        !bots.has(item.sessionId) ||
        item.sessionId === sessionId ||
        archived.has(item.sessionId) ||
        (item.blank === true && !freshBots.has(item.sessionId)) ||
        isWorkerSession(item.sessionId)
      )
        return []
      return [{ sessionId: item.sessionId, label: sessionName(item) }]
    })
  }, [items, bots, sessionId, archived, botNames, titles, freshBots])
  const mention = sessionId && bots.has(sessionId) ? mentionQuery(draft, cursor) : null
  const mentionKey = mention ? `${mention.start}:${mention.query}` : ''
  const mentionChoices = mention ? filterMentions(mentionTargets, mention.query) : []
  const mentionOpen = mention != null && mentionClosed !== mentionKey
  const mentionActive = Math.min(mentionIndex, Math.max(mentionChoices.length - 1, 0))

  useEffect(() => {
    setMentionIndex(0)
  }, [mentionKey])

  useEffect(() => {
    setFreshBots(current => {
      let changed = false
      const next = new Set(current)
      for (const id of current) {
        const item = items.find(entry => entry.sessionId === id)
        if (item && item.blank !== true) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [items])

  function acceptSessions(rows: SessionItem[] | undefined) {
    const gone = deletedSessions.current
    return (rows ?? []).filter(item => !gone.has(item.sessionId))
  }

  function forgetSession(id: string) {
    deletedSessions.current.add(id)
    previewQueue.current.delete(id)
    previewKnown.current.delete(id)
    setItems(current => current.filter(entry => entry.sessionId !== id))
    setArchived(current => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setTitles(current => dropStored('dsh-bot.titles', current, id))
    setPreviews(current => dropStored('dsh-bot.previews', current, id))
    setBots(current => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setBotNames(current => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    if (sessionId === id) selectSession('')
  }

  function openSessionMenu(event: { preventDefault(): void; clientX: number; clientY: number }, id: string) {
    event.preventDefault()
    setSessionMenu({ id, x: event.clientX, y: event.clientY })
  }

  function deleteLabel(phase: string) {
    if (phase === 'fence') return t('session.deleteFence')
    if (phase === 'stop') return t('session.deleteStop')
    if (phase === 'idle') return t('session.deleteIdle')
    if (phase === 'store') return t('session.deleteStore')
    if (phase === 'canvas') return t('session.deleteCanvas')
    if (phase === 'files') return t('session.deleteFiles')
    if (phase === 'cache') return t('session.deleteCache')
    if (phase === 'done') return t('session.deleteDone')
    return t('session.deleteProgress')
  }

  function deleteError(event: DeleteEvent) {
    if (event.error === 'running') return t('session.deleteBusy')
    if (event.error === 'session_unreadable') return t('session.deleteUnreadable')
    return event.error || t('session.deleteFailed')
  }

  async function finishDelete(id: string, event: DeleteEvent) {
    if (event.phase === 'error') {
      setDeleteJob({ id, phase: 'error', percent: event.percent, error: deleteError(event) })
      return false
    }
    if (event.phase !== 'done') {
      setDeleteJob({ id, phase: event.phase, percent: event.percent, error: t('session.deleteFailed') })
      return false
    }
    const gone = event.deletedSessionIds?.length ? event.deletedSessionIds : [id]
    setDeleteJob({ id, phase: 'cache', percent: 94, error: '' })
    try {
      await forgetLogCache(gone)
    } catch {
      /* the server copy is already gone; the browser cache expires by size */
    }
    for (const sessionId of gone) forgetSession(sessionId)
    setSessionNote('')
    setDeleteJob(null)
    return true
  }

  async function runDelete(id: string) {
    if (deleteJob && deleteJob.error === '' && deleteJob.id !== id) return false
    setDeleteJob({ id, phase: 'fence', percent: 8, error: '' })
    try {
      const response = await fetch(`/dsh-bot/api/sessions/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        headers: { accept: 'application/x-ndjson' },
      })
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('ndjson')) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
        setDeleteJob({
          id,
          phase: 'error',
          percent: 8,
          error: body.message || body.error || t('session.deleteFailed'),
        })
        return false
      }
      const last = await readDeleteEvents(response, event => {
        if (event.phase === 'done') return
        setDeleteJob({
          id,
          phase: event.phase,
          percent: event.percent,
          error: event.phase === 'error' ? deleteError(event) : '',
        })
      })
      if (!last) return recoverDelete(id)
      return finishDelete(id, last)
    } catch {
      return recoverDelete(id)
    }
  }

  async function recoverDelete(id: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await api(`/sessions/${encodeURIComponent(id)}/delete`)
      const phase = typeof result.body.phase === 'string' ? result.body.phase : 'absent'
      if (phase === 'absent') break
      const event: DeleteEvent = {
        phase,
        percent: typeof result.body.percent === 'number' ? result.body.percent : 8,
        ...(typeof result.body.error === 'string' ? { error: result.body.error } : {}),
        ...(Array.isArray(result.body.deletedSessionIds)
          ? { deletedSessionIds: result.body.deletedSessionIds.filter(item => typeof item === 'string') }
          : {}),
      }
      if (phase !== 'done' && phase !== 'error') {
        setDeleteJob({ id, phase, percent: event.percent, error: '' })
        await new Promise(resolve => setTimeout(resolve, 400))
        continue
      }
      return finishDelete(id, event)
    }
    setDeleteJob({ id, phase: 'error', percent: 8, error: t('session.deleteFailed') })
    return false
  }

  async function finishCreate(id: string, note: string, name: string) {
    setSetupOpen(false)
    if (name !== '') {
      setBotNames(current => ({ ...current, [id]: name }))
      setBots(current => new Set([...current, id]))
      setTitles(current => {
        const next = { ...current, [id]: name }
        sessionStorage.setItem('dsh-bot.titles', JSON.stringify(next))
        return next
      })
    }
    setFreshBots(current => new Set(current).add(id))
    const listed = await api('/sessions')
    const value = listed.body.result as { value?: { items?: SessionItem[] } } | undefined
    setItems(acceptSessions(value?.value?.items))
    selectSession(id)
    setSetupNote(note)
    setBasisRevision(current => current + 1)
  }

  function placeDraft(text: string, nextCursor: number) {
    setDraft(text)
    setCursor(nextCursor)
    window.requestAnimationFrame(() => {
      const node = draftRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function chooseMention(target: MentionTarget) {
    if (!mention) return
    const next = insertMention(draft, cursor, mention.start, target.label, target.sessionId)
    placeDraft(next.text, next.cursor)
  }

  function insertSlash(command = '/') {
    setMenuOpen(false)
    setDraft(current => {
      const trimmed = current.replace(/\s+$/, '')
      if (trimmed === '') return command === '/' ? '/' : `${command} `
      return `${trimmed} ${command === '/' ? '/' : `${command} `}`
    })
    window.requestAnimationFrame(() => draftRef.current?.focus())
  }

  async function submit(text: string) {
    const turnLive = task?.status === 'accepted' && thread.drafting
    const tickets = loadedWorkSession === sessionId ? works : []
    if (!sessionId || !text || !execution.ready || composerLocked(turnLive, tickets, bots.has(sessionId))) return false
    pin()
    const wasLive = thread.drafting
    setDraft('')
    setReason('')
    localSeq.current += 1
    const seq = Number.MAX_SAFE_INTEGER - localSeq.current
    setThread(prev => ({
      ...prev,
      drafting: true,
      segments: [
        ...prev.segments,
        { kind: 'user', id: `optimistic:${seq}`, text, time: Date.now(), seq, optimistic: true },
      ],
    }))
    const result = await api('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId, text }),
    })
    const nextTask = result.body.task as TaskRecord | undefined
    setTask(nextTask ?? null)
    if (result.status !== 202) {
      setThread(prev => ({
        ...prev,
        drafting: wasLive ? prev.drafting : false,
        segments: prev.segments.filter(item => !(item.kind === 'user' && item.optimistic && item.text === text)),
      }))
      const blocked = result.body.execution as { reason?: string } | undefined
      setReason(blocked?.reason || hostText(String(result.body.error || ''), t('composer.notSent'), t))
      return false
    }
    return true
  }

  async function send() {
    const text = draft.trim()
    if (!text || !canSend) return
    const mentions = canvasMentions
    const blocks = mentions.map(formatCanvasTarget).join('\n')
    const full = blocks ? `${text}\n\n${blocks}` : text
    setCanvasMentions([])
    setCanvasDismiss(count => count + 1)
    const sent = await submit(full)
    if (!sent) setCanvasMentions(mentions)
  }

  async function supplyWork(ticketId: string, text: string) {
    const result = await foundations('/dsh-bot/api/work/supply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ticketId, text }),
    })
    if (result.status !== 200 || result.body.ok === false)
      return foundationsError(result.body, t('composer.supplyFailed'))
    return ''
  }

  async function cancel() {
    if (!task || task.status !== 'accepted') return
    const result = await api(`/tasks/${task.id}/cancel?sessionId=${encodeURIComponent(task.sessionId ?? '')}`, {
      method: 'POST',
    })
    const nextTask = (result.body.task as TaskRecord | undefined) ?? task
    setTask(nextTask)
    if (nextTask.status === 'cancelled') setThread(prev => ({ ...prev, drafting: false }))
  }

  const turnLive = task?.status === 'accepted' && thread.drafting
  const workTickets = loadedWorkSession === sessionId ? works : []
  const deleteLocked = deleteJob?.id === sessionId
  const locked = composerLocked(turnLive, workTickets, isBotSession) || deleteLocked
  const canSend = Boolean(sessionId) && execution.ready && draft.trim() !== '' && !locked

  function signalFor(item: { sessionId: string; running?: boolean }): 'run' | 'wait' | null {
    if (!bots.has(item.sessionId)) return null
    const live = item.running === true || (item.sessionId === sessionId && (turnLive || thread.drafting))
    const tickets =
      item.sessionId === sessionId && loadedWorkSession === sessionId
        ? works
        : (remoteStatus[item.sessionId] ?? []).map(status => ({ status }))
    return botSignal(tickets, live)
  }

  return (
    <div className={sessionId ? 'shell in-chat' : 'shell'}>
      <aside className="side">
        <div className="side-top">
          <strong className="brand">{t('app.title')}</strong>
          <span className="side-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={t('session.search')}
              onClick={() => setSearching(value => !value)}
            >
              <SearchIcon />
            </button>
            <button type="button" className="icon-btn" aria-label={t('new.title')} onClick={() => setSetupOpen(true)}>
              <PlusIcon />
            </button>
          </span>
        </div>
        {searching ? (
          <input
            className="filter"
            value={query}
            placeholder={t('session.searchPlaceholder')}
            onChange={event => setQuery(event.target.value)}
          />
        ) : null}
        {sessionNote ? <p className="note">{sessionNote}</p> : null}
        {setupNote ? <p className="note ok">{setupNote}</p> : null}
        <ul className="sessions">
          {conversations.length === 0 ? (
            <li className="empty">{query.trim() ? t('session.noMatch') : t('session.none')}</li>
          ) : null}
          {conversations.map(item => {
            const name = sessionName(item)
            return (
              <li key={item.sessionId} onContextMenu={event => openSessionMenu(event, item.sessionId)}>
                <button
                  type="button"
                  className={item.sessionId === sessionId ? 'session selected' : 'session'}
                  title={item.cwd || item.sessionId}
                  onClick={() => selectSession(item.sessionId)}
                >
                  <span className={bots.has(item.sessionId) ? 'mark bot-mark' : 'mark'}>
                    {bots.has(item.sessionId) ? 'BOT' : Array.from(name)[0]}
                    <BotDot signal={signalFor(item)} />
                  </span>
                  <span className="copy">
                    <span className="name">{name}</span>
                    <span className="preview">
                      {(item.sessionId === sessionId ? workPreview(works, workNow, t) : '') ||
                        previews[item.sessionId] ||
                        (item.running ? t('session.running') : '')}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {statusOpen ? <Status health={health} usage={usage} execution={execution} model={thread.model} /> : null}
        <div className="me-row">
          <button type="button" className="me" onClick={() => setStatusOpen(value => !value)}>
            <span className="mark me-mark">{t('local.mark')}</span>
            <span>{health?.primary?.reachable === false ? t('local.down') : t('local.here')}</span>
          </button>
          <button type="button" className="lang-switch" onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>
            {t('lang.switch')}
          </button>
        </div>
      </aside>
      <section className="chat">
        <header className="chat-head">
          {botChat ? (
            <button type="button" className="bot-chat-back" onClick={() => setBotChat(false)}>
              {t('nav.back')}
            </button>
          ) : isWorkerSession(sessionId) ? (
            <button type="button" className="back" onClick={leaveWorker}>
              {t('nav.back')}
            </button>
          ) : (
            <button
              type="button"
              className="back"
              onClick={() => {
                setFilesOpen(false)
                setFilePreview(null)
                setSessionId('')
              }}
            >
              {t('nav.sessions')}
            </button>
          )}
          {sessionId && bots.has(sessionId) ? (
            <span className="bot-badge">
              BOT
              <BotDot
                signal={signalFor({ sessionId, running: items.find(item => item.sessionId === sessionId)?.running })}
              />
            </span>
          ) : null}
          <h1>{botChat ? t('nav.botMessages') : title}</h1>
          {!botChat && workPreview(works, workNow, t) ? (
            <span className="work-chip">{workPreview(works, workNow, t)}</span>
          ) : null}
          {sessionId && !botChat ? (
            <button
              type="button"
              className="files-open"
              aria-pressed={settings === 'memory'}
              onClick={() => {
                if (settings === 'memory') {
                  setSettings(null)
                  return
                }
                setFilesOpen(false)
                setFilePreview(null)
                setSettings('memory')
              }}
            >
              {t('memory.open')}
            </button>
          ) : null}
          {sessionId && !botChat ? (
            <button
              type="button"
              className="files-open"
              aria-pressed={filesOpen}
              onClick={() => {
                if (filesOpen) {
                  setFilesOpen(false)
                  setFilePreview(null)
                  return
                }
                setSettings(current => (current === 'memory' ? null : current))
                setFilesOpen(true)
              }}
            >
              {t('files.open')}
            </button>
          ) : null}
          <a href={nativeHref}>{t('nav.official')}</a>
        </header>
        {isWorkerSession(sessionId) && !botChat ? (
          <nav className="work-crumb" aria-label={t('nav.where')}>
            <button type="button" onClick={leaveWorker}>
              {(workerOwner && botLabel(workerOwner)) || t('nav.mainSession')}
            </button>
            <span aria-hidden="true">/</span>
            <span>{t('nav.worker')}</span>
          </nav>
        ) : null}
        {sessionId && !botChat ? (
          <button
            type="button"
            className="basis"
            onClick={() => {
              setFilesOpen(false)
              setFilePreview(null)
              setSettings('memory')
            }}
          >
            {basis || t('memory.open')}
          </button>
        ) : null}
        <div className="chat-body">
          <HistoryLoading active={historyLoading || chunkBusy} progress={chunkProgress} />
          {detached && botChat ? <LatestButton label={t('scroll.latest')} onClick={() => pin('smooth')} /> : null}
          <div className="scroll" ref={scrollRef} aria-busy={historyLoading || chunkBusy || undefined}>
            <div className="column" ref={contentRef}>
              {!sessionId ? <p className="empty-thread">{t('nav.pick')}</p> : null}
              {sessionId &&
              !historyLoading &&
              !chunkBusy &&
              !botChat &&
              conversation.length === 0 &&
              works.length === 0 ? (
                <p className="empty-thread">{t('nav.empty')}</p>
              ) : null}
              <ImageFailureScope key={sessionId}>
                <CanvasScope
                  sessionId={!botChat && !historyLoading && sessionId ? sessionId : ''}
                  pulse={canvasPulse}
                  tickets={works}
                  onActive={setCanvasOpen}
                  dismiss={canvasDismiss}
                  onMention={chip =>
                    setCanvasMentions(prev => {
                      const rest = prev.filter(
                        item =>
                          !(
                            item.canvasId === chip.canvasId &&
                            item.revision === chip.revision &&
                            item.path === chip.path
                          ),
                      )
                      return [...rest, chip].slice(-8)
                    })
                  }
                >
                  {historyLoading ? null : botChat ? (
                    <BotChatView
                      items={exchange}
                      botLabel={botLabel}
                      onOpenFile={(path, line) => {
                        setSettings(current => (current === 'memory' ? null : current))
                        setFilePreview({ path, line, token: Date.now() })
                        setFilesOpen(true)
                      }}
                    />
                  ) : (
                    <Transcript
                      sessionId={sessionId}
                      cwd={items.find(s => s.sessionId === sessionId)?.cwd}
                      connectionPhase={syncStatus?.phase}
                      segments={conversation}
                      approvals={approvals}
                      questionWaits={questionWaits}
                      onCompose={text => placeDraft(text, text.length)}
                      completed={thread.completed}
                      failures={thread.failures}
                      retries={thread.retries}
                      turnEnds={thread.turnEnds}
                      tickets={works}
                      now={workNow}
                      canRetry={Boolean(sessionId) && execution.ready && !turnLive}
                      onRetry={text => {
                        void submit(text)
                      }}
                      onSupply={supplyWork}
                      onOpenSession={openWorkerSession}
                      onOpenFile={(path, line) => {
                        setSettings(current => (current === 'memory' ? null : current))
                        setFilePreview({ path, line, token: Date.now() })
                        setFilesOpen(true)
                      }}
                      onOpenInbox={() => setBotChat(true)}
                      botLabel={botLabel}
                      chat={isBotSession}
                    />
                  )}
                </CanvasScope>
              </ImageFailureScope>
            </div>
          </div>
          {botChat || historyLoading ? null : (
            <TurnRail
              root={scrollRef}
              marks={marks}
              busyId={thread.drafting && thread.turn != null ? `turn:${thread.turn}` : undefined}
            />
          )}
        </div>
        <ComposerDock ref={composerRef} lift={canvasOpen} hidden={botChat}>
          {detached ? <LatestButton label={t('scroll.latest')} onClick={() => pin('smooth')} /> : null}
          <form
            className="column"
            onSubmit={event => {
              event.preventDefault()
              void send()
            }}
          >
            {sessionId && !historyLoading ? (
              <CurrentActivity
                segments={thread.segments}
                drafting={thread.drafting}
                currentTurn={thread.turn}
                tickets={works}
                connectionPhase={syncStatus?.phase}
                pendingApprovals={approvals}
              />
            ) : null}
            <div className="card">
              {canvasMentions.length > 0 ? (
                <div className="canvas-chip-row">
                  {canvasMentions.map(chip => (
                    <span key={`${chip.canvasId}:${chip.revision}:${chip.path}`} className="canvas-chip">
                      <span className="canvas-chip-text">{chip.label}</span>
                      <button
                        type="button"
                        aria-label={t('canvas.removeMention')}
                        onClick={() =>
                          setCanvasMentions(prev =>
                            prev.filter(
                              item =>
                                !(
                                  item.canvasId === chip.canvasId &&
                                  item.revision === chip.revision &&
                                  item.path === chip.path
                                ),
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {mentionOpen ? (
                <div className="mention-menu" role="listbox" aria-label={t('composer.mention')}>
                  {mentionChoices.length === 0 ? (
                    <p className="mention-empty">{t('composer.noBot')}</p>
                  ) : (
                    mentionChoices.map((item, index) => (
                      <button
                        key={item.sessionId}
                        type="button"
                        role="option"
                        aria-selected={index === mentionActive}
                        className={index === mentionActive ? 'active' : ''}
                        onMouseDown={event => {
                          event.preventDefault()
                          chooseMention(item)
                        }}
                      >
                        <span className="bot-badge">BOT</span>
                        <span className="mention-name">{item.label}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
              <textarea
                ref={draftRef}
                value={draft}
                rows={1}
                placeholder={
                  sessionId
                    ? currentActivity({
                        segments: thread.segments,
                        drafting: thread.drafting,
                        currentTurn: thread.turn,
                        tickets: works,
                        pendingApprovals: approvals,
                        t,
                      })?.text === t('question.waiting') ||
                      currentActivity({
                        segments: thread.segments,
                        drafting: thread.drafting,
                        currentTurn: thread.turn,
                        tickets: works,
                        pendingApprovals: approvals,
                        t,
                      })?.text === t('approval.waiting')
                      ? t('question.waiting')
                      : (workPlaceholder(works, t) ??
                        (isBotSession && turnLive
                          ? t('composer.interrupt')
                          : bots.has(sessionId)
                            ? t('composer.mentionHint')
                            : t('composer.task')))
                    : t('composer.pick')
                }
                disabled={!sessionId}
                onChange={event => {
                  setDraft(event.target.value)
                  setCursor(event.target.selectionStart ?? event.target.value.length)
                }}
                onSelect={event => setCursor(event.currentTarget.selectionStart ?? 0)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return
                  if (mentionOpen && mentionChoices.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setMentionIndex(index => (index + 1) % mentionChoices.length)
                      return
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setMentionIndex(index => (index - 1 + mentionChoices.length) % mentionChoices.length)
                      return
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      event.preventDefault()
                      const target = mentionChoices[mentionActive]
                      if (target) chooseMention(target)
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setMentionClosed(mentionKey)
                      return
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="card-row">
                <div className="tools" ref={menuRef}>
                  <button
                    type="button"
                    className="add"
                    aria-label={t('composer.add')}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={!sessionId}
                    onClick={() => setMenuOpen(open => !open)}
                  >
                    <PlusIcon />
                  </button>
                  {menuOpen ? (
                    <div className="plus-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => insertSlash()}>
                        {t('composer.command')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          setFilesOpen(false)
                          setFilePreview(null)
                          setSettings('memory')
                        }}
                      >
                        {t('memory.open')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          setSettings('permission')
                        }}
                      >
                        {t('permission.open')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          setSettings('authorization')
                        }}
                      >
                        {t('auth.open')}
                      </button>
                      {cuaAvailable ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false)
                            setSettings('cua')
                          }}
                        >
                          {t('cua.open')}
                        </button>
                      ) : null}
                      <p className="plus-note">{t('composer.filesLater')}</p>
                    </div>
                  ) : null}
                  {thread.preset ? (
                    <button
                      type="button"
                      className="chip"
                      aria-label={presetLabel(thread.preset, t)}
                      title={presetLabel(thread.preset, t)}
                      onClick={() => setSettings('permission')}
                    >
                      <PermissionIcon preset={thread.preset} />
                    </button>
                  ) : null}
                </div>
                <div className="trailing">
                  {thread.model ? <span className="model">{thread.model}</span> : null}
                  {turnLive ? (
                    <button
                      type="button"
                      className="stop"
                      aria-label={t('composer.cancel')}
                      onClick={() => {
                        void cancel()
                      }}
                    >
                      <span className="stop-icon" />
                    </button>
                  ) : null}
                  {locked ? null : (
                    <button type="submit" className="send" aria-label={t('composer.send')} disabled={!canSend}>
                      <ArrowIcon />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="stats">
              {reason || (!execution.ready ? hostText(execution.reason, execution.reason, t) : statsLine(thread))}
            </p>
          </form>
        </ComposerDock>
      </section>
      {settings === 'permission' && sessionId ? (
        <PermissionPanel
          sessionId={sessionId}
          current={thread.preset}
          onClose={() => setSettings(null)}
          onChanged={() => setBasisRevision(current => current + 1)}
        />
      ) : null}
      {settings === 'authorization' || (authPending && settings == null) ? (
        <AuthorizationPanel
          authorization={authorization}
          catalog={authorizationCatalog}
          onClose={() => setSettings(null)}
        />
      ) : null}
      {settings === 'cua' && cuaAvailable ? <CuaPanel onClose={() => setSettings(null)} /> : null}
      {sessionId ? (
        <FileBrowser
          key={sessionId}
          open={filesOpen}
          sessionId={sessionId}
          focus={filePreview}
          onClose={() => {
            setFilesOpen(false)
            setFilePreview(null)
          }}
        />
      ) : null}
      {sessionId && !botChat ? (
        <MemoryPanel open={settings === 'memory'} sessionId={sessionId} onClose={() => setSettings(null)} />
      ) : null}
      {deleteJob
        ? createPortal(
            <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-progress-title">
              <div className="delete-card">
                <h2 id="delete-progress-title">{t('session.deleteProgress')}</h2>
                <p>{deleteJob.error || deleteLabel(deleteJob.phase)}</p>
                <div
                  className="delete-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={deleteJob.percent}
                  aria-valuetext={deleteLabel(deleteJob.phase)}
                >
                  <div className="delete-bar" style={{ width: `${Math.max(0, Math.min(100, deleteJob.percent))}%` }} />
                </div>
                {deleteJob.error ? (
                  <button type="button" onClick={() => void runDelete(deleteJob.id)}>
                    {t('session.deleteRetry')}
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
      {sessionMenu ? (
        <div
          ref={sessionMenuRef}
          className="session-menu"
          role="menu"
          aria-label={t('session.menu')}
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          onContextMenu={event => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = sessionMenu.id
              setSessionMenu(null)
              void runDelete(id)
            }}
          >
            {t('session.delete')}
          </button>
        </div>
      ) : null}
      {setupOpen ? (
        <NewSessionSheet
          onClose={() => setSetupOpen(false)}
          onCreated={(id, note, name) => {
            void finishCreate(id, note, name)
          }}
        />
      ) : null}
    </div>
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
