import { CHUNK_CAP } from './constants.ts'
import { openLogDb, type OpenLogDbResult } from './idb.ts'
import type { LogEvent } from './types.ts'

export interface CheckpointStore {
  readonly mode: 'idb' | 'memory'
  getCursor(sessionId: string): Promise<{ appliedSeq: number; headSeq: number | null } | null>
  setCursor(sessionId: string, appliedSeq: number, headSeq: number | null): Promise<void>
  putEvents(sessionId: string, events: readonly LogEvent[]): Promise<void>
  readEvents(sessionId: string, afterSeq?: number): Promise<LogEvent[]>
  getChunk(hash: string): Promise<Uint8Array | null>
  putChunk(hash: string, bytes: Uint8Array): Promise<void>
}

export function createMemoryCheckpoint(): CheckpointStore {
  const cursors = new Map<string, { appliedSeq: number; headSeq: number | null }>()
  const events = new Map<string, Map<number, LogEvent>>()
  const chunks = new Map<string, { bytes: Uint8Array; lastUsed: number }>()
  let used = 0
  const evict = () => {
    const order = [...chunks.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    while (used > CHUNK_CAP && order.length > 0) {
      const entry = order.shift()
      if (!entry) break
      chunks.delete(entry[0])
      used -= entry[1].bytes.byteLength
    }
  }
  return {
    mode: 'memory',
    async getCursor(sessionId) {
      return cursors.get(sessionId) ?? null
    },
    async setCursor(sessionId, appliedSeq, headSeq) {
      const previous = cursors.get(sessionId)
      const nextApplied = previous ? Math.max(previous.appliedSeq, appliedSeq) : appliedSeq
      const nextHead = headSeq == null ? (previous?.headSeq ?? null) : Math.max(previous?.headSeq ?? headSeq, headSeq)
      cursors.set(sessionId, { appliedSeq: nextApplied, headSeq: nextHead })
    },
    async putEvents(sessionId, batch) {
      const rows = events.get(sessionId) ?? new Map<number, LogEvent>()
      for (const event of batch) rows.set(event.seq, event)
      events.set(sessionId, rows)
    },
    async readEvents(sessionId, afterSeq = -1) {
      const rows = events.get(sessionId)
      if (!rows) return []
      return [...rows.values()].filter(event => event.seq > afterSeq).sort((left, right) => left.seq - right.seq)
    },
    async getChunk(hash) {
      const row = chunks.get(hash)
      if (!row) return null
      row.lastUsed = Date.now()
      return row.bytes
    },
    async putChunk(hash, bytes) {
      const previous = chunks.get(hash)
      if (previous) used -= previous.bytes.byteLength
      chunks.set(hash, { bytes, lastUsed: Date.now() })
      used += bytes.byteLength
      evict()
    },
  }
}

export async function createIdbCheckpoint(factory?: IDBFactory): Promise<CheckpointStore> {
  const opened = await openLogDbSafe(factory)
  if (opened.ok !== true) return createMemoryCheckpoint()
  const db = opened.db
  return {
    mode: 'idb',
    async getCursor(sessionId) {
      return withStore(db, 'log_cursors', 'readonly', store =>
        requestOf<CursorRow | undefined>(store.get(sessionId)),
      ).then(row => (row ? { appliedSeq: row.appliedSeq, headSeq: row.headSeq ?? null } : null))
    },
    async setCursor(sessionId, appliedSeq, headSeq) {
      await withStore(db, 'log_cursors', 'readwrite', async store => {
        const previous = await requestOf<CursorRow | undefined>(store.get(sessionId))
        const nextApplied = previous ? Math.max(previous.appliedSeq, appliedSeq) : appliedSeq
        const nextHead = headSeq == null ? (previous?.headSeq ?? null) : Math.max(previous?.headSeq ?? headSeq, headSeq)
        await requestOf(store.put({ sessionId, appliedSeq: nextApplied, headSeq: nextHead, updatedAt: Date.now() }))
      })
    },
    async putEvents(sessionId, batch) {
      await withStore(db, 'log_events', 'readwrite', async store => {
        for (const event of batch) {
          await requestOf(store.put({ sessionId, seq: event.seq, event }))
        }
      })
    },
    async readEvents(sessionId, afterSeq = -1) {
      const rows = await withStore(db, 'log_events', 'readonly', store => {
        const index = store.index('bySession')
        return requestOf<Array<{ sessionId: string; seq: number; event: LogEvent }>>(index.getAll(sessionId))
      })
      return rows
        .map(row => row.event)
        .filter(event => event && event.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq)
    },
    async getChunk(hash) {
      const row = await withStore(db, 'log_chunks', 'readonly', store =>
        requestOf<ChunkRow | undefined>(store.get(hash)),
      )
      if (!row?.bytes) return null
      void withStore(db, 'log_chunks', 'readwrite', store =>
        requestOf(store.put({ ...row, lastUsed: Date.now() }, hash)),
      )
      return row.bytes
    },
    async putChunk(hash, bytes) {
      await withStore(db, 'log_chunks', 'readwrite', async store => {
        await requestOf(store.put({ bytes, lastUsed: Date.now() }, hash))
        await evictChunks(store)
      })
    },
  }
}

type CursorRow = { sessionId: string; appliedSeq: number; headSeq: number | null; updatedAt: number }
type ChunkRow = { bytes: Uint8Array; lastUsed: number }

async function evictChunks(store: IDBObjectStore) {
  const index = store.index('byLastUsed')
  const all = await requestOf<ChunkRow[]>(index.getAll())
  const keys = await requestOf<IDBValidKey[]>(index.getAllKeys())
  let used = all.reduce((sum, row) => sum + (row.bytes?.byteLength ?? 0), 0)
  for (let i = 0; i < all.length && used > CHUNK_CAP; i += 1) {
    const key = keys[i]
    const row = all[i]
    if (key == null || !row) continue
    used -= row.bytes.byteLength
    await requestOf(store.delete(key))
  }
}

/** Drop one session's cached events and cursor. Chunks stay until the size cap evicts them. */
export async function forgetLogCache(sessionIds: readonly string[], factory?: IDBFactory) {
  const opened = await openLogDbSafe(factory)
  if (opened.ok !== true) return
  const db = opened.db
  try {
    await withStore(db, 'log_events', 'readwrite', async store => {
      const index = store.index('bySession')
      for (const sessionId of sessionIds) {
        const rows = await requestOf<Array<{ sessionId: string; seq: number }>>(index.getAll(sessionId))
        for (const row of rows) {
          if (!row || row.sessionId !== sessionId) continue
          await requestOf(store.delete([row.sessionId, row.seq]))
        }
      }
    })
    await withStore(db, 'log_cursors', 'readwrite', async store => {
      for (const sessionId of sessionIds) await requestOf(store.delete(sessionId))
    })
  } finally {
    db.close()
  }
}

function openLogDbSafe(factory?: IDBFactory): Promise<OpenLogDbResult> {
  try {
    return openLogDb(factory)
  } catch {
    return Promise.resolve({ ok: false, reason: 'unavailable' })
  }
}

function withStore<T>(
  db: IDBDatabase,
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
) {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode)
    const store = tx.objectStore(name)
    Promise.resolve(run(store)).then(resolve, reject)
    tx.onerror = () => reject(tx.error)
  })
}

function requestOf<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
