/**
 * Static-file policy for the workbench shell under `/dsh-bot/`.
 *
 * The service worker owns instant start, so the HTTP layer keeps the document
 * `no-store` and only lets content-hashed files be long-lived. The worker, the
 * manifest, and the release manifest must always be revalidated, otherwise an
 * installed app could keep an old shell past a deployment or a kill-switch.
 * See docs/pwa-instant-start.md §4.3.
 */
import { extname } from 'node:path'

export const DESK_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
])

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * `sw.js`, the manifest, and `release.json` are how an installed app notices a new
 * shell. They get a revalidating cache policy, never the hashed-asset one.
 */
export function deskCacheControl(rel: string): string {
  const name = rel.split('/').pop() ?? rel
  const extension = extname(name).toLowerCase()
  if (extension === '.html') return 'no-store'
  if (name === 'sw.js' || name === 'release.json' || extension === '.webmanifest') return 'no-cache'
  return IMMUTABLE
}

export function deskContentType(rel: string): string {
  return DESK_TYPES.get(extname(rel).toLowerCase()) ?? 'application/octet-stream'
}

/** Response headers for one file from the built workbench. */
export function deskHeaders(rel: string, pwaEnabled = true): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': deskContentType(rel),
    'cache-control': deskCacheControl(rel),
    'x-content-type-options': 'nosniff',
  }
  if ((rel.split('/').pop() ?? rel) === 'sw.js' && pwaEnabled) headers['service-worker-allowed'] = '/dsh-bot/'
  return headers
}

/** `DSH_BOT_PWA=0` removes the worker script so clients stop registering it. */
export function deskPwaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DSH_BOT_PWA ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/** Files that must disappear (404) while the kill-switch is on. */
export function deskPwaFileBlocked(rel: string, pwaEnabled: boolean): boolean {
  if (pwaEnabled) return false
  const name = rel.split('/').pop() ?? rel
  return name === 'sw.js' || name === 'manifest.webmanifest' || name === 'release.json'
}
