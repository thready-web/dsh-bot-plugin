/** Client rules for switching a canvas revision. A failed check keeps the previous cache. */

export interface CanvasManifestItem {
  path: string
  hash: string
  bytes: number
  type: string
}

export interface CanvasRevisionDocument {
  kind: 'snapshot' | 'delta'
  revision: number
  baseRevision: number | null
  entry: string
  manifest: CanvasManifestItem[]
}

export interface CanvasFileBytes {
  hash: string
  type: string
  bytes: Uint8Array
}

export interface CanvasCache {
  revision: number | null
  files: ReadonlyMap<string, CanvasFileBytes>
}

export function emptyCanvasCache(): CanvasCache {
  return { revision: null, files: new Map() }
}

export async function sha256Prefixed(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

/**
 * A snapshot, a missing base, or a revision gap always fetches the whole manifest.
 * A delta fetches only paths whose cached hash does not match.
 */
export function transferPlan(
  cache: CanvasCache,
  doc: CanvasRevisionDocument,
): { mode: 'snapshot' | 'delta'; paths: string[] } {
  const gap =
    doc.kind !== 'delta' ||
    cache.revision == null ||
    doc.baseRevision == null ||
    doc.baseRevision !== cache.revision ||
    doc.revision !== cache.revision + 1
  if (gap) return { mode: 'snapshot', paths: doc.manifest.map(item => item.path) }
  const paths = doc.manifest
    .filter(item => {
      const have = cache.files.get(item.path)
      return !have || have.hash !== item.hash || have.bytes.byteLength !== item.bytes
    })
    .map(item => item.path)
  return { mode: 'delta', paths }
}

export async function commitCanvasRevision(
  cache: CanvasCache,
  doc: CanvasRevisionDocument,
  fetched: ReadonlyMap<string, Uint8Array>,
): Promise<{ ok: true; cache: CanvasCache } | { ok: false; cache: CanvasCache; error: string }> {
  const next = new Map<string, CanvasFileBytes>()
  for (const item of doc.manifest) {
    const prior = cache.files.get(item.path)
    const bytes = fetched.get(item.path) ?? (prior && prior.hash === item.hash ? prior.bytes : undefined)
    if (!bytes) return { ok: false, cache, error: `missing ${item.path}` }
    if (bytes.byteLength !== item.bytes) return { ok: false, cache, error: `size ${item.path}` }
    const hash = await sha256Prefixed(bytes)
    if (hash !== item.hash) return { ok: false, cache, error: `hash ${item.path}` }
    next.set(item.path, { hash, type: item.type, bytes })
  }
  if (!next.has(doc.entry)) return { ok: false, cache, error: 'missing entry' }
  return { ok: true, cache: { revision: doc.revision, files: next } }
}

/**
 * Fetch every planned path before verifying. Any failure returns the previous cache unchanged.
 */
export async function applyCanvasRevision(
  cache: CanvasCache,
  doc: CanvasRevisionDocument,
  fetchBytes: (path: string) => Promise<Uint8Array>,
): Promise<{ ok: true; cache: CanvasCache } | { ok: false; cache: CanvasCache; error: string; reason?: 'access' }> {
  const plan = transferPlan(cache, doc)
  const fetched = new Map<string, Uint8Array>()
  try {
    for (const path of plan.paths) fetched.set(path, await fetchBytes(path))
  } catch (error) {
    const access = !!error && typeof error === 'object' && 'code' in error && error.code === 'ACCESS_EXPIRED'
    return {
      ok: false,
      cache,
      error: error instanceof Error ? error.message : 'fetch failed',
      ...(access ? { reason: 'access' as const } : {}),
    }
  }
  if (plan.mode === 'snapshot') {
    for (const item of doc.manifest) {
      if (!fetched.has(item.path)) return { ok: false, cache, error: `incomplete snapshot ${item.path}` }
    }
  }
  return commitCanvasRevision(cache, doc, fetched)
}

/** The frame URL changes only after the new revision verified. */
export function nextFrameSrc(current: string, result: { ok: true; src: string } | { ok: false }): string {
  return result.ok ? result.src : current
}
