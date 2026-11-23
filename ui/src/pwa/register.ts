/**
 * Client half of the PWA shell.
 *
 * Registration never blocks the first paint. The worker installs and precaches in
 * the background, and a new version is offered to the page instead of replacing the
 * running scripts: the page calls `applyPwaUpdate()` only after the user agrees.
 *
 * The shell itself never carries user data. Whether a signed-in user may read local
 * chat content, and how that content is partitioned, stays a separate identity gate
 * (docs/pwa-instant-start.md §5 and §7).
 */
import { pwaDisabledByQuery } from './register-policy.ts'

const SW_URL = '/dsh-bot/sw.js'
const SCOPE = '/dsh-bot/'
const UPDATE_EVENT = 'dsh-bot:pwa-update'
const SHELL_CACHE_PREFIX = 'dsh-bot-shell-'
const UPDATE_INTERVAL_MS = 10 * 60 * 1000

let registration: ServiceWorkerRegistration | null = null
let applying = false
let checking = false
let checkedAt = 0
let started = false

/** Call once at boot. Safe when service workers are missing or the build is a dev server. */
export function registerPwa(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  if (pwaDisabledByQuery(window.location.search)) {
    void teardown('?pwa=0')
    return
  }
  if (!import.meta.env.PROD || started) return
  started = true
  if (document.readyState === 'complete') void start()
  else window.addEventListener('load', () => void start(), { once: true })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
  window.addEventListener('online', () => void checkForUpdate())
}

/** Ask the waiting worker to take over; the page reloads once it controls us. */
export function applyPwaUpdate(): void {
  const waiting = registration?.waiting
  if (!waiting) {
    window.location.reload()
    return
  }
  applying = true
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

/** Current shell release id, or '' before the worker controls this page. */
export function shellRelease(): Promise<string> {
  const worker = navigator.serviceWorker.controller
  if (!worker) return Promise.resolve('')
  return new Promise(resolvePromise => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => resolvePromise(''), 1000)
    channel.port1.onmessage = (event: MessageEvent) => {
      window.clearTimeout(timer)
      const data = event.data as { type?: string; releaseId?: unknown } | null
      resolvePromise(data?.type === 'DSH_BOT_PWA_RELEASE' && typeof data.releaseId === 'string' ? data.releaseId : '')
    }
    worker.postMessage({ type: 'GET_RELEASE' }, [channel.port2])
  })
}

async function start(): Promise<void> {
  try {
    registration = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE, updateViaCache: 'none' })
  } catch (error) {
    // A 404 means the server switched the shell off; anything else is a transient
    // load problem and must leave the installed worker alone.
    const status = await headStatus(SW_URL)
    if (status === 404 || status === 410) await teardown(`service worker ${status}`)
    else console.warn('[dsh-bot] service worker registration failed', error)
    return
  }
  watch(registration)
  if (registration.waiting && navigator.serviceWorker.controller) announceUpdate()
}

function watch(current: ServiceWorkerRegistration): void {
  current.addEventListener('updatefound', () => {
    const installing = current.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) announceUpdate()
    })
  })
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applying) return
    applying = false
    window.location.reload()
  })
}

function announceUpdate(): void {
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT))
}

async function checkForUpdate(): Promise<void> {
  if (!registration || checking) return
  const now = Date.now()
  if (now - checkedAt < UPDATE_INTERVAL_MS) return
  checking = true
  checkedAt = now
  try {
    await registration.update()
  } catch {
    /* Keep the shell that is already on screen. */
  } finally {
    checking = false
  }
}

async function headStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    return response.status
  } catch {
    return 0
  }
}

/** Kill-switch: stop controlling, and drop the shell buckets the worker would serve. */
async function teardown(reason: string): Promise<void> {
  try {
    for (const item of await navigator.serviceWorker.getRegistrations()) {
      if (item.scope.endsWith(SCOPE)) await item.unregister()
    }
  } catch {
    /* unavailable registrations behave like none */
  }
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(SHELL_CACHE_PREFIX)) await caches.delete(name)
    }
  } catch {
    /* Cache Storage may be unavailable in private mode */
  }
  console.info(`[dsh-bot] PWA shell off: ${reason}`)
}
