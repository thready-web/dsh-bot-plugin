/** Hybrid sync: compact SSE snapshots; bounded REST reconciliation for old hosts/disconnects. */
export function createInteractionSync(options: {
  fetch(signal: AbortSignal): Promise<unknown>
  apply(value: unknown): void
  active?(value: unknown): boolean
  schedule(fn: () => void, ms: number): () => void
  visible?: boolean
}) {
  let stopped = false
  let visible = options.visible !== false
  let streamed = false
  let busy = false
  let queued = false
  let epoch = 0
  let failures = 0
  let last = ''
  let active = false
  let cancelTimer = () => {}
  let abort: AbortController | null = null
  function accept(value: unknown) {
    const text = JSON.stringify(value)
    if (text === last) return
    last = text
    active = options.active?.(value) === true
    options.apply(value)
  }
  function schedule() {
    cancelTimer()
    if (stopped || !visible) return
    const delay = streamed ? 60_000 : active ? 1500 : Math.min(15_000, 2000 * 2 ** Math.min(failures, 3))
    cancelTimer = options.schedule(() => void refresh(), delay)
  }
  async function refresh() {
    if (stopped || !visible) return
    if (busy) {
      queued = true
      return
    }
    cancelTimer()
    busy = true
    const generation = epoch
    abort = new AbortController()
    const request = abort
    const cancelDeadline = options.schedule(() => request.abort(), 10_000)
    try {
      const value = await options.fetch(abort.signal)
      if (!stopped && visible && generation === epoch) accept(value)
      failures = Math.min(failures + 1, 3)
    } catch {
      failures = Math.min(failures + 1, 3)
    } finally {
      cancelDeadline()
      busy = false
      if (queued) {
        queued = false
        void refresh()
      } else schedule()
    }
  }
  const api = {
    ingest(value: unknown) {
      if (stopped || !visible) return
      epoch++ // A late REST response must never overwrite a newer stream snapshot.
      streamed = true
      failures = 0
      accept(value)
      schedule()
    },
    disconnected() {
      streamed = false
      failures = 0
      schedule()
    },
    setVisible(next: boolean) {
      if (visible === next) return
      visible = next
      if (!next) streamed = false
      epoch++
      cancelTimer()
      abort?.abort()
      if (visible) {
        failures = 0
        void refresh()
      }
    },
    close() {
      stopped = true
      epoch++
      cancelTimer()
      abort?.abort()
    },
    refresh,
  }
  void refresh()
  return api
}

/** Per-App catalog cache: on-demand, single-flight, short TTL, explicit flow invalidation. */
export function createAuthorizationCatalog(load: () => Promise<Record<string, unknown>>, now = Date.now) {
  let value: Record<string, unknown> | null = null
  let at = 0
  let pending: Promise<Record<string, unknown>> | null = null
  let revision = 0
  const cache = {
    invalidate() {
      revision++
      value = null
    },
    get(): Promise<Record<string, unknown>> {
      if (value && now() - at < 30_000) return Promise.resolve(value)
      if (pending) return pending
      const generation = revision
      const job: Promise<Record<string, unknown>> = load()
        .then(next => {
          if (generation !== revision) {
            pending = null
            return cache.get()
          }
          if (generation === revision) {
            value = next
            at = now()
          }
          return next
        })
        .finally(() => {
          if (pending === job) pending = null
        })
      pending = job
      return job
    },
  }
  return cache
}
