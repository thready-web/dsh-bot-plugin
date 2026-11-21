import { useEffect, useRef, useState } from 'react'
import { planReveal, type RevealState } from './smooth-text'

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Reveal `target` while `active`. Whatever is on screen at the first paint stays whole. */
export function useSmoothText(target: string, active: boolean): string {
  const state = useRef<RevealState>({ shown: target, step: 0 })
  const [display, setDisplay] = useState(target)
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const latest = useRef({ target, active, reduced })
  latest.current = { target, active, reduced }

  const shown = state.current.shown
  const snap = !active || reduced || (shown != null && !target.startsWith(shown))
  if (snap && (display !== target || state.current.step !== 0 || shown !== target)) {
    state.current = { shown: target, step: 0 }
    if (display !== target) setDisplay(target)
  }

  useEffect(() => {
    if (!active) return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [active])

  useEffect(() => {
    if (!active || reduced) return
    let frame = 0
    let stopped = false
    const tick = (now: number) => {
      if (stopped) return
      const current = latest.current
      if (!current.active || current.reduced) return
      const next = planReveal(state.current, current.target, {
        active: current.active,
        reduced: current.reduced,
        now,
      })
      state.current = { shown: next.shown, step: next.step }
      setDisplay(previous => (previous === next.shown ? previous : next.shown))
      if (!next.done) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
    }
  }, [target, active, reduced])

  return display
}
