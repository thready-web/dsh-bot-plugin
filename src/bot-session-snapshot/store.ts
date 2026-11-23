import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { eventNdjson } from './canonical.ts'
import { conflict, corrupt, forbidden, notFound, unavailable, validation } from './errors.ts'
import { assertMainBotSession } from './select.ts'
import { packUstar } from './tar.ts'
import {
  EVENTS_FILE,
  MANIFEST_FILE,
  SNAPSHOT_FORMAT,
  SNAPSHOT_KIND,
  SNAPSHOT_MANIFEST_VERSION,
  SNAPSHOT_SCOPE,
  type BackupManifest,
  type LogEvent,
  type LogSource,
} from './types.ts'

export const SNAPSHOT_DIR_NAME = 'event-log-snapshots'
const SNAPSHOT_ID = /^els_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$/

export function sha256Hex(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function snapshotRoot(dataDir: string) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw unavailable('Snapshot storage is not configured.')
  }
  if (!isAbsolute(dataDir)) throw unavailable('Snapshot storage must be an absolute directory.')
  return join(dataDir, SNAPSHOT_DIR_NAME)
}

export function newSnapshotId(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `els_${stamp}_${randomBytes(4).toString('hex')}`
}

export function assertSnapshotId(snapshotId: unknown): string {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) {
    throw validation('snapshotId is not a valid identifier.')
  }
  return snapshotId
}

function ensureRoot(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return realpathSync(root)
}

function contained(rootReal: string, ...segments: string[]) {
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\0') || segment.includes(sep)) {
      throw forbidden('path segment rejected')
    }
  }
  const full = join(rootReal, ...segments)
  const rel = relative(rootReal, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw forbidden('path escapes the snapshot root')
  return full
}

function writeAtomicFile(path: string, bytes: Buffer) {
  const tmp = `${path}.partial`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const dirFd = openSync(dirname(path), 'r')
  try {
    renameSync(tmp, path)
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

export function validateEventRange(events: readonly LogEvent[], throughSeq: number) {
  if (!Number.isInteger(throughSeq) || throughSeq < -1) {
    throw validation('throughSeq must be an integer >= -1.')
  }
  if (events.length === 0) {
    if (throughSeq !== -1) throw conflict('The pinned cutoff does not match an empty event log.')
    return
  }
  let expected = 0
  for (const event of events) {
    if (!event || typeof event.type !== 'string' || !Number.isInteger(event.seq) || !Number.isFinite(event.time)) {
      throw conflict('An event is missing type, seq, or time and cannot be snapshotted.')
    }
    if (event.seq !== expected) {
      throw conflict(
        `Event log is not a contiguous seq range starting at 0 (expected ${expected}, found ${event.seq}).`,
      )
    }
    expected += 1
  }
  const last = events[events.length - 1]!.seq
  if (last !== throughSeq) {
    throw conflict('The pinned cutoff does not match the last recorded event.')
  }
}

function parseManifest(text: string): BackupManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw corrupt('Snapshot manifest is not valid JSON.')
  }
  if (!value || typeof value !== 'object') throw corrupt('Snapshot manifest is invalid.')
  const row = value as Record<string, unknown>
  if (
    row.version !== SNAPSHOT_MANIFEST_VERSION ||
    row.kind !== SNAPSHOT_KIND ||
    row.scope !== SNAPSHOT_SCOPE ||
    row.format !== SNAPSHOT_FORMAT ||
    typeof row.snapshotId !== 'string' ||
    typeof row.sourceSessionId !== 'string' ||
    typeof row.createdAt !== 'string' ||
    typeof row.afterSeq !== 'number' ||
    typeof row.throughSeq !== 'number' ||
    typeof row.count !== 'number' ||
    typeof row.bytes !== 'number' ||
    typeof row.sha256 !== 'string'
  ) {
    throw corrupt('Snapshot manifest is missing required fields.')
  }
  assertSnapshotId(row.snapshotId)
  return row as unknown as BackupManifest
}

export function readPublishedSnapshot(root: string, snapshotId: string): { manifest: BackupManifest; events: Buffer } {
  const id = assertSnapshotId(snapshotId)
  const rootReal = existsSync(root) ? realpathSync(root) : root
  const dir = contained(rootReal, id)
  const manifestPath = contained(rootReal, id, MANIFEST_FILE)
  const eventsPath = contained(rootReal, id, EVENTS_FILE)
  if (!existsSync(dir) || !existsSync(manifestPath) || !existsSync(eventsPath)) {
    throw notFound('Snapshot not found.')
  }
  const events = readFileSync(eventsPath)
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
  if (manifest.snapshotId !== id) throw corrupt('Snapshot id does not match its directory.')
  if (manifest.bytes !== events.length || manifest.sha256 !== sha256Hex(events)) {
    throw corrupt('Snapshot event bytes do not match the manifest checksum.')
  }
  return { manifest, events }
}

export function listPublishedSnapshots(root: string, sessionId?: string): BackupManifest[] {
  if (!existsSync(root)) return []
  const rootReal = realpathSync(root)
  const out: BackupManifest[] = []
  for (const name of readdirSync(rootReal)) {
    if (name.startsWith('.tmp-') || !SNAPSHOT_ID.test(name)) continue
    try {
      const { manifest } = readPublishedSnapshot(rootReal, name)
      if (sessionId && manifest.sourceSessionId !== sessionId) continue
      out.push(manifest)
    } catch {
      // Incomplete or corrupt directories are not listed as published snapshots.
    }
  }
  out.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
  return out
}

export function archiveSnapshot(manifest: BackupManifest, events: Buffer) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1000) || Math.floor(Date.now() / 1000)
  return packUstar([
    { name: MANIFEST_FILE, body: manifestBytes, mtime },
    { name: EVENTS_FILE, body: events, mtime },
  ])
}

export interface SnapshotStore {
  create(sessionId: string): Promise<BackupManifest>
  list(sessionId: string): BackupManifest[]
  get(snapshotId: string): { manifest: BackupManifest; events: Buffer }
  archive(snapshotId: string): { manifest: BackupManifest; tar: Buffer }
}

export function createSnapshotStore(options: {
  dataDir: string
  source: LogSource
  isBot: (sessionId: string) => boolean
}): SnapshotStore {
  const root = snapshotRoot(options.dataDir)
  const locks = new Map<string, Promise<unknown>>()

  function withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const job = previous.then(work, work)
    const settled = job.then(
      () => undefined,
      () => undefined,
    )
    locks.set(sessionId, settled)
    return job
  }

  return {
    async create(sessionId) {
      const id = assertMainBotSession(sessionId, options.isBot)
      return withLock(id, async () => {
        const rootReal = ensureRoot(root)
        const { events, throughSeq } = await options.source.read(id, -1)
        validateEventRange(events, throughSeq)
        const { bytes } = eventNdjson(events)
        const snapshotId = newSnapshotId()
        const manifest: BackupManifest = {
          version: SNAPSHOT_MANIFEST_VERSION,
          kind: SNAPSHOT_KIND,
          scope: SNAPSHOT_SCOPE,
          format: SNAPSHOT_FORMAT,
          snapshotId,
          sourceSessionId: id,
          createdAt: new Date().toISOString(),
          afterSeq: -1,
          throughSeq,
          count: events.length,
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
        }
        const tmp = contained(rootReal, `.tmp-${snapshotId}-${process.pid}-${randomBytes(3).toString('hex')}`)
        mkdirSync(tmp, { recursive: true, mode: 0o700 })
        try {
          writeAtomicFile(join(tmp, EVENTS_FILE), bytes)
          writeAtomicFile(join(tmp, MANIFEST_FILE), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
          const finalDir = contained(rootReal, snapshotId)
          if (existsSync(finalDir)) throw conflict('A snapshot with this id already exists.')
          const dirFd = openSync(rootReal, 'r')
          try {
            renameSync(tmp, finalDir)
            fsyncSync(dirFd)
          } finally {
            closeSync(dirFd)
          }
        } catch (error) {
          rmSync(tmp, { recursive: true, force: true })
          throw error
        }
        return manifest
      })
    },
    list(sessionId) {
      const id = assertMainBotSession(sessionId, options.isBot)
      return listPublishedSnapshots(root, id)
    },
    get(snapshotId) {
      return readPublishedSnapshot(ensureRoot(root), snapshotId)
    },
    archive(snapshotId) {
      const published = readPublishedSnapshot(ensureRoot(root), snapshotId)
      return { manifest: published.manifest, tar: archiveSnapshot(published.manifest, published.events) }
    },
  }
}
