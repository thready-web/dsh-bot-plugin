/**
 * Same-origin reads for canvas bytes. Cloudflare Access sits in front of the
 * origin, so a credential-less fetch is redirected at the login page. These
 * reads send cookies only to a fixed same-origin path. The capability token
 * is still required by the server. Callers must not pass through a URL that
 * came from the preview document.
 */

export const INSPECTOR_PATH = '/dsh-bot/canvas-inspector.js'

const MEDIA_PREFIX = '/dsh-bot/canvas-media/'

export class CanvasAccessError extends Error {
  readonly code = 'ACCESS_EXPIRED'
  constructor() {
    super('Cloudflare Access redirected this canvas request.')
  }
}

export class CanvasMediaError extends Error {
  readonly code = 'MEDIA'
  constructor(message = 'canvas media failed') {
    super(message)
  }
}

export function normalizeClientPath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return null
  if (input.includes('\0') || input.includes('\\') || input.includes('%') || input.includes('..')) return null
  if (input.startsWith('/') || input.startsWith('.')) return null
  const parts = input.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.startsWith('.') || part.length > 120))
    return null
  if (
    parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part.replace(/\.[A-Za-z0-9]+$/, '')) || !/^[A-Za-z0-9_.-]+$/.test(part))
  )
    return null
  return parts.join('/')
}

export function canvasMediaPath(token: string, revision: number, filePath: string): string | null {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null
  if (!Number.isInteger(revision) || revision < 1 || revision > 999_999_999) return null
  const path = normalizeClientPath(filePath)
  if (!path) return null
  return `${MEDIA_PREFIX}${token}/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** True only for the inspector script or one capability-media path. */
export function isTrustedCanvasUrl(url: string): boolean {
  if (url === INSPECTOR_PATH) return true
  if (
    !url.startsWith(MEDIA_PREFIX) ||
    url.includes('..') ||
    url.includes('\\') ||
    url.includes('%') ||
    url.includes('?')
  )
    return false
  const rest = url.slice(MEDIA_PREFIX.length).split('/')
  if (rest.length < 3) return false
  const [token, revision, ...parts] = rest
  if (!token || !revision || !/^[1-9]\d{0,8}$/.test(revision)) return false
  return canvasMediaPath(token, Number(revision), parts.join('/')) === url
}

export function looksLikeAccessLogin(bytes: Uint8Array, contentType: string): boolean {
  if (!contentType.toLowerCase().includes('text/html') && !contentType.toLowerCase().includes('text/plain'))
    return false
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).toLowerCase()
  return head.includes('cdn-cgi/access/login') || head.includes('cloudflareaccess.com')
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Read one trusted path. A redirect is an Access challenge: the body is not
 * canvas content and is not followed, so cookies are not sent to the login host.
 */
export async function readSameOriginBytes(url: string, fetchImpl: FetchLike = fetch): Promise<Uint8Array> {
  if (!isTrustedCanvasUrl(url)) throw new CanvasMediaError('refused')
  const response = await fetchImpl(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    referrerPolicy: 'no-referrer',
  })
  if (
    response.type === 'opaqueredirect' ||
    response.status === 301 ||
    response.status === 302 ||
    response.status === 303 ||
    response.status === 307 ||
    response.status === 308
  ) {
    throw new CanvasAccessError()
  }
  if (!response.ok) throw new CanvasMediaError(`status ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  const path = url.slice(url.lastIndexOf('/') + 1)
  if (!path.endsWith('.html') && !path.endsWith('.htm') && contentType.toLowerCase().includes('text/html')) {
    throw new CanvasAccessError()
  }
  if (looksLikeAccessLogin(bytes, contentType || 'text/html')) throw new CanvasAccessError()
  return bytes
}
