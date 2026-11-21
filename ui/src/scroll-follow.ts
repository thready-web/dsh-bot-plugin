/** How close to the end still counts as the bottom, including sub-pixel clipping. */
export const BOTTOM_SLOP = 8

/** Share of the remaining distance to close on each frame while following. */
export const FOLLOW_EASE = 0.35

/**
 * Empty tail under the last message, also the distance that resumes follow.
 * Scrolling down until this gap is on screen means the reader has reached the live edge.
 */
export const FOLLOW_GAP = 56

export type ScrollBox = {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export type FollowScroll = {
  /** Content growth pins the viewport only while this stays true. */
  following: boolean
  /** Next scroll event at this offset was written by us, not the user. */
  programmaticTop: number | null
  /** Ignore a downward arrival while a cancelled smooth scroll is still settling. */
  suppressRejoin: boolean
  lastTop: number | null
  lastHeight: number | null
}

export function createFollowScroll(): FollowScroll {
  return { following: true, programmaticTop: null, suppressRejoin: false, lastTop: null, lastHeight: null }
}

export function gapFromBottom(box: ScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight
}

/** Next offset while chasing the live edge. Never steps past the target. */
export function smoothFollowTop(current: number, target: number): number {
  const gap = target - current
  if (gap <= 1) return target
  return Math.min(target, current + Math.max(1, gap * FOLLOW_EASE))
}

/**
 * A short thread is already fully visible at scrollTop 0, because the leftover
 * space sits above it. The frame it grows past the port, jump to the live edge.
 * Easing from 0 would flash the oldest line.
 */
export function snapGrowingThread(scrollTop: number, target: number): boolean {
  return scrollTop <= 1 && target > BOTTOM_SLOP
}

/** Upward input. A thread that cannot move does not leave follow. */
export function leaveBottom(state: FollowScroll, box: ScrollBox): boolean {
  if (box.scrollTop <= 1 && gapFromBottom(box) <= BOTTOM_SLOP) return false
  state.following = false
  return true
}

/** Selection or an in-flow disclosure. Holds even when the viewport is already at the end. */
export function pauseFollow(state: FollowScroll): void {
  state.following = false
}

export function noteScroll(state: FollowScroll, box: ScrollBox): { following: boolean; detached: boolean } {
  const gap = gapFromBottom(box)
  const programmed = state.programmaticTop != null && Math.abs(box.scrollTop - state.programmaticTop) <= 1
  state.programmaticTop = null
  const heightChanged = state.lastHeight != null && box.scrollHeight !== state.lastHeight
  const movedUp = state.lastTop != null && box.scrollTop < state.lastTop - 1
  const movedDown = state.lastTop != null && box.scrollTop > state.lastTop + 1
  // Height changes (stream tokens, images, the composer pad) are not the user leaving.
  if (!programmed && !heightChanged && movedUp) state.following = false
  // Revealing the tail blank, on the way down, is the live edge. An upward nudge stays detached
  // so the next token cannot pull the reader back.
  if (!state.following && !state.suppressRejoin && !programmed && !heightChanged && movedDown && gap <= FOLLOW_GAP)
    state.following = true
  state.lastTop = box.scrollTop
  state.lastHeight = box.scrollHeight
  return { following: state.following, detached: !state.following && gap > BOTTOM_SLOP }
}
