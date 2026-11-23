import { SnapshotError } from './errors.ts'
import type { SnapshotStore } from './store.ts'

export const BACKUP_ROUTE_PREFIX = '/api/dsh-bot/backups'
export const BACKUP_COLLECTION_PATH = BACKUP_ROUTE_PREFIX
export const BACKUP_ITEM_PATH = `${BACKUP_ROUTE_PREFIX}/item`
export const BACKUP_EVENTS_PATH = `${BACKUP_ROUTE_PREFIX}/events`
export const BACKUP_ARCHIVE_PATH = `${BACKUP_ROUTE_PREFIX}/archive`

type FetchHandler = (request: Request) => Promise<Response>

export function backupFetchHandlers(store: SnapshotStore): Array<[string, string[], FetchHandler]> {
  return [
    [BACKUP_COLLECTION_PATH, ['GET', 'HEAD', 'POST'], request => handleCollection(store, request)],
    [BACKUP_ITEM_PATH, ['GET', 'HEAD'], request => handleItem(store, request)],
    [BACKUP_EVENTS_PATH, ['GET', 'HEAD'], request => handleEvents(store, request)],
    [BACKUP_ARCHIVE_PATH, ['GET', 'HEAD'], request => handleArchive(store, request)],
  ]
}

export function registerBackupRoutes(
  register: (route: { path: string; methods: readonly string[]; requestBody: string; fetch: FetchHandler }) => unknown,
  store: SnapshotStore,
  effect?: (execute: () => void | (() => void)) => void,
) {
  for (const [path, methods, handler] of backupFetchHandlers(store)) {
    const start = () => {
      const dispose = register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: handler,
      })
      return typeof dispose === 'function'
        ? () => {
            void dispose()
          }
        : undefined
    }
    if (effect) effect(start)
    else start()
  }
}

export async function dispatchBackupRequest(store: SnapshotStore, request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const hit = backupFetchHandlers(store).find(([route]) => route === path)
  if (!hit) return null
  const methods = hit[1]
  if (!methods.includes(request.method)) {
    return json(405, { ok: false, code: 'METHOD', message: 'Method not allowed.' })
  }
  return hit[2](request)
}

async function handleCollection(store: SnapshotStore, request: Request) {
  return wrap(request, async (url, body) => {
    if (request.method === 'POST') {
      const sessionId =
        (body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined) ??
        url.searchParams.get('sessionId')
      const manifest = await store.create(typeof sessionId === 'string' ? sessionId : '')
      return json(201, { ok: true, snapshot: manifest })
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const snapshots = store.list(sessionId)
    return json(200, { ok: true, snapshots })
  })
}

async function handleItem(store: SnapshotStore, request: Request) {
  return wrap(request, async url => {
    const snapshotId = url.searchParams.get('snapshotId') ?? ''
    const { manifest } = store.get(snapshotId)
    return json(200, { ok: true, snapshot: manifest })
  })
}

async function handleEvents(store: SnapshotStore, request: Request) {
  return wrap(request, async url => {
    const snapshotId = url.searchParams.get('snapshotId') ?? ''
    const { manifest, events } = store.get(snapshotId)
    const headers = {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-length': String(events.length),
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="${manifest.snapshotId}-events.ndjson"`,
      'x-checksum-sha256': manifest.sha256,
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const out = new Uint8Array(events.byteLength)
    out.set(events)
    return new Response(out, { status: 200, headers })
  })
}

async function handleArchive(store: SnapshotStore, request: Request) {
  return wrap(request, async url => {
    const snapshotId = url.searchParams.get('snapshotId') ?? ''
    const { manifest, tar } = store.archive(snapshotId)
    const headers = {
      'content-type': 'application/x-tar',
      'content-length': String(tar.length),
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="${manifest.snapshotId}.tar"`,
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const out = new Uint8Array(tar.byteLength)
    out.set(tar)
    return new Response(out, { status: 200, headers })
  })
}

async function wrap(request: Request, run: (url: URL, body: unknown) => Promise<Response>) {
  try {
    const url = new URL(request.url)
    const body = request.method === 'POST' ? await readJson(request) : null
    const response = await run(url, body)
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers })
    return response
  } catch (error) {
    if (error instanceof SnapshotError)
      return json(error.status, { ok: false, code: error.code, message: error.message })
    return json(500, {
      ok: false,
      code: 'UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function readJson(request: Request) {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new SnapshotError(400, 'VALIDATION', 'Request body must be JSON.')
  }
}

function json(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'private, no-store',
    },
  })
}
