import { useEffect, useLayoutEffect, useRef } from 'react'
import { OverlayHistoryController } from './overlay-history.ts'

/**
 * Give every open workbench overlay one history entry and close them again on
 * Back. `open` is the current overlay ids; the order they first appeared is
 * kept here, so a Back press always closes the one on top.
 * @param open - currently open overlay ids. The array may be rebuilt on every
 * render; only ids that were not already open are appended to the stack.
 * @param close - closes one overlay by id. Must update the React state that
 * produced `open`; it runs from a Back / Forward handler.
 */
export function useOverlayHistory(open: readonly string[], close: (id: string) => void): void {
  const stack = useRef<string[]>([])
  const closeRef = useRef(close)
  closeRef.current = close
  const controller = useRef<OverlayHistoryController | null>(null)

  // Keep the opening order instead of the caller's render order: overlays can
  // open in one state update, and Back has to peel the newest one first. This
  // runs after commit, so an abandoned render cannot leave a phantom overlay
  // on the stack.
  const key = open.join('\u0000')
  useLayoutEffect(() => {
    const previous = stack.current
    const ordered = previous.filter(id => open.includes(id))
    for (const id of open) {
      if (!ordered.includes(id)) ordered.push(id)
    }
    stack.current = ordered
    controller.current?.sync()
  }, [key])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const history = new OverlayHistoryController({
      history: window.history,
      location: window.location,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
      stack: () => stack.current,
      close: id => closeRef.current(id),
    })
    controller.current = history
    history.start()
    return () => {
      history.dispose()
      if (controller.current === history) controller.current = null
    }
  }, [])
}
