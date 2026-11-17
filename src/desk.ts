/** Workbench routes inside the DSH process. The browser calls /dsh-bot/api. */

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { openLedger, validIdempotencyKey } from './desk-ledger.ts'
import { openSessionPreviews } from './session-previews.ts'
import { purgeSessionFiles, sessionDirectory, writeBotMarker } from './session-files.ts'
import {
  MAX_UPLOAD_BYTES,
  listDirectory,
  openDownload,
  readFileText,
  resolveFileRoots,
  saveUploadFile,
  type FileError,
} from './workspace-files.ts'

export interface RpcEnvelope {
  result?: { ok?: boolean; value?: any; error?: { message?: string; code?: string } }
}

/** The request fields the desk actually reads. Node's IncomingMessage satisfies this. */
export type DeskRequest = {
  headers: import('node:http').IncomingHttpHeaders | Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: any[]) => void): unknown
  destroy(error?: Error): void
  socket?: { remoteAddress?: string; localPort?: number; localAddress?: string }
  method?: string
  url?: string
}

/**
 * Working directory for workbench-created sessions. THREADY_SESSION_CWD wins;
 * otherwise <DSH_HOME>/workspace, so the model does not start inside DSH_HOME
 * (owner-token, profiles/, persona.sqlite). Empty only when neither is set,
 * which keeps DSH's own default (the server process cwd).
 * @param {Record<string, string | undefined>} env
 * @param {{ mkdir?: boolean }} [options]
 */
export function defaultSessionCwd(env: Record<string, string | undefined>, options: { mkdir?: boolean } = {}) {
  const explicit = (env.THREADY_SESSION_CWD ?? '').trim()
  const home = (env.DSH_HOME ?? '').trim()
  const cwd = explicit !== '' ? resolve(explicit) : home !== '' ? join(resolve(home), 'workspace') : ''
  if (cwd !== '' && options.mkdir !== false) {
    try {
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
    } catch {
      /* session/create reports a bad cwd */
    }
  }
  return cwd
}

const API = '/session-foundations/api'
const PREVIEW_SESSION = /^(?:session|worker)-[A-Za-z0-9-]+$/
const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie/i

/**
 * @param {object} options
 * @param {string} options.ledgerFile
 * @param {string} options.profileDir
 * @param {string} [options.sessionsRoot] JSONL persistence root. Defaults to <profileDir>/sessions.
 * @param {string} [options.stateRoot] Directory that holds storages/. Defaults to profileDir.
 * @param {string} options.sessionCwd
 * @param {(sessionId: string) => boolean} options.isBot
 * @param {(sessionId: string) => { kind?: string } | null | undefined} options.mark
 * @param {(sessionId: string) => void | Promise<void>} options.hold
 * @param {(sessionId: string) => void | Promise<void>} options.release
 * @param {(sessionId: string) => void | Promise<void>} [options.releaseLoaded]
 * @param {(sessionId: string) => void | Promise<void>} [options.releaseAttached]
 * @param {(sessionId: string) => boolean} [options.stillAttached]
 * @param {(endpoint: string, args: Record<string, unknown>, req: DeskRequest) => Promise<{ status: number, body: RpcEnvelope }>} options.rpc
 * @param {(req: DeskRequest) => Promise<Record<string, unknown>>} options.usage
 * @param {{ home: string, dshHome: string }} [options.files] Browser roots. Defaults to the process home and DSH_HOME.
 */
export function createDesk(options: {
  ledgerFile: string
  profileDir: string
  sessionsRoot?: string
  stateRoot?: string
  sessionCwd: string
  isBot: (sessionId: string) => boolean
  mark: (sessionId: string) => { kind?: string } | null | undefined
  hold: (sessionId: string) => void | Promise<void>
  release: (sessionId: string) => void | Promise<void>
  releaseLoaded?: (sessionId: string) => void | Promise<void>
  releaseAttached?: (sessionId: string) => void | Promise<void>
  stillAttached?: (sessionId: string) => boolean
  rpc: (
    endpoint: string,
    args: Record<string, unknown>,
    req: DeskRequest,
  ) => Promise<{ status: number; body: RpcEnvelope }>
  usage: (req: DeskRequest) => Promise<Record<string, unknown>>
  files?: { home: string; dshHome: string }
}) {
  const ledger = openLedger(options.ledgerFile)
  const sessionPreviews = openSessionPreviews(join(dirname(options.ledgerFile), 'session-previews.json'))
  /** @type {Map<string, Promise<void>>} */
  const promptLocks: Map<string, Promise<void>> = new Map()
  const sessionsRoot =
    options.sessionsRoot !== undefined && options.sessionsRoot !== ''
      ? options.sessionsRoot
      : join(options.profileDir, 'sessions')
  const stateRoot = options.stateRoot !== undefined && options.stateRoot !== '' ? options.stateRoot : options.profileDir

  return {
    /**
     * @param {string} method
     * @param {string} path
     */
    owns(method: string, path: string) {
      const sub = subpath(path)
      if (sub === null) return false
      if (
        method === 'GET' &&
        (sub === '/health' ||
          sub === '/sessions' ||
          sub === '/tasks' ||
          sub === '/usage' ||
          sub === '/file' ||
          sub === '/files' ||
          sub === '/files/roots' ||
          sub === '/files/text')
      )
        return true
      if (method === 'POST' && (sub === '/sessions' || sub === '/sessions/previews' || sub === '/tasks')) return true
      if (method === 'POST' && /^\/sessions\/session-[A-Za-z0-9-]+\/(?:archive|purge|delete)$/.test(sub)) return true
      if (method === 'POST' && /^\/tasks\/[0-9a-f-]{36}\/cancel$/.test(sub)) return true
      return false
    },
    /**
     * @param {string} method
     * @param {string} path
     * @param {URL} url
     * @param {DeskRequest} req
     */
    async handle(method: string, path: string, url: URL, req: DeskRequest) {
      const sub = subpath(path) ?? ''
      const body = method === 'POST' ? await readJson(req) : {}
      if (method === 'GET' && sub === '/health') return { status: 200, body: await health(req) }
      if (method === 'GET' && sub === '/sessions') {
        const result = await options.rpc('session/list', { _request: {} }, req)
        return { status: result.status, body: attachPreviews(result.body) }
      }
      if (method === 'POST' && sub === '/sessions/previews') return savePreviews(body)
      if (method === 'POST' && sub === '/sessions') return createSession(req, body)
      const archive = sub.match(/^\/sessions\/(session-[A-Za-z0-9-]+)\/archive$/)
      if (method === 'POST' && archive) return archiveBlank(req, archive[1])
      const purge = sub.match(/^\/sessions\/(session-[A-Za-z0-9-]+)\/purge$/)
      if (method === 'POST' && purge) return purgeBlank(req, purge[1])
      const remove = sub.match(/^\/sessions\/(session-[A-Za-z0-9-]+)\/delete$/)
      if (method === 'POST' && remove) return deleteSession(req, remove[1])
      if (method === 'GET' && sub === '/tasks') return { status: 200, body: { items: ledger.tasks() } }
      if (method === 'POST' && sub === '/tasks') return createTask(req, body)
      const cancel = sub.match(/^\/tasks\/([0-9a-f-]{36})\/cancel$/)
      if (method === 'POST' && cancel) return cancelTask(req, cancel[1])
      if (method === 'GET' && sub === '/usage') return { status: 200, body: redactSecrets(await options.usage(req)) }
      if (method === 'GET' && sub === '/file') return filePreview(req, url)
      if (method === 'GET' && sub === '/files/roots') return fileRoots(req, url.searchParams.get('sessionId') ?? '')
      if (method === 'GET' && sub === '/files')
        return fileList(req, url.searchParams.get('sessionId') ?? '', url.searchParams.get('path') ?? '')
      if (method === 'GET' && sub === '/files/text')
        return fileText(req, url.searchParams.get('sessionId') ?? '', url.searchParams.get('path') ?? '')
      return { status: 404, body: { error: 'not_found' } }
    },
    openDownload(req: DeskRequest, url: URL) {
      return downloadFile(req, url.searchParams.get('sessionId') ?? '', url.searchParams.get('path') ?? '')
    },
    saveUpload(req: DeskRequest, url: URL) {
      return uploadFile(
        req,
        url.searchParams.get('sessionId') ?? '',
        url.searchParams.get('dir') ?? '',
        url.searchParams.get('name') ?? '',
        url.searchParams.get('overwrite') === '1',
      )
    },
  }

  /**
   * @param {DeskRequest} req
   */
  async function health(req: DeskRequest) {
    const execution = await executionState(req)
    return {
      primary: { reachable: execution.reachable },
      execution: { ready: execution.ready, reason: execution.reason },
    }
  }

  /**
   * @param {DeskRequest} req
   */
  async function executionState(req: DeskRequest) {
    const catalog = await options.rpc('session/modelCatalog', {}, req)
    const value = catalog.body?.result?.value
    const routable = Array.isArray(value?.routableProviders) ? value.routableProviders : []
    if (catalog.body?.result?.ok === true && routable.length > 0) return { ready: true, reason: '', reachable: true }
    const failure = catalog.body?.result?.error?.message
    return {
      ready: false,
      reason: catalog.body?.result?.ok === true ? 'no_provider' : failure ? String(failure) : 'catalog_unreadable',
      reachable: catalog.status > 0 && catalog.status < 500,
    }
  }

  /**
   * @param {DeskRequest} req
   * @param {Record<string, unknown>} body
   */
  async function createSession(req: DeskRequest, body: Record<string, unknown>) {
    const key = idempotencyOf(req, body)
    if (!validIdempotencyKey(key)) return { status: 400, body: { error: 'idempotency_key_required' } }
    const existing = ledger.session(key)
    if (existing) return { status: 200, body: { sessionId: existing.sessionId, reused: true } }
    const listed = await options.rpc('session/list', { _request: {} }, req)
    const known =
      listed.body?.result?.ok === true && Array.isArray(listed.body.result.value?.items)
        ? listed.body.result.value.items
        : []
    const reusable =
      options.sessionCwd === ''
        ? undefined
        : known.find(
            (item: any) =>
              item?.blank === true &&
              item?.running !== true &&
              item?.cwd === options.sessionCwd &&
              typeof item.sessionId === 'string',
          )
    const request =
      options.sessionCwd === ''
        ? {}
        : reusable
          ? { cwd: options.sessionCwd, sessionId: reusable.sessionId }
          : { cwd: options.sessionCwd }
    const created = await options.rpc('session/create', { request }, req)
    const sessionId = created.body?.result?.value?.sessionId
    if (created.body?.result?.ok !== true || typeof sessionId !== 'string') {
      return { status: 502, body: { error: 'session_create_failed', upstream: created.body?.result?.error ?? null } }
    }
    const marked = options.mark(sessionId)
    if (!marked || marked.kind !== 'bot') {
      return { status: 502, body: { error: 'bot_mark_failed', sessionId, upstream: marked ?? null } }
    }
    let marker = ''
    if (options.sessionCwd !== '') {
      try {
        marker = writeBotMarker({
          sessionsRoot,
          cwd: options.sessionCwd,
          sessionId,
          name: typeof body.name === 'string' ? body.name : '',
        })
      } catch {
        return { status: 502, body: { error: 'bot_marker_failed', sessionId } }
      }
    }
    ledger.rememberSession(key, sessionId)
    return {
      status: 201,
      body: { sessionId, kind: 'bot', marker, reused: Boolean(reusable) && sessionId === reusable.sessionId },
    }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function archiveBlank(req: DeskRequest, sessionId: string) {
    const listed = await options.rpc('session/list', { _request: {} }, req)
    const items = listed.body?.result?.value?.items
    if (listed.body?.result?.ok !== true || !Array.isArray(items)) {
      return { status: 502, body: { error: 'session_list_failed', upstream: listed.body?.result?.error ?? null } }
    }
    const item = items.find(entry => entry?.sessionId === sessionId)
    if (!item) return { status: 404, body: { error: 'session_not_found' } }
    if (item.blank !== true || item.running === true) return { status: 409, body: { error: 'not_blank' } }
    const archived = await options.rpc('workspace/archiveSession', { request: { sessionId } }, req)
    const archivedSessionIds = archived.body?.result?.value?.archivedSessionIds
    if (archived.body?.result?.ok !== true || !Array.isArray(archivedSessionIds)) {
      return { status: 502, body: { error: 'archive_failed', upstream: archived.body?.result?.error ?? null } }
    }
    return { status: 200, body: { sessionId, archivedSessionIds } }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function purgeBlank(req: DeskRequest, sessionId: string) {
    const found = await findListedSession(req, sessionId)
    if (found.error) return found.error
    const item = found.item
    if (item.blank !== true || item.running === true || typeof item.cwd !== 'string' || item.cwd === '') {
      return { status: 409, body: { error: 'not_blank' } }
    }
    const erased = await eraseSession(sessionId, item.cwd)
    if (erased) return erased
    return { status: 200, body: { sessionId, purged: true } }
  }

  /**
   * Hard-delete any listed session, including one that already has messages.
   * An idle session still open in this process is detached first, then its log
   * is removed. A running turn is refused so its writer cannot recreate the log.
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function deleteSession(req: DeskRequest, sessionId: string) {
    const found = await findListedSession(req, sessionId)
    if (found.error) return found.error
    const item = found.item
    if (item.running === true) return { status: 409, body: { error: 'running' } }
    if (typeof item.cwd !== 'string' || item.cwd === '') return { status: 409, body: { error: 'no_cwd' } }
    try {
      await options.releaseLoaded?.(sessionId)
      if (options.stillAttached?.(sessionId) === true) await options.releaseAttached?.(sessionId)
    } catch (error) {
      return {
        status: 500,
        body: { error: 'delete_failed', message: error instanceof Error ? error.message : 'delete failed' },
      }
    }
    if (options.stillAttached?.(sessionId) === true) return { status: 409, body: { error: 'attached' } }
    const erased = await eraseSession(sessionId, item.cwd)
    if (erased) return erased
    return { status: 200, body: { sessionId, deleted: true } }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function findListedSession(req: DeskRequest, sessionId: string) {
    const listed = await options.rpc('session/list', { _request: {} }, req)
    const items = listed.body?.result?.value?.items
    if (listed.body?.result?.ok !== true || !Array.isArray(items)) {
      return {
        error: {
          status: 502,
          body: { error: 'session_list_failed', upstream: listed.body?.result?.error ?? null },
        } as { status: number; body: Record<string, unknown> },
      }
    }
    const item = items.find(entry => entry?.sessionId === sessionId)
    if (!item) return { error: { status: 404, body: { error: 'session_not_found' } } }
    return { item, error: undefined }
  }

  /**
   * @param {string} sessionId
   * @param {string} cwd
   */
  async function eraseSession(sessionId: string, cwd: string) {
    try {
      purgeSessionFiles({
        sessionsRoot,
        cacheFile: join(stateRoot, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`),
        workspaceFile: join(stateRoot, 'storages', 'workspace.json'),
        sessionId,
        cwd,
      })
    } catch (error) {
      return {
        status: 500,
        body: { error: 'purge_failed', message: error instanceof Error ? error.message : 'purge failed' },
      }
    }
    sessionPreviews.forget(sessionId)
    return null
  }

  /**
   * @param {unknown} body
   */
  function attachPreviews(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    return { ...body, previews: sessionPreviews.all() }
  }

  /**
   * @param {Record<string, unknown>} body
   */
  function savePreviews(body: Record<string, unknown>) {
    if (body.previews && typeof body.previews === 'object' && !Array.isArray(body.previews)) {
      sessionPreviews.rememberAll(body.previews)
      return { status: 200, body: { ok: true, previews: sessionPreviews.all() } }
    }
    const saved = sessionPreviews.remember(body.sessionId, body.preview)
    if (!saved.ok) return { status: 400, body: { error: saved.error } }
    return { status: 200, body: { ok: true, preview: saved.preview } }
  }

  /**
   * @param {DeskRequest} req
   * @param {Record<string, unknown>} body
   */
  async function createTask(req: DeskRequest, body: Record<string, unknown>) {
    const key = idempotencyOf(req, body)
    if (!validIdempotencyKey(key)) return { status: 400, body: { error: 'idempotency_key_required' } }
    const text = typeof body.text === 'string' ? body.text : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (text.trim() === '' || text.length > 8000 || !/^session-[A-Za-z0-9-]+$/.test(sessionId)) {
      return { status: 400, body: { error: 'invalid_task' } }
    }
    const execution = await executionState(req)
    const remembered = ledger.rememberTask(key, {
      sessionId,
      status: execution.ready ? 'accepted' : 'blocked_unconfigured',
      reason: execution.ready ? '' : execution.reason,
    })
    if (!remembered.created) return { status: 200, body: { task: remembered.record, reused: true } }
    if (!execution.ready) {
      return {
        status: 409,
        body: {
          error: 'model_unconfigured',
          task: remembered.record,
          execution: { ready: false, reason: execution.reason },
        },
      }
    }
    const delivered = await withPromptLock(sessionId, () => deliverPrompt(req, sessionId, text, remembered.record.id))
    if (!delivered.ok) {
      const updated = ledger.updateTask(remembered.record.id, {
        status: 'failed',
        reason: delivered.reason,
        upstreamCode: delivered.upstreamCode,
      })
      const failStatus = delivered.status
      return {
        status: typeof failStatus === 'number' ? failStatus : 502,
        body: { error: delivered.error, task: updated },
      }
    }
    return { status: 202, body: { task: remembered.record, reused: false, interrupted: delivered.interrupted } }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} id
   */
  async function cancelTask(req: DeskRequest, id: string) {
    const task = ledger.task(id)
    if (!task) return { status: 404, body: { error: 'not_found' } }
    if (task.status !== 'accepted') return { status: 409, body: { error: 'not_running', task } }
    const result = await options.rpc('session/cancel', { request: { sessionId: task.sessionId } }, req)
    const updated = ledger.updateTask(task.id, {
      status: result.body?.result?.ok === true ? 'cancelled' : 'failed',
      reason: result.body?.result?.ok === true ? '' : (result.body?.result?.error?.message ?? 'cancel failed'),
      upstreamCode: result.body?.result?.error?.code,
    })
    return { status: result.body?.result?.ok === true ? 200 : 502, body: { task: updated } }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function fileRoots(req: DeskRequest, sessionId: string) {
    const ready = await browserAccess(req, sessionId)
    if ('error' in ready) return fileFailure(ready.error)
    return { status: 200, body: ready.access.roots }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @param {string} filePath
   */
  async function fileList(req: DeskRequest, sessionId: string, filePath: string) {
    const ready = await browserAccess(req, sessionId)
    if ('error' in ready) return fileFailure(ready.error)
    const listed = listDirectory(filePath, ready.access)
    if (!listed.ok) return fileFailure(listed.error)
    return { status: 200, body: listed.value }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @param {string} filePath
   */
  async function fileText(req: DeskRequest, sessionId: string, filePath: string) {
    const ready = await browserAccess(req, sessionId)
    if ('error' in ready) return fileFailure(ready.error)
    const text = readFileText(filePath, ready.access)
    if (!text.ok) return fileFailure(text.error)
    return { status: 200, body: text.value }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @param {string} filePath
   */
  async function downloadFile(req: DeskRequest, sessionId: string, filePath: string) {
    const ready = await browserAccess(req, sessionId)
    if ('error' in ready) return fileFailure(ready.error)
    const opened = openDownload(filePath, ready.access)
    if (!opened.ok) return fileFailure(opened.error)
    return { status: 200 as const, ...opened.value }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @param {string} dir
   * @param {string} name
   * @param {boolean} overwrite
   */
  async function uploadFile(req: DeskRequest, sessionId: string, dir: string, name: string, overwrite: boolean) {
    const declared = Number(headerValue(req, 'content-length'))
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fileFailure('too_large')
    if (!(req instanceof Readable)) return fileFailure('bad_path')
    const ready = await browserAccess(req, sessionId)
    if ('error' in ready) {
      req.resume()
      return fileFailure(ready.error)
    }
    const saved = await saveUploadFile(dir, name, req, ready.access, { overwrite, maxBytes: MAX_UPLOAD_BYTES })
    if (!saved.ok) {
      if (saved.error !== 'too_large') req.resume()
      return fileFailure(saved.error)
    }
    return { status: 201, body: saved.value }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   */
  async function browserAccess(req: DeskRequest, sessionId: string) {
    const cwd = await workspaceCwd(req, sessionId)
    if (typeof cwd !== 'string') return cwd
    const files = options.files ?? { home: homedir(), dshHome: process.env.DSH_HOME ?? '' }
    return { access: resolveFileRoots({ workspace: cwd, home: files.home, dshHome: files.dshHome }) }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @returns {Promise<string | { error: 'invalid_session' }>}
   */
  async function workspaceCwd(req: DeskRequest, sessionId: string): Promise<string | { error: 'invalid_session' }> {
    if (!PREVIEW_SESSION.test(sessionId)) return { error: 'invalid_session' }
    let cwd = options.sessionCwd
    try {
      const listed = await options.rpc('session/list', { _request: {} }, req)
      const items = listed.body?.result?.value?.items
      if (Array.isArray(items)) {
        const item = items.find(entry => entry?.sessionId === sessionId)
        if (typeof item?.cwd === 'string' && item.cwd !== '') cwd = item.cwd
      }
    } catch {
      /* the configured workspace remains */
    }
    return cwd
  }

  /**
   * @param {DeskRequest} req
   * @param {URL} url
   */
  async function filePreview(req: DeskRequest, url: URL) {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const filePath = workspaceRelativePath(url.searchParams.get('path') ?? '')
    if (!PREVIEW_SESSION.test(sessionId) || filePath === null) return { status: 400, body: { error: 'invalid_file' } }
    const result = await options.rpc(
      'workspaceFiles/read',
      {
        workspaceFileScopeId: sessionId,
        path: filePath,
        range: { offset: 1, limit: 2000 },
      },
      req,
    )
    const value = result.body?.result?.value
    if (result.body?.result?.ok !== true || !value || typeof value.text !== 'string') {
      const code = result.body?.result?.error?.code
      return {
        status: result.status === 401 ? 401 : 404,
        body: { error: 'file_unreadable', code: typeof code === 'string' ? code : 'workspace-file/not-found' },
      }
    }
    return {
      status: 200,
      body: {
        path: filePath,
        name: filePath.split('/').at(-1) ?? filePath,
        text: value.text,
        eof: value.eof === true,
        bytes: typeof value.bytes === 'number' ? value.bytes : null,
      },
    }
  }

  /**
   * @param {string} sessionId
   * @param {() => Promise<T>} fn
   * @template T
   */
  async function withPromptLock<T>(sessionId: string, fn: () => Promise<T>) {
    const previous = promptLocks.get(sessionId) ?? Promise.resolve()
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = () => resolve(undefined)
    })
    const tail = previous.then(() => gate)
    promptLocks.set(sessionId, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (promptLocks.get(sessionId) === tail) promptLocks.delete(sessionId)
    }
  }

  /**
   * @param {string} sessionId
   */
  function botMarked(sessionId: string) {
    if (options.sessionCwd === '') return false
    try {
      const file = join(sessionDirectory(sessionsRoot, options.sessionCwd, sessionId), 'bot.json')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed?.kind === 'bot' && parsed?.sessionId === sessionId
    } catch {
      return false
    }
  }

  /**
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @returns {Promise<boolean | null>}
   */
  async function sessionRunning(req: DeskRequest, sessionId: string): Promise<boolean | null> {
    const listed = await options.rpc('session/list', { _request: {} }, req)
    if (listed.body?.result?.ok !== true || !Array.isArray(listed.body.result.value?.items)) return null
    const item = listed.body.result.value.items.find((entry: any) => entry?.sessionId === sessionId)
    return item?.running === true
  }

  /**
   * Idle sessions queue. A live bot turn is cancelled, then the new text is a new turn.
   * The cancel is only the main session. Worker sessions are not addressed here.
   * @param {DeskRequest} req
   * @param {string} sessionId
   * @param {string} text
   * @param {string} requestId
   */
  async function deliverPrompt(req: DeskRequest, sessionId: string, text: string, requestId: string) {
    const running = await sessionRunning(req, sessionId)
    if (running === null) {
      return {
        ok: false,
        status: 502,
        error: 'session_unreadable',
        reason: 'Could not tell whether the session is still running.',
        upstreamCode: '',
      }
    }
    let interrupted = false
    if (running && (options.isBot(sessionId) || botMarked(sessionId))) {
      interrupted = true
      await options.hold(sessionId)
      const cancelled = await options.rpc('session/cancel', { request: { sessionId } }, req)
      if (cancelled.body?.result?.ok !== true) {
        await options.release(sessionId)
        return {
          ok: false,
          status: 502,
          error: 'cancel_failed',
          reason: cancelled.body?.result?.error?.message ?? 'cancel failed',
          upstreamCode: cancelled.body?.result?.error?.code ?? '',
        }
      }
      for (const task of ledger.tasks()) {
        if (task.sessionId === sessionId && task.status === 'accepted' && task.id !== requestId) {
          ledger.updateTask(task.id, { status: 'cancelled', reason: 'interrupted' })
        }
      }
    }
    const prompted = await options.rpc(
      'session/prompt',
      {
        request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      },
      req,
    )
    if (prompted.body?.result?.ok !== true) {
      if (interrupted) await options.release(sessionId)
      return {
        ok: false,
        status: 502,
        error: 'prompt_failed',
        reason: prompted.body?.result?.error?.message ?? 'prompt failed',
        upstreamCode: prompted.body?.result?.error?.code ?? '',
      }
    }
    return { ok: true, interrupted }
  }
}

/**
 * @param {string} path
 */
function subpath(path: string) {
  if (path === API) return '/'
  if (!path.startsWith(`${API}/`)) return null
  return path.slice(API.length)
}

/**
 * @param {DeskRequest} req
 * @param {Record<string, unknown>} body
 */
function idempotencyOf(req: DeskRequest, body: Record<string, unknown>) {
  const value = req.headers['idempotency-key']
  const header = typeof value === 'string' ? value : ''
  if (header !== '') return header
  return typeof body.idempotencyKey === 'string' ? body.idempotencyKey : ''
}

function fileFailure(error: FileError | 'invalid_session') {
  const status =
    error === 'denied'
      ? 403
      : error === 'missing'
        ? 404
        : error === 'binary'
          ? 415
          : error === 'too_large'
            ? 413
            : error === 'exists'
              ? 409
              : 400
  return { status, body: { error } }
}

/**
 * @param {DeskRequest} req
 * @param {string} name
 */
function headerValue(req: DeskRequest, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/**
 * Keep a preview path inside a session workspace: relative, no parent segments.
 * @param {string} value
 * @returns {string | null}
 */
function workspaceRelativePath(value: string): string | null {
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\\?#]/.test(value)) return null
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null
  const parts = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length === 0 ? null : parts.join('/')
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function redactSecrets(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue
      out[key] = redactSecrets(inner)
    }
    return out
  }
  return value
}

/**
 * @param {DeskRequest} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJson(req: DeskRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = []
    let size = 0
    req.on('data', (chunk: any) => {
      size += chunk.length
      if (size > 32_768) {
        reject(Object.assign(new Error('body too large'), { code: 'VALIDATION' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (error) {
        reject(Object.assign(error instanceof Error ? error : new Error('invalid json'), { code: 'VALIDATION' }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @typedef {object} RpcEnvelope
 * @property {{ ok?: boolean, value?: any, error?: { message?: string, code?: string } }} [result]
 */
