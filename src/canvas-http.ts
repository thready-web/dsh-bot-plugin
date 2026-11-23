import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { composeInspect, composeView } from './canvas-compose.ts'
import { asStoreFailure, toolError, type ToolPayload } from './errors.ts'
import { CANVAS_MAX_JSON_BYTES, normalizeCanvasPath, type CanvasFileInput, type CanvasStore } from './canvas-store.ts'

const API = '/session-foundations/api/canvas'
const MEDIA = '/dsh-bot/canvas-media/'
const INSPECT = '/dsh-bot/canvas-inspect/'
const VIEW = '/dsh-bot/canvas-view/'
const INSPECTOR = '/dsh-bot/canvas-inspector.js'
const CANVAS_ID = /^cnv_[A-Za-z0-9_-]{16}$/

/**
 * Manual and test publish routes. They require the existing login gate.
 * Model tools do not call them. Media routes are dispatched before that gate
 * and accept only the capability token.
 */
export async function handleCanvasApi(
  req: IncomingMessage,
  path: string,
  url: URL,
  canvas: CanvasStore,
): Promise<{ status: number; body: ToolPayload }> {
  try {
    const method = req.method ?? 'GET'
    if (method === 'POST' && path === API) {
      const body = await readBody(req)
      return outcome(
        canvas.create({ sessionId: body.sessionId, title: body.title, ticketId: body.ticketId, createdBy: 'user' }),
      )
    }
    if (method === 'GET' && path === API) return outcome(canvas.list(url.searchParams.get('sessionId') ?? ''))
    const parts = path.slice(API.length + 1).split('/')
    const id = parts[0] ?? ''
    if (!CANVAS_ID.test(id)) return { status: 404, body: toolError('NOT_FOUND', 'No such canvas.') }
    if (method === 'GET' && parts.length === 1) return outcome(canvas.get(id))
    if (method === 'GET' && parts[1] === 'revisions' && parts.length === 3) {
      const revision = Number(parts[2])
      if (!/^[1-9]\d{0,8}$/.test(parts[2] ?? ''))
        return { status: 404, body: toolError('NOT_FOUND', 'No such revision.') }
      return outcome(canvas.manifest(id, revision))
    }
    if (method !== 'POST' || parts.length !== 2)
      return { status: 404, body: toolError('NOT_FOUND', 'No such canvas route.') }
    const body = await readBody(req)
    if (parts[1] === 'snapshot' || parts[1] === 'delta') {
      const files = decodeFiles(body.files)
      if (!Array.isArray(files)) return { status: 400, body: files }
      return outcome(
        await canvas.publish({
          canvasId: id,
          kind: parts[1],
          baseRevision: typeof body.baseRevision === 'number' ? body.baseRevision : null,
          entry: typeof body.entry === 'string' ? body.entry : '',
          expectedFence: typeof body.expectedFence === 'number' ? body.expectedFence : -1,
          files,
        }),
      )
    }
    if (parts[1] === 'token') {
      const revision = typeof body.revision === 'number' ? body.revision : null
      const minRevision = typeof body.minRevision === 'number' ? body.minRevision : revision
      const maxRevision = typeof body.maxRevision === 'number' ? body.maxRevision : revision
      if (minRevision == null || maxRevision == null)
        return { status: 400, body: toolError('VALIDATION', 'revision is required.') }
      return outcome(canvas.mint({ canvasId: id, minRevision, maxRevision }))
    }
    if (parts[1] === 'adopt')
      return outcome(
        await canvas.adopt({ canvasId: id, revision: typeof body.revision === 'number' ? body.revision : 0 }),
      )
    if (parts[1] === 'revoke')
      return outcome(canvas.revoke({ canvasId: id, tokenId: typeof body.tokenId === 'string' ? body.tokenId : '' }))
    if (parts[1] === 'fail') {
      return outcome(
        await canvas.fail({
          canvasId: id,
          expectedFence: typeof body.expectedFence === 'number' ? body.expectedFence : -1,
          message: typeof body.message === 'string' ? body.message : '',
        }),
      )
    }
    return { status: 404, body: toolError('NOT_FOUND', 'No such canvas route.') }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'VALIDATION')
      return {
        status: 400,
        body: toolError('VALIDATION', error instanceof Error ? error.message : 'invalid canvas request'),
      }
    return { status: 500, body: asStoreFailure(error) }
  }
}

/**
 * Token-only media. A login cookie or Authorization header does not grant access.
 * @param {string} requestUrl raw request target, before URL normalization
 */
export function serveCanvasMedia(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: string,
  canvas: CanvasStore | null,
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, toolError('VALIDATION', 'canvas media is read-only.'))
    return
  }
  const parsed = parseCanvasMedia(requestUrl)
  if (!parsed) {
    json(res, 400, toolError('VALIDATION', 'canvas media path is not allowed.'))
    return
  }
  if (!canvas) {
    json(res, 404, toolError('NOT_FOUND', 'No such canvas file.'))
    return
  }
  const found = canvas.readMedia(parsed)
  if (found.ok === false) {
    json(res, found.code === 'NOT_FOUND' ? 404 : found.code === 'VALIDATION' ? 400 : 401, found)
    return
  }
  const origin = requestOrigin(req)
  if (origin === '') {
    json(res, 400, toolError('VALIDATION', 'canvas media needs a host.'))
    return
  }
  const headers: Record<string, string> = {
    'content-type':
      found.type === 'text/html' || found.type === 'text/css' ? `${found.type}; charset=utf-8` : found.type,
    'content-length': String(found.bytes.length),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': mediaPolicy(found.type, origin, parsed),
  }
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : found.bytes)
}

/** Raw media target. Dot segments and any percent-encoding are rejected before resolution. */
export function parseCanvasMedia(requestUrl: string): { token: string; revision: number; path: string } | null {
  const pathname = (requestUrl.split('?')[0] ?? '').replace(/\/+$/, '')
  if (!pathname.startsWith(MEDIA)) return null
  if (pathname.includes('\\') || pathname.includes('%') || pathname.includes('\0')) return null
  if (pathname.split('/').includes('..') || pathname.split('/').includes('.')) return null
  const parts = pathname.slice(MEDIA.length).split('/')
  if (parts.length < 3) return null
  const [token, revision, ...rest] = parts
  if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null
  if (!revision || !/^[1-9]\d{0,8}$/.test(revision)) return null
  const path = normalizeCanvasPath(rest.join('/'))
  if (!path) return null
  return { token, revision: Number(revision), path }
}

function mediaPolicy(type: string, origin: string, parsed: { token: string; revision: number }) {
  const sandbox = "sandbox; base-uri 'none'; form-action 'none'"
  if (type !== 'text/html') return `default-src 'none'; ${sandbox}`
  const prefix = `${origin}${MEDIA}${parsed.token}/${parsed.revision}/`
  // A design draft usually keeps CSS in a <style> block. External sheets still have to come from this prefix.
  return [
    "default-src 'none'",
    `img-src ${prefix}`,
    `style-src ${prefix} 'unsafe-inline'`,
    `font-src ${prefix}`,
    `frame-ancestors ${origin}`,
    sandbox,
  ].join('; ')
}

function requestOrigin(req: IncomingMessage) {
  const host = header(req, 'host')
  if (!host || /[\s/\\]/.test(host)) return ''
  const forwarded = header(req, 'x-forwarded-proto')
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : 'http'
  return `${proto}://${host}`
}

function header(req: IncomingMessage, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function outcome(result: ToolPayload): { status: number; body: ToolPayload } {
  if (result.ok !== false) return { status: 200, body: result }
  const status =
    result.code === 'NOT_FOUND' ? 404 : result.code === 'CAS_CONFLICT' ? 409 : result.code === 'FORBIDDEN' ? 401 : 400
  return { status, body: result }
}

function decodeFiles(value: unknown): CanvasFileInput[] | ToolPayload {
  if (!Array.isArray(value)) return toolError('VALIDATION', 'files are required.')
  const files: CanvasFileInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return toolError('VALIDATION', 'files are required.')
    const record = item as { path?: unknown; type?: unknown; body?: unknown }
    if (typeof record.path !== 'string' || typeof record.type !== 'string' || typeof record.body !== 'string')
      return toolError('VALIDATION', 'each file needs path, type, and body.')
    if (record.body.length > CANVAS_MAX_JSON_BYTES) return toolError('VALIDATION', 'A canvas file is too large.')
    const bytes = decodeBase64(record.body)
    if (!bytes) return toolError('VALIDATION', `body for ${record.path} is not base64.`)
    files.push({ path: record.path, type: record.type, bytes })
  }
  return files
}

function decodeBase64(value: string) {
  if (value.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  const canonical = bytes.toString('base64').replace(/=+$/u, '')
  if (canonical !== value.replace(/=+$/u, '')) return null
  return bytes
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let failed = false
    const fail = (error: Error) => {
      if (failed) return
      failed = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > CANVAS_MAX_JSON_BYTES) {
        fail(Object.assign(new Error('Canvas package is too large.'), { code: 'VALIDATION' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = text === '' ? {} : JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          fail(Object.assign(new Error('canvas body must be an object.'), { code: 'VALIDATION' }))
        else resolve(parsed as Record<string, unknown>)
      } catch (error) {
        fail(Object.assign(new Error('invalid json'), { code: 'VALIDATION', cause: error }))
      }
    })
    req.on('error', fail)
  })
}

function json(res: ServerResponse, status: number, body: ToolPayload) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

const NONCE = /^[A-Za-z0-9_-]{16,80}$/
let inspectorCode: string | null = null

/** Token-only inspect document. The design stays scriptless; only the host inspector runs. */
export async function serveCanvasInspect(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: string,
  canvas: CanvasStore | null,
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, toolError('VALIDATION', 'canvas inspect is read-only.'))
    return
  }
  const path = (requestUrl.split('?')[0] ?? '').replace(/\/+$/, '')
  if (path === INSPECTOR) {
    try {
      const code = inspectorSource()
      writeBody(res, req.method, 200, 'text/javascript; charset=utf-8', code, "default-src 'none'")
    } catch (error) {
      json(res, 500, toolError('STORE_FAILURE', error instanceof Error ? error.message : 'inspector failed'))
    }
    return
  }
  const parsed = parseCanvasInspect(requestUrl)
  if (!parsed) {
    json(res, 400, toolError('VALIDATION', 'canvas inspect path is not allowed.'))
    return
  }
  const nonce = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('nonce')
  if (!nonce || !NONCE.test(nonce)) {
    json(res, 400, toolError('VALIDATION', 'canvas inspect nonce is required.'))
    return
  }
  if (!canvas) {
    json(res, 404, toolError('NOT_FOUND', 'No such canvas file.'))
    return
  }
  const found = canvas.readMedia({ token: parsed.token, revision: parsed.revision, path: parsed.path })
  if (found.ok === false) {
    json(res, found.code === 'NOT_FOUND' ? 404 : found.code === 'VALIDATION' ? 400 : 401, found)
    return
  }
  if (found.type !== 'text/html') {
    json(res, 404, toolError('NOT_FOUND', 'No such canvas file.'))
    return
  }
  const origin = requestOrigin(req)
  if (origin === '') {
    json(res, 400, toolError('VALIDATION', 'canvas inspect needs a host.'))
    return
  }
  const prefix = `${origin}${MEDIA}${parsed.token}/${parsed.revision}/`
  const html = composeInspect(found.bytes.toString('utf8'), {
    baseHref: prefix,
    nonce,
    parentOrigin: origin,
    inspectorSrc: INSPECTOR,
    page: parsed.path,
  })
  writeBody(res, req.method, 200, 'text/html; charset=utf-8', html, inspectPolicy(origin, prefix))
}

/**
 * Standalone tab for one revision. The design is composed without the inspector,
 * sandboxed without scripts, and refused inside a frame. Token only, like media.
 */
export async function serveCanvasView(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: string,
  canvas: CanvasStore | null,
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, toolError('VALIDATION', 'canvas view is read-only.'))
    return
  }
  const parsed = parseCanvasDocument(requestUrl, VIEW)
  if (!parsed) {
    json(res, 400, toolError('VALIDATION', 'canvas view path is not allowed.'))
    return
  }
  if (!canvas) {
    json(res, 404, toolError('NOT_FOUND', 'No such canvas file.'))
    return
  }
  const found = canvas.readMedia(parsed)
  if (found.ok === false) {
    json(res, found.code === 'NOT_FOUND' ? 404 : found.code === 'VALIDATION' ? 400 : 401, found)
    return
  }
  if (found.type !== 'text/html') {
    json(res, 404, toolError('NOT_FOUND', 'No such canvas file.'))
    return
  }
  const origin = requestOrigin(req)
  if (origin === '') {
    json(res, 400, toolError('VALIDATION', 'canvas view needs a host.'))
    return
  }
  const title = canvas.canvasRow(found.canvasId)?.title ?? ''
  const prefix = `${origin}${MEDIA}${parsed.token}/${parsed.revision}/`
  const html = composeView(found.bytes.toString('utf8'), {
    baseHref: prefix,
    title: title === '' ? `Canvas · v${parsed.revision}` : `${title} · v${parsed.revision}`,
  })
  writeBody(res, req.method, 200, 'text/html; charset=utf-8', html, viewPolicy(prefix))
}

export function parseCanvasInspect(requestUrl: string): { token: string; revision: number; path: string } | null {
  return parseCanvasDocument(requestUrl, INSPECT)
}

export function parseCanvasView(requestUrl: string): { token: string; revision: number; path: string } | null {
  return parseCanvasDocument(requestUrl, VIEW)
}

function parseCanvasDocument(
  requestUrl: string,
  prefix: string,
): { token: string; revision: number; path: string } | null {
  const pathname = (requestUrl.split('?')[0] ?? '').replace(/\/+$/, '')
  if (!pathname.startsWith(prefix)) return null
  if (pathname.includes('\\') || pathname.includes('%') || pathname.includes('\0')) return null
  if (pathname.split('/').includes('..') || pathname.split('/').includes('.')) return null
  const parts = pathname.slice(prefix.length).split('/')
  if (parts.length < 2) return null
  const [token, revision, ...rest] = parts
  if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null
  if (!revision || !/^[1-9]\d{0,8}$/.test(revision)) return null
  const path = normalizeCanvasPath(rest.length === 0 ? 'index.html' : rest.join('/'))
  if (!path || !path.endsWith('.html')) return null
  return { token, revision: Number(revision), path }
}

function inspectPolicy(origin: string, prefix: string) {
  return [
    "default-src 'none'",
    `img-src ${prefix}`,
    `style-src ${prefix} 'unsafe-inline'`,
    `font-src ${prefix}`,
    `script-src ${origin}${INSPECTOR}`,
    `base-uri ${prefix}`,
    `frame-ancestors ${origin}`,
    "form-action 'none'",
    'sandbox allow-scripts',
  ].join('; ')
}

function viewPolicy(prefix: string) {
  return [
    "default-src 'none'",
    `base-uri ${prefix}`,
    `img-src ${prefix}`,
    `style-src ${prefix} 'unsafe-inline'`,
    `font-src ${prefix}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    'sandbox',
  ].join('; ')
}

function writeBody(res: ServerResponse, method: string, status: number, type: string, body: string, policy: string) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': policy,
  })
  res.end(method === 'HEAD' ? undefined : body)
}

function inspectorSource() {
  if (inspectorCode != null) return inspectorCode
  // dist/canvas-http.js reads the sibling bundle. Tests import src/ and use the same built file.
  const candidates = [
    new URL('./canvas-inspector.js', import.meta.url),
    new URL('../dist/canvas-inspector.js', import.meta.url),
  ]
  for (const url of candidates) {
    if (!existsSync(url)) continue
    inspectorCode = readFileSync(url, 'utf8')
    if (inspectorCode === '') throw new Error('inspector bundle was empty')
    return inspectorCode
  }
  throw new Error('canvas inspector bundle is missing; run npm run build')
}
