/** Appends at or below this size glide across the next few frames. */
export const REVEAL_IMMEDIATE_GRAPHEMES = 24

/** A short append finishes inside this window, about one coarse paint tick. */
export const REVEAL_QUICK_MS = 48

/** A larger burst finishes inside this window, speeding up as the backlog grows. */
export const REVEAL_DRAIN_MS = 200

const FRAME_MS = 16

export interface RevealState {
  /** Text already painted. `null` means this string has not been shown yet. */
  shown: string | null
  /** Graphemes painted per frame while catching up. Reset once the text is aligned. */
  step: number
}

export interface RevealOptions {
  active: boolean
  reduced: boolean
  now: number
  frameMs?: number
}

export interface RevealPlan {
  shown: string
  step: number
  done: boolean
}

let segmenter: Intl.Segmenter | null | undefined

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter
  const available = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  segmenter = available ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  return segmenter
}

function graphemeCount(text: string): number {
  if (text.length === 0) return 0
  const current = graphemeSegmenter()
  if (!current) return Array.from(text).length
  let count = 0
  for (const part of current.segment(text)) if (part.segment.length > 0) count += 1
  return count
}

/** Take at most `count` graphemes without splitting a surrogate pair or a cluster. */
function takeGraphemes(text: string, count: number): string {
  if (count <= 0 || text.length === 0) return ''
  const current = graphemeSegmenter()
  let taken = 0
  let end = 0
  if (!current) {
    for (const char of text) {
      if (taken >= count) break
      taken += 1
      end += char.length
    }
    return text.slice(0, end)
  }
  for (const part of current.segment(text)) {
    if (taken >= count) break
    taken += 1
    end = part.index + part.segment.length
  }
  return text.slice(0, end)
}

function align(target: string): RevealPlan {
  return { shown: target, step: 0, done: true }
}

/**
 * How much of `target` to paint this frame.
 * The first observation, a settled string, reduced motion, and any rewrite snap.
 * A short append glides across {@link REVEAL_QUICK_MS}; a burst catches up inside {@link REVEAL_DRAIN_MS}.
 * The per-frame step never shrinks mid-catch-up, so a fixed burst finishes on time instead of tapering off.
 */
export function planReveal(state: RevealState, target: string, opts: RevealOptions): RevealPlan {
  if (state.shown == null || !opts.active || opts.reduced || !target.startsWith(state.shown)) return align(target)
  if (state.shown === target) return align(target)
  const pending = target.slice(state.shown.length)
  const lag = graphemeCount(pending)
  const frameMs = opts.frameMs && opts.frameMs > 0 ? opts.frameMs : FRAME_MS
  const windowMs = lag <= REVEAL_IMMEDIATE_GRAPHEMES ? REVEAL_QUICK_MS : REVEAL_DRAIN_MS
  const frames = Math.max(1, windowMs / frameMs)
  const step = Math.max(state.step, Math.max(1, Math.ceil(lag / frames)))
  const shown = state.shown + takeGraphemes(pending, step)
  const done = shown === target
  return { shown, step: done ? 0 : step, done }
}
