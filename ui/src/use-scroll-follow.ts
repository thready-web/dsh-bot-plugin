import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BOTTOM_SLOP,
  createFollowScroll,
  gapFromBottom,
  leaveBottom,
  noteScroll,
  pauseFollow,
  type FollowScroll,
} from './scroll-follow'

function maxOffset(node: HTMLElement): number {
  return Math.max(0, node.scrollHeight - node.clientHeight)
}

/** A nested overflow that can still move upward should keep the transcript's follow state. */
function nestedCanScrollUp(container: HTMLElement, target: EventTarget | null): boolean {
  let node: Element | null = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  while (node && node !== container) {
    const overflowY = getComputedStyle(node).overflowY
    const scrolls = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrolls && node.scrollHeight > node.clientHeight + 1 && node.scrollTop > 1) return true
    node = node.parentElement
  }
  return false
}

/**
 * Pin while the reader is at the end. Wheel, touch, keys, selection, and disclosures
 * release immediately so the next content growth cannot pull them back.
 */
export function useScrollFollow(resetKey: string) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const state = useRef<FollowScroll>(createFollowScroll())
  const smoothing = useRef(false)
  const [detached, setDetached] = useState(false)

  const publish = useCallback((node: HTMLElement | null) => {
    if (!node) {
      setDetached(false)
      return
    }
    const away = !state.current.following && gapFromBottom(node) > BOTTOM_SLOP
    setDetached(current => (current === away ? current : away))
  }, [])

  const stickIfFollowing = useCallback(() => {
    const node = scrollRef.current
    if (!node || !state.current.following) {
      publish(node)
      return
    }
    const top = maxOffset(node)
    if (Math.abs(node.scrollTop - top) <= 1) {
      state.current.programmaticTop = null
      publish(node)
      return
    }
    state.current.programmaticTop = top
    node.scrollTop = top
    publish(node)
  }, [publish])

  const pin = useCallback((behavior: ScrollBehavior = 'auto') => {
    const node = scrollRef.current
    state.current.following = true
    state.current.suppressRejoin = false
    setDetached(false)
    if (!node) return
    const top = maxOffset(node)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (behavior === 'smooth' && !reduce && node.scrollTop < top - 1) {
      smoothing.current = true
      state.current.programmaticTop = null
      node.scrollTo({ top, behavior: 'smooth' })
      return
    }
    smoothing.current = false
    state.current.programmaticTop = top
    node.scrollTop = top
  }, [])

  useLayoutEffect(() => {
    const next = createFollowScroll()
    state.current = next
    smoothing.current = false
    setDetached(false)
    const node = scrollRef.current
    if (!node) return
    const top = maxOffset(node)
    next.programmaticTop = top
    next.lastTop = top
    next.lastHeight = node.scrollHeight
    node.scrollTop = top
  }, [resetKey])

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return

    const cancelSmooth = () => {
      if (!smoothing.current) return
      smoothing.current = false
      state.current.suppressRejoin = true
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollTop
        requestAnimationFrame(() => {
          state.current.suppressRejoin = false
        })
      })
    }

    const escapeByInput = () => {
      if (!leaveBottom(state.current, scroll)) return
      cancelSmooth()
      publish(scroll)
    }

    const pause = () => {
      pauseFollow(state.current)
      cancelSmooth()
      publish(scroll)
    }

    const onScroll = () => {
      const result = noteScroll(state.current, scroll)
      if (result.following && gapFromBottom(scroll) <= BOTTOM_SLOP) smoothing.current = false
      setDetached(current => (current === result.detached ? current : result.detached))
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !nestedCanScrollUp(scroll, event.target)) escapeByInput()
    }

    let touchY = 0
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY
      if (y > touchY + 8 && !nestedCanScrollUp(scroll, event.target)) escapeByInput()
      touchY = y
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return
      if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') escapeByInput()
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('button.official-title, summary')) return
      pause()
    }

    const onSelect = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      const anchor = selection.anchorNode
      if (!anchor || !scroll.contains(anchor)) return
      pause()
    }

    const observer = new ResizeObserver(() => {
      stickIfFollowing()
    })
    observer.observe(content)
    scroll.addEventListener('scroll', onScroll, { passive: true })
    scroll.addEventListener('wheel', onWheel, { passive: true })
    scroll.addEventListener('touchstart', onTouchStart, { passive: true })
    scroll.addEventListener('touchmove', onTouchMove, { passive: true })
    scroll.addEventListener('keydown', onKeyDown)
    scroll.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('selectionchange', onSelect)
    stickIfFollowing()

    return () => {
      observer.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('touchstart', onTouchStart)
      scroll.removeEventListener('touchmove', onTouchMove)
      scroll.removeEventListener('keydown', onKeyDown)
      scroll.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('selectionchange', onSelect)
    }
  }, [resetKey, publish, stickIfFollowing])

  return { scrollRef, contentRef, detached, pin, stickIfFollowing }
}
