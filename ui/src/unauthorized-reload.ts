/**
 * What to do when this app's own API answers `401`.
 *
 * `401` is plain HTTP: the request needs credentials. This module does **not** decide
 * how they are obtained, where the login lives, or which provider owns it — a gateway,
 * a Cloudflare Access bridge, or the host's own auth may all be behind it. It only asks
 * the browser for the document again, so whoever owns authentication can act on a real
 * navigation. The plugin never learns the login path.
 */
const KEY = 'dsh-bot.unauthorized-reload'
const WINDOW_MS = 10_000

/** Private modes can refuse storage; the guard still needs to work for this page. */
let memory = 0

function lastReload(storage: Storage): number {
  try {
    const value = Number(storage.getItem(KEY) || 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return memory
  }
}

function markReload(storage: Storage, now: number): void {
  memory = now
  try {
    storage.setItem(KEY, String(now))
  } catch {
    /* the in-memory mark still guards this page */
  }
}

/**
 * Reload the document at most once per window, so a failing login cannot loop.
 *
 * @returns true when a reload was started
 */
export function reloadForUnauthorized(location: Pick<Location, 'reload'>, storage: Storage, now = Date.now()): boolean {
  const last = lastReload(storage)
  // No earlier reload is not the same as one at time zero.
  if (last !== 0 && now - last < WINDOW_MS) return false
  markReload(storage, now)
  location.reload()
  return true
}

/** A successful answer means a later expiry may reload again straight away. */
export function forgetUnauthorized(storage: Storage): void {
  memory = 0
  try {
    storage.removeItem(KEY)
  } catch {
    /* ignored */
  }
}

/** `sessionStorage` throws in some private modes. */
export function reloadStorage(): Storage {
  try {
    return window.sessionStorage
  } catch {
    return {
      getItem: () => String(memory),
      setItem: (_key: string, value: string) => void (memory = Number(value) || 0),
      removeItem: () => void (memory = 0),
    } as unknown as Storage
  }
}
