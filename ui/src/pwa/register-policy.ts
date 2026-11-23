/**
 * Small, pure registration decisions, kept apart from the service worker wiring so
 * they can be tested without a browser.
 */

/**
 * `?pwa=0` is the documented emergency switch (docs/pwa-instant-start.md §8.3).
 * It must also work on a page that is currently controlled by a worker.
 */
export function pwaDisabledByQuery(search: string): boolean {
  const value = new URLSearchParams(search).get('pwa')
  return value === '0' || value === 'off' || value === 'false'
}
