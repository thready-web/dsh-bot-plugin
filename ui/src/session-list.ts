/**
 * Why the session list came back empty.
 *
 * The workbench can be served from the local PWA shell while its API calls are still
 * unauthenticated: Cloudflare Access (or any proxy) answers `/dsh-bot/api/sessions`
 * with a redirect to a sign-in page, `fetch` follows it, and the page arrives as
 * `200 text/html`. Parsing that as JSON yields `{}`, so the old code saw "200, no
 * result" and rendered an empty list with no explanation. Treat that case as a
 * sign-in problem instead of a silent empty state.
 */
export type SessionListFailure = 'none' | 'signin' | 'unavailable'

/**
 * @param status HTTP status of the list response; `0` means the request never completed
 * @param parsed whether the body carried our `{ result }` envelope
 */
export function classifySessionListFailure(status: number, parsed: boolean): SessionListFailure {
  if (status === 200 && parsed) return 'none'
  if (status === 401 || status === 403) return 'signin'
  // A 200 that is not our JSON is a sign-in page, a proxy error page, or a stale
  // document. None of them mean "this account has no sessions".
  if (status === 200) return 'signin'
  return 'unavailable'
}
