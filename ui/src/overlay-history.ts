/**
 * Browser-history entries for the workbench overlays.
 *
 * The official DSH client has a small router plugin (`client.js`) that mirrors
 * the open overlay stack into the URL: opening a drawer or a modal pushes one
 * history entry, Back peels exactly one overlay off, and closing an overlay
 * with the app's own control rewinds the entry instead of leaving a dead one.
 *
 * The workbench already routes Sessions through `#/s/<id>`. This module adds
 * the same overlay policy without taking over Session routing: the optional
 * `/o/<depth>` segment sits next to the Session segment and the React layer
 * remains the source of truth for which overlays are open.
 *
 * Framework-free on purpose, so the policy can be tested without a DOM.
 */

/** Key of the marker this module keeps in `history.state`. */
export const OVERLAY_STATE_KEY = '__dshBotUiOverlay'

/** The overlay depth is capped so a runaway stack cannot fill the address bar. */
export const MAX_OVERLAY_DEPTH = 9

/** How long after a history event corrections rewrite the entry in place. */
const SETTLE_MS = 1500

/** Our own `history.back()` gets this long to land before it is given up on. */
const BACK_MS = 1200

/** One overlay close gets this long to commit before the next step. */
const CLOSE_STEP_MS = 40

/** Close steps allowed for one Back press. */
const CLOSE_TRIES = 12

/** A minimal history surface, so tests can drive a fake browser. */
export interface HistoryLike {
  readonly state: unknown
  pushState(state: unknown, title: string, url?: string | URL | null): void
  replaceState(state: unknown, title: string, url?: string | URL | null): void
  back(): void
}

/** A minimal location surface. */
export interface LocationLike {
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

/** Marker recorded on a history entry. */
export interface OverlayHistoryTag {
  kind: 'overlay' | 'route'
  depth: number
}

export interface OverlayHistoryOptions {
  history: HistoryLike
  location: LocationLike
  addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
  removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
  /** Currently open overlays, bottom to top. */
  stack: () => readonly string[]
  /** Close one overlay by the id returned from `stack()`. */
  close: (id: string) => void
  /** Clock, injectable for tests. */
  now?: () => number
}

/**
 * Read the overlay depth out of a location hash.
 * @param hash - `location.hash`, with or without the leading `#`.
 * @returns the depth, 0 when absent or malformed.
 */
export function readOverlayDepth(hash: string): number {
  if (typeof hash !== 'string' || hash === '') return 0
  const match = /(?:^|\/)o\/(\d+)(?=\/|$)/.exec(hash)
  if (match === null) return 0
  const depth = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(depth) && depth > 0 ? Math.min(depth, MAX_OVERLAY_DEPTH) : 0
}

/**
 * Drop every `/o/<depth>` segment, keeping the Session and any other pairs.
 * @param hash - location hash.
 * @returns the hash without the overlay segment, normalised to `#/` at the root.
 */
export function stripOverlaySegment(hash: string): string {
  const raw = typeof hash === 'string' && hash !== '' ? hash : '#/'
  const next = raw.replace(/(^|\/)o\/\d+(?=\/|$)/g, '')
  return next === '' || next === '#' ? '#/' : next
}

/**
 * Append one `/o/<depth>` segment.
 * @param hash - current location hash.
 * @param depth - overlay depth; 0 removes the segment.
 * @returns the new hash.
 */
export function withOverlaySegment(hash: string, depth: number): string {
  const base = stripOverlaySegment(hash)
  const safe = Number.isFinite(depth) ? Math.max(0, Math.min(Math.floor(depth), MAX_OVERLAY_DEPTH)) : 0
  if (safe === 0) return base
  return base.endsWith('/') ? `${base}o/${safe}` : `${base}/o/${safe}`
}

/**
 * @param state - `history.state` of any shape.
 * @returns this module's marker when it is well formed.
 */
export function readOverlayTag(state: unknown): OverlayHistoryTag | undefined {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined
  const raw = (state as Record<string, unknown>)[OVERLAY_STATE_KEY]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = (raw as { kind?: unknown }).kind
  const depth = (raw as { depth?: unknown }).depth
  if ((kind !== 'overlay' && kind !== 'route') || typeof depth !== 'number' || !Number.isFinite(depth)) {
    return undefined
  }
  return { kind, depth: Math.max(0, Math.min(Math.floor(depth), MAX_OVERLAY_DEPTH)) }
}

/** @returns whether the entry is one this module opened for an overlay. */
export function isOverlayEntry(state: unknown): boolean {
  return readOverlayTag(state)?.kind === 'overlay'
}

export class OverlayHistoryController {
  private readonly options: OverlayHistoryOptions
  private readonly now: () => number
  /** Overlay depth the current history entry is believed to describe. */
  private published: number
  /** Overlay depth a Back press asked for, while the closes run. */
  private settling: number | null = null
  /** Non-zero while our own `history.back()` is in flight. */
  private backAt = 0
  /** Echoes until this timestamp rewrite the URL in place. */
  private settleUntil: number
  /** Pending close-step timer. */
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: OverlayHistoryOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    const tag = readOverlayTag(options.history.state)
    this.published = tag?.depth ?? readOverlayDepth(options.location.hash)
    // Boot is not a user move: never call `history.back()` for it.
    this.settleUntil = this.now() + SETTLE_MS
  }

  /** Listen for Back / Forward and publish the first route. */
  start(): void {
    if (this.disposed) return
    this.options.addEventListener('popstate', this.onHistory)
    this.options.addEventListener('hashchange', this.onHistory)
    this.queue()
  }

  /** Stop listening and drop a pending close sequence. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.removeEventListener('popstate', this.onHistory)
    this.options.removeEventListener('hashchange', this.onHistory)
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * React's overlay state changed. Push, rewind, or correct the current entry
   * so its `/o/<depth>` segment matches the open stack again.
   */
  sync(): void {
    if (this.disposed) return
    if (this.settling !== null) return
    if (this.backAt !== 0) {
      if (this.now() - this.backAt <= BACK_MS) return
      this.backAt = 0
    }
    const depth = Math.min(this.options.stack().length, MAX_OVERLAY_DEPTH)
    if (depth > this.published) {
      // An overlay appearing is always the user's doing, so it gets its own
      // entry even right after a history move. The next in-app close must be
      // allowed to rewind that entry immediately.
      this.settleUntil = this.now()
      this.publish(depth, 'push', 'overlay')
      return
    }
    if (depth < this.published) {
      const tag = readOverlayTag(this.options.history.state)
      const fresh = this.now() >= this.settleUntil
      // The current entry exists only for the overlay that just closed, so
      // stepping back removes it instead of leaving a dead entry behind.
      if (
        fresh &&
        depth === this.published - 1 &&
        tag !== undefined &&
        tag.kind === 'overlay' &&
        tag.depth === this.published
      ) {
        this.backAt = this.now()
        try {
          this.options.history.back()
          return
        } catch {
          this.backAt = 0
        }
      }
      this.publish(depth, 'replace', 'route')
      return
    }
    const tag = readOverlayTag(this.options.history.state)
    // A different overlay at the same depth replaces the one on top; keep the
    // entry marked as an overlay so its own close still rewinds it.
    const kind = depth > 0 && tag?.kind === 'overlay' && tag.depth === depth ? 'overlay' : 'route'
    this.publish(depth, 'replace', kind)
  }

  /** `popstate` / `hashchange`: bring the open stack to the URL's depth. */
  private readonly onHistory = (): void => {
    if (this.disposed) return
    this.backAt = 0
    if (this.settling !== null) return
    const target = readOverlayDepth(this.options.location.hash)
    const depth = Math.min(this.options.stack().length, MAX_OVERLAY_DEPTH)
    if (target < depth) {
      this.closeToDepth(target)
      return
    }
    this.published = target
    this.settleUntil = this.now() + SETTLE_MS
    this.sync()
  }

  /**
   * Close overlays until only `target` remain. Closes commit asynchronously
   * through React, so this walks one step per frame instead of closing
   * everything inside the event handler.
   * @param target - overlay depth the Back press asked for.
   */
  private closeToDepth(target: number): void {
    this.settling = target
    let tries = 0
    const step = (): void => {
      this.timer = null
      if (this.disposed) return
      const stack = this.options.stack()
      if (stack.length <= target || tries >= CLOSE_TRIES) {
        this.settling = null
        this.settleUntil = this.now() + SETTLE_MS
        const actual = Math.min(stack.length, MAX_OVERLAY_DEPTH)
        this.published = target
        // A close that did not commit (for example a non-dismissible progress
        // dialog) must not grow the stack again; correct the URL in place.
        if (actual > target) this.publish(actual, 'replace', 'route')
        else this.sync()
        return
      }
      tries += 1
      const id = stack[stack.length - 1]
      if (id !== undefined) {
        try {
          this.options.close(id)
        } catch {
          /* Let the next step inspect the stack again. */
        }
      }
      this.timer = setTimeout(step, CLOSE_STEP_MS)
    }
    this.timer = setTimeout(step, 0)
  }

  /**
   * @param depth - overlay depth to record.
   * @param mode - `push` for a new entry, `replace` to rewrite in place.
   * @param kind - why the entry exists.
   */
  private publish(depth: number, mode: 'push' | 'replace', kind: 'overlay' | 'route'): void {
    const location = this.options.location
    const base = stripOverlaySegment(location.hash)
    const url = location.pathname + location.search + withOverlaySegment(base, depth)
    const current = location.pathname + location.search + (location.hash === '' ? '#/' : location.hash)
    const tag = readOverlayTag(this.options.history.state)
    const sameUrl = url === current
    const sameTag = tag !== undefined && tag.kind === kind && tag.depth === depth
    if (sameUrl && (sameTag || (tag === undefined && depth === 0))) {
      this.published = depth
      return
    }
    const state = this.withTag({ kind, depth })
    this.published = depth
    try {
      if (mode === 'push') this.options.history.pushState(state, '', url)
      else this.options.history.replaceState(state, '', url)
    } catch {
      /* History may be unavailable in a sandboxed frame; the app still works. */
    }
  }

  /**
   * @param tag - marker to record.
   * @returns the state object to write, keeping whatever the app already stored.
   */
  private withTag(tag: OverlayHistoryTag): Record<string, unknown> {
    const current = this.options.history.state
    const base =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    base[OVERLAY_STATE_KEY] = tag
    return base
  }

  /** Defer the boot `sync` until after the current render / effect turn. */
  private queue(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.sync()
    }, 0)
  }
}
