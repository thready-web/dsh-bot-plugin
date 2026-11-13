/** In-memory only. One store belongs to one mounted session view, never an account-global cache. */
export function createImageFailures(limit = 128) {
  const failed = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    has: (src: string) => failed.has(src),
    fail(src: string) {
      if (failed.has(src)) return
      // Bound retained URLs, including unusually large data URLs. A mounted
      // preview also keeps its own failure state if this cache cannot retain it.
      if (src.length > 4096) return
      failed.add(src)
      if (failed.size > limit) failed.delete(failed.values().next().value!)
      notify()
    },
    retry(src: string) {
      if (failed.delete(src)) notify()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
