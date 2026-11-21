import { presenceColor, readPresenceEngine, type PresenceState } from '@tobs/bot-presence'
import { useEffect, useRef, useState } from 'react'

interface LiveHandle {
  update(state: PresenceState, lookAt?: { x: number; y: number } | null): void
  destroy(): void
}

const svgCache = new Map<string, string>()
/** A passing pointer does not wake the face. A settled hover does. */
const ENTER_MS = 160
/** The look eases back before the live face gives way to the still drawing. */
const RELEASE_MS = 640
const FADE_MS = 220

/**
 * One session's face. Lists and cards stay still until asked to follow the pointer.
 * The open chat title is the resting live canvas. Until a face is ready, the slot stays empty.
 */
export function PresenceMark({
  sessionId,
  state,
  still,
  follow = false,
  lookAt = null,
  grace = false,
  size,
  label = '',
}: {
  sessionId: string
  state: PresenceState
  still: boolean
  /** Live canvas that looks toward the pointer. The still drawing stays up until the first frame. */
  follow?: boolean
  /** Fixed look while live. The still drawing stays up until the first frame. */
  lookAt?: { x: number; y: number } | null
  /** Delay the start, and ease the look back before returning to the still face. */
  grace?: boolean
  size: number
  label?: string
}) {
  const engine = readPresenceEngine()
  const enabled = engine === 'open-bot-avatar'
  const color = presenceColor(sessionId)
  const [visual, setVisual] = useState(state)
  const [svg, setSvg] = useState<string | null>(null)
  const [liveReady, setLiveReady] = useState(false)
  const [playing, setPlaying] = useState(!still && !grace)
  const [released, setReleased] = useState(false)
  const stillRef = useRef<HTMLSpanElement>(null)
  const liveHostRef = useRef<HTMLSpanElement>(null)
  const liveRef = useRef<LiveHandle | null>(null)
  const visualRef = useRef(visual)
  const lookRef = useRef(lookAt)
  const playingRef = useRef(playing)
  const timers = useRef<number[]>([])
  visualRef.current = visual
  lookRef.current = released ? null : lookAt
  playingRef.current = playing

  useEffect(() => {
    const clearTimers = () => {
      for (const id of timers.current) window.clearTimeout(id)
      timers.current = []
    }
    if (!enabled) return clearTimers
    clearTimers()
    if (!still) {
      if (grace && playingRef.current) {
        setReleased(false)
        if (liveRef.current) setLiveReady(true)
        return clearTimers
      }
      const wait = grace ? ENTER_MS : 0
      timers.current.push(
        window.setTimeout(() => {
          setReleased(false)
          setPlaying(true)
        }, wait),
      )
      return clearTimers
    }
    if (!grace || !playingRef.current) return clearTimers
    setReleased(true)
    timers.current.push(
      window.setTimeout(() => {
        setLiveReady(false)
        timers.current.push(window.setTimeout(() => setPlaying(false), FADE_MS))
      }, RELEASE_MS),
    )
    return clearTimers
  }, [enabled, grace, still])

  useEffect(() => {
    if (visual === state) return
    const timer = window.setTimeout(() => setVisual(state), 80)
    return () => window.clearTimeout(timer)
  }, [state, visual])

  useEffect(() => {
    if (!enabled || !still) return
    const key = `${sessionId}|${color}|${visual}|${size}`
    const cached = svgCache.get(key)
    if (cached) {
      setSvg(cached)
      return
    }
    let cancelled = false
    void import('@tobs/bot-presence/engine')
      .then(mod => mod.renderStill({ sessionId, state: visual, color }))
      .then(markup => {
        if (cancelled) return
        if (markup) svgCache.set(key, markup)
        setSvg(markup)
      })
      .catch(() => {
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [color, enabled, sessionId, size, still, visual])

  useEffect(() => {
    if (!enabled || !playing) return
    const host = liveHostRef.current
    if (!host) return
    let dead = false
    void import('@tobs/bot-presence/engine')
      .then(mod =>
        mod.mountLive(host, {
          sessionId,
          state: visualRef.current,
          color,
          followPointer: follow,
          lookAt: lookRef.current,
        }),
      )
      .then(handle => {
        if (dead || !handle) {
          handle?.destroy()
          return
        }
        liveRef.current = handle
        // The first frame is painted on the following animation frame. Reveal after that.
        requestAnimationFrame(() => {
          if (!dead) setLiveReady(true)
        })
      })
      .catch(() => {
        if (!dead) setLiveReady(false)
      })
    return () => {
      dead = true
      liveRef.current?.destroy()
      liveRef.current = null
      setLiveReady(false)
    }
  }, [color, enabled, follow, playing, sessionId])

  useEffect(() => {
    if (!playing || !liveReady) return
    liveRef.current?.update(visual, released ? null : lookAt)
  }, [liveReady, lookAt, playing, released, visual])

  useEffect(() => {
    const host = stillRef.current
    if (!host || !still) return
    host.replaceChildren()
    if (!svg) return
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    if (root.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) return
    host.append(document.importNode(root, true))
  }, [still, svg])

  return (
    <span
      className="presence"
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <span ref={stillRef} className="presence-host presence-still" />
      <span
        ref={liveHostRef}
        className="presence-host presence-live"
        data-ready={liveReady ? 'true' : 'false'}
      />
    </span>
  )
}
