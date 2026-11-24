/**
 * Request routing for the DSH Bot PWA shell.
 *
 * This file is a classic script on purpose: `ui/pwa/build-shell.mjs` inlines its
 * source into the generated `sw.js`, and the unit tests execute it for the
 * `globalThis.DshBotPwa` side effect. Keep it free of `import` / `export`, and keep
 * it dependency-free so the service worker can run it without a bundler.
 *
 * `classify()` decides what may ever enter Cache Storage. Anything that is not
 * `shell` or `asset` is left to the network, and the service worker never writes a
 * network response. That is the fail-closed rule from docs/pwa-instant-start.md.
 */
;(function (root) {
  'use strict'

  /** The workbench document. Hash routing keeps every deep link inside it. */
  const SHELL_URL = '/dsh-bot/'
  /** Same document, served directly. Cache entries use this key. */
  const SHELL_INDEX = '/dsh-bot/index.html'
  const SHELL_CACHE_PREFIX = 'dsh-bot-shell-'
  const SHELL_META_CACHE = 'dsh-bot-shell-meta'

  /**
   * Same-origin requests that must never be stored, served stale, or delayed:
   * user data, capability URLs, live streams, and the shell's own update files.
   */
  const NEVER_CACHE = [
    /^\/dsh-bot\/api(?:\/|$)/,
    /^\/api(?:\/|$)/,
    /^\/dsh-bot\/canvas-media(?:\/|$)/,
    /^\/dsh-bot\/canvas-inspect(?:\/|$)/,
    /^\/dsh-bot\/canvas-view(?:\/|$)/,
    /^\/dsh-bot\/canvas-inspector\.js$/,
    /^\/dsh-bot\/sw\.js$/,
    /^\/dsh-bot\/manifest\.webmanifest$/,
    /^\/dsh-bot\/release\.json$/,
  ]

  /** Versioned, user-free files that the install step precaches. */
  const SHELL_ASSET = [/^\/dsh-bot\/assets\/[^/]+$/, /^\/dsh-bot\/icons\/[^/]+$/, /^\/dsh-bot\/favicon\.svg$/]

  function readAccept(request) {
    if (request && typeof request.accept === 'string') return request.accept
    if (request && request.headers && typeof request.headers.get === 'function') {
      return request.headers.get('accept') || ''
    }
    return ''
  }

  function defaultOrigin() {
    return root.location && root.location.origin ? root.location.origin : ''
  }

  function toUrl(value, base) {
    if (typeof value === 'object' && value instanceof URL) return value
    const raw = typeof value === 'string' ? value : ''
    if (raw === '') return null
    try {
      return new URL(raw, base || defaultOrigin() || 'http://127.0.0.1')
    } catch {
      return null
    }
  }

  /**
   * @param {{url?: string, method?: string, mode?: string, accept?: string,
   *   headers?: {get(name: string): string | null}}} [request]
   * @returns {'shell' | 'asset' | 'bypass' | 'network'}
   */
  function classify(request) {
    const input = request || {}
    const method = String(input.method || 'GET').toUpperCase()
    if (method !== 'GET') return 'bypass'

    const origin = typeof input.origin === 'string' ? input.origin : defaultOrigin()
    const url = toUrl(input.url, origin)
    if (!url) return 'bypass'

    if (origin !== '' && url.origin !== origin) return 'bypass'

    if (readAccept(input).includes('text/event-stream')) return 'bypass'

    const path = url.pathname
    for (const pattern of NEVER_CACHE) {
      if (pattern.test(path)) return 'bypass'
    }

    if (path === SHELL_URL || path === SHELL_INDEX) return 'shell'

    for (const pattern of SHELL_ASSET) {
      if (pattern.test(path)) return 'asset'
    }

    return 'network'
  }

  /**
   * What a document navigation should do with the network answer.
   *
   * This worker knows nothing about sessions, Access, or sign-in pages, and it must
   * not: a gateway, a bridge, or the future in-harness auth decides what an
   * unauthenticated request looks like. The only rule here is document hygiene, and
   * it holds for any of them:
   *
   * - the network did not answer → the cached shell may stand in;
   * - the network answered with a redirect → hand that redirect to the browser, so
   *   whatever owns authentication can run natively;
   * - anything else → return it unchanged, including a `200` interstitial page.
   *
   * @param {{redirected?: boolean} | null} probe null when the request did not complete
   * @returns {'cache' | 'handoff' | 'network'}
   */
  function navigationAction(probe) {
    if (!probe) return 'cache'
    if (probe.redirected === true) return 'handoff'
    return 'network'
  }

  root.DshBotPwa = {
    classify,
    navigationAction,
    SHELL_URL,
    SHELL_INDEX,
    SHELL_CACHE_PREFIX,
    SHELL_META_CACHE,
    NEVER_CACHE,
    SHELL_ASSET,
  }
})(typeof self !== 'undefined' ? self : globalThis)
