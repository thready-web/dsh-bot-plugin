/**
 * Startup timing marks for the shell.
 *
 * `first-shell` is the moment the workbench chrome has painted, before any identity
 * result and before any chat body. It is a local sample only: nothing here reports to
 * a server. docs/pwa-instant-start.md §11 defines the full set of marks.
 */
export const FIRST_SHELL = 'first-shell'

export function markFirstShell(): void {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return
  const mark = () => {
    try {
      performance.mark(FIRST_SHELL)
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const start = typeof navigation?.startTime === 'number' ? navigation.startTime : 0
      performance.measure('first-shell-ms', { start, end: FIRST_SHELL })
    } catch {
      /* diagnostics only */
    }
  }
  // Two frames: one lands the commit, one lands the paint.
  window.requestAnimationFrame(() => window.requestAnimationFrame(mark))
}
