export interface CanvasLink {
  canvasId: string
  revision: number | null
  page: string | null
  anchor: string | null
}

const ID = 'cnv_[A-Za-z0-9_-]{16}'
const REV = '[1-9]\\d{0,8}'
const PAGE = '[A-Za-z0-9_-]+(?:\\/[A-Za-z0-9_-]+)*\\.html'
const ANCHOR = '[A-Za-z][A-Za-z0-9_-]{0,64}'
const LINK = new RegExp(`^canvas:(${ID})(?:@(${REV}))?(?:/(${PAGE}))?(?:#(${ANCHOR}))?$`)
const ROUTE = new RegExp(`^(${PAGE})(?:#(${ANCHOR}))?$`)

export function isCanvasPage(value: string): boolean {
  return new RegExp(`^${PAGE}$`).test(value)
}

export function isCanvasAnchor(value: string): boolean {
  return new RegExp(`^${ANCHOR}$`).test(value)
}

/**
 * Keep a canvas target. Other protocols stay with the caller's sanitizer,
 * because markdown would otherwise drop `canvas:` before the link is read.
 */
export function preserveCanvasUrl(value: string, fallback: (value: string) => string): string {
  return parseCanvasLink(value) ? value : fallback(value)
}

/** `canvas:cnv_…[@revision][/page.html][#anchor]` */
export function parseCanvasLink(href: string | undefined): CanvasLink | null {
  if (!href) return null
  const match = LINK.exec(href)
  if (!match) return null
  const revision = match[2] ? Number(match[2]) : null
  return {
    canvasId: match[1] ?? '',
    revision: revision != null && Number.isSafeInteger(revision) ? revision : null,
    page: match[3] ?? null,
    anchor: match[4] ?? null,
  }
}

/** A page the inspector asked to open, with an optional hash. */
export function splitCanvasRoute(value: string): { page: string; anchor: string | null } | null {
  const match = ROUTE.exec(value)
  if (!match?.[1]) return null
  return { page: match[1], anchor: match[2] ?? null }
}
