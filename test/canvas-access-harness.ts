import { INSPECTOR_PATH, CanvasMediaError, canvasMediaPath, readSameOriginBytes } from '../ui/src/canvas-access.ts'
import { buildCanvasSrcdoc } from '../ui/src/canvas-frame.ts'
import { applyCanvasRevision, emptyCanvasCache, type CanvasRevisionDocument } from '../ui/src/canvas-sync.ts'

interface Spec {
  token: string
  revision: number
  entry: string
  manifest: CanvasRevisionDocument['manifest']
}

async function load(spec: Spec): Promise<string> {
  const state = document.getElementById('state')
  const frame = document.querySelector('iframe')
  if (!state || !(frame instanceof HTMLIFrameElement)) return 'missing'
  const doc: CanvasRevisionDocument = {
    kind: 'snapshot',
    revision: spec.revision,
    baseRevision: null,
    entry: spec.entry,
    manifest: spec.manifest,
  }
  const applied = await applyCanvasRevision(emptyCanvasCache(), doc, async path => {
    const url = canvasMediaPath(spec.token, spec.revision, path)
    if (!url) throw new Error('refused')
    return readSameOriginBytes(url)
  })
  if (!applied.ok) {
    frame.removeAttribute('srcdoc')
    state.textContent = applied.reason === 'access' ? 'access' : 'rejected'
    return state.textContent
  }
  const inspector = new TextDecoder().decode(await readSameOriginBytes(INSPECTOR_PATH))
  const srcdoc = buildCanvasSrcdoc({
    files: applied.cache.files,
    page: spec.entry,
    nonce: 'abc123abc123abc123',
    parentOrigin: location.origin,
    inspectorSource: inspector,
    scriptNonce: 'nonce123nonce123nonce',
  })
  if (!srcdoc) {
    state.textContent = 'rejected'
    return 'rejected'
  }
  const shown = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }))
  frame.srcdoc = srcdoc
  await shown
  state.textContent = 'shown'
  return 'shown'
}

async function foreign(): Promise<string> {
  const state = document.getElementById('state')
  if (!state) return 'missing'
  try {
    await readSameOriginBytes('https://evil.example/steal')
    state.textContent = 'fetched'
  } catch (error) {
    state.textContent = error instanceof CanvasMediaError ? 'refused' : 'other'
  }
  return state.textContent
}

Object.assign(globalThis, { preview: { load, foreign } })
