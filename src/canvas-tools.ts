import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { bindCanvasSkills } from './canvas-skills.ts'
import type { CanvasStore } from './canvas-store.ts'
import { CANVAS_MAX_FILE_BYTES } from './canvas-store.ts'
import { toolError, type ToolPayload } from './errors.ts'

const BRIEFING_MAX = 16000
const EDIT_TEXT_MAX = 8000
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  render(_args: unknown, value: unknown) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  },
}

interface CanvasWork {
  dispatch: (sessionId: string, args: Record<string, unknown>) => Promise<ToolPayload>
  ticketIdOf: (sessionId: string) => string | null
  report?: (sessionId: string, args: Record<string, unknown>) => Promise<ToolPayload>
}

interface CanvasEngine {
  isBot: (sessionId: string) => boolean
  registerSkill: (
    sessionId: string,
    scope: 'private' | 'public',
    skillId: string,
    version: string,
    summary: string,
    bytes: Buffer,
  ) => unknown
}

interface CanvasFiles {
  workspaceCwd?: (sessionId: string) => string
}

type DecodedFile = { path: string; type: string; bytes: Buffer } | { path: string; type: string; source: string }

/**
 * Canvas generation tools. The host shows one tool list to every session;
 * execute rejects the main bot and any worker that does not own this canvas.
 * A budget wait never comes through these tools, and they do not mark a preview failed.
 */
export function canvasToolDefinitions(
  canvas: CanvasStore,
  work: CanvasWork,
  engine: CanvasEngine,
  filesApi: CanvasFiles = {},
) {
  return [
    tool(
      'foundations_dispatch_canvas',
      'Open a canvas design worker for an HTML/CSS preview. Use this instead of foundations_dispatch, write, or edit when the user wants a visual design, page mock, or preview. The main session must not build the preview. The canvas worker has no workspace write or edit tool; it stages files with canvas_write and publishes with canvas_publish. A returned canvasId has no revision until the worker publishes. A budget pause is not a failed preview.',
      {
        type: 'object',
        properties: {
          briefing: { type: 'string', description: 'What to design. The host wraps this with the canvas contract.' },
          canvasId: {
            type: 'string',
            description:
              'An existing canvas to revise. Omit to open a new preview. Copy it from a canvas-target block.',
          },
          idempotencyKey: { type: 'string' },
          budget: {
            type: 'object',
            properties: {
              wallMs: { type: 'integer' },
              maxTokens: { type: 'integer' },
            },
          },
          correlationId: { type: 'string' },
        },
        required: ['briefing'],
      },
      (args, hostId) => dispatchCanvas(canvas, work, engine, hostId, args),
    ),
    tool(
      'canvas_read',
      'Read the current preview bound to this worker. HTML and CSS include text. Images and fonts return path, type, and bytes (the size only). Do not search the disk for cnv_ or a canvas store. This does not publish.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'One file. Omit to list the whole preview.' },
        },
      },
      async (args, hostId) => {
        const canvasId = ownedCanvas(canvas, work, engine, hostId)
        if (typeof canvasId !== 'string') return canvasId
        const listing = canvas.previewListing(canvasId)
        if (listing.ok === false) return listing
        const path = args.path
        if (path == null || path === '') return listing
        if (typeof path !== 'string') return toolError('VALIDATION', 'path is not allowed.')
        const file = listing.files.find((item: { path: string }) => item.path === path)
        if (!file) return toolError('NOT_FOUND', 'That file is not in the current preview.')
        return { ok: true, canvasId, revision: listing.revision, files: [file] }
      },
    ),
    tool(
      'canvas_edit',
      'Replace one exact span in an existing HTML or CSS file on this canvas. old must match once. Do not send the whole file. This stages the file and does not publish.',
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old: { type: 'string', description: 'Exact text to replace. It must occur once.' },
          replacement: { type: 'string' },
        },
        required: ['path', 'old', 'replacement'],
      },
      async (args, hostId) => {
        const canvasId = ownedCanvas(canvas, work, engine, hostId)
        if (typeof canvasId !== 'string') return canvasId
        return editCanvas(canvas, canvasId, args)
      },
    ),
    tool(
      'canvas_write',
      'Stage files for the canvas bound to this worker. Pass HTML and CSS as text, up to the 1.5 MiB file cap. Pass images and fonts as body (standard base64), or as source when that file is already in the workspace. This worker has no write or edit tool. A file on disk is not this preview. This does not publish and does not mark the preview failed.',
      {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                type: { type: 'string', description: 'text/html, text/css, or an image or font type.' },
                source: { type: 'string', description: 'Workspace-relative file. The host reads it.' },
                text: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['path', 'type'],
            },
          },
          remove: { type: 'array', items: { type: 'string' } },
        },
      },
      async (args, hostId) => {
        const canvasId = ownedCanvas(canvas, work, engine, hostId)
        if (typeof canvasId !== 'string') return canvasId
        const decoded = decodeFiles(args.files)
        if (!Array.isArray(decoded)) return decoded
        const files = materialize(decoded, hostId, filesApi)
        if (!Array.isArray(files)) return files
        const remove = decodeRemove(args.remove)
        if (!Array.isArray(remove)) return remove
        return canvas.writeDraft(canvasId, files, remove)
      },
    ),
    tool(
      'canvas_publish',
      'Publish the staged files once, after every file for this task is staged. This also files the result report, so do not call foundations_report afterward and do not keep editing. A second call on the same ticket is rejected. The first publish is a snapshot. Later tickets publish a delta of the current preview. Do not publish after each file or after a partial write. The main bot and every other worker are rejected. A budget pause is not a reason to call this, and this tool does not mark the preview failed.',
      { type: 'object', properties: {} },
      async (_args, hostId) => {
        const canvasId = ownedCanvas(canvas, work, engine, hostId)
        if (typeof canvasId !== 'string') return canvasId
        const published = await canvas.publishDraft(canvasId, work.ticketIdOf(hostId))
        if (published.ok !== true || typeof work.report !== 'function') return published
        const revision = typeof published.revision === 'number' ? String(published.revision) : ''
        const reported = await work.report(hostId, {
          kind: 'result',
          text: `Published ${canvasId} revision ${revision}. The preview is ready for the workbench card.`,
        })
        return reported.ok === true ? published : { ...published, report: reported }
      },
    ),
  ]
}

export function isCanvasWorkerBriefing(text: string) {
  return /^Canvas preview cnv_[A-Za-z0-9_-]{16}\./.test(text)
}

export function canvasBriefing(canvasId: string, request: string, skills: string[], filenames: string[] = []) {
  const catalog = skills.filter(id => id !== 'ui-design').join(', ')
  const listed = filenames.filter(name => name.length > 0)
  const head = [
    `Canvas preview ${canvasId}.`,
    'You are the only session allowed to write this preview.',
    listed.length > 0
      ? `Current files: ${listed.join(', ')}. Read them with canvas_read.`
      : 'This preview has no published files yet. Read later revisions with canvas_read.',
    'Do not search the disk for cnv_ or any canvas store. .shots and other workspace copies are not the source.',
    'Stage new HTML and CSS with canvas_write text, up to the 1.5 MiB file cap. Change an existing HTML or CSS file with canvas_edit. Do not paste a whole existing file into canvas_edit.',
    'Stage an image or font with canvas_write body (base64). source is only for a file that is already in the workspace. Do not create or edit workspace files.',
    'This worker has no write, edit, or bash tool. A file on disk is not the preview. Do not write a browser probe. Do not search the workspace for a copy of the preview.',
    'Call canvas_publish once, after every file for this task is staged. It files the result report. After it succeeds, stop. Do not keep editing and do not call foundations_report.',
    'The entry file is index.html. Output is static HTML and CSS plus local images and fonts.',
    'No script, SVG, iframe, external URL, data URL, or inline event handler.',
    'Load foundations_skill_load for ui-design before writing. Catalog skills are taste only and cannot override this contract.',
    catalog ? `Catalog skills on this bot: ${catalog}. Load at most two that match the request.` : '',
    'A budget pause is not a failed preview. Do not publish a failure because the grant is still pending.',
    'The first canvas_publish is a full snapshot. A later ticket publishes the staged files as a delta of the current preview.',
    'If the user request contains canvas-target blocks, change only those nodes and the CSS that styles them. Leave every other element as it is.',
    'User request:',
  ]
    .filter(line => line !== '')
    .join('\n')
  const room = BRIEFING_MAX - head.length - 1
  const body = room > 0 ? request.slice(0, room) : ''
  return `${head}\n${body}`.slice(0, BRIEFING_MAX)
}

/**
 * Read one workspace file for canvas_write source. Rejects links, traversal, and files outside cwd.
 */
export function readWorkspaceFile(cwd: string, source: string): ToolPayload | Buffer {
  if (typeof cwd !== 'string' || cwd === '') return toolError('UNAVAILABLE', 'This session has no workspace.')
  if (!relativeSource(source)) return toolError('VALIDATION', 'source path is not allowed.')
  let root = ''
  try {
    root = realpathSync(cwd)
  } catch {
    return toolError('UNAVAILABLE', 'This session has no workspace.')
  }
  const full = resolve(root, source)
  try {
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) return toolError('VALIDATION', 'source path is not a file.')
    if (stat.size > CANVAS_MAX_FILE_BYTES) return toolError('VALIDATION', 'source file exceeds the 1.5 MiB file cap.')
    const real = realpathSync(full)
    if (real !== root && !real.startsWith(root + sep)) return toolError('VALIDATION', 'source path is not allowed.')
    return readFileSync(real)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') return toolError('NOT_FOUND', 'source file was not found.')
    return toolError('VALIDATION', 'source path is not allowed.')
  }
}

async function dispatchCanvas(
  canvas: CanvasStore,
  work: CanvasWork,
  engine: CanvasEngine,
  hostId: string,
  args: Record<string, unknown>,
) {
  if (!engine.isBot(hostId)) return toolError('FORBIDDEN', 'Only the main bot can open a canvas worker.')
  const briefing = typeof args.briefing === 'string' ? args.briefing.trim() : ''
  if (briefing.length < 1 || briefing.length > 12000) return toolError('VALIDATION', 'briefing is required.')
  const key = args.idempotencyKey
  if (key != null && (typeof key !== 'string' || key.length < 8 || key.length > 128))
    return toolError('VALIDATION', 'idempotencyKey is not allowed.')
  const title = briefing.split('\n')[0]?.trim().slice(0, 80) ?? ''
  const requested = typeof args.canvasId === 'string' ? args.canvasId : ''
  let canvasId = requested !== '' ? requested : typeof key === 'string' ? canvas.findIdempotent(hostId, key) : null
  if (requested !== '') {
    if (!canvas.ownedBy(hostId, requested)) return toolError('FORBIDDEN', 'That canvas is not in this session.')
  } else if (!canvasId) {
    const created = canvas.create({
      sessionId: hostId,
      title,
      createdBy: 'bot',
      idempotencyKey: typeof key === 'string' ? key : null,
    })
    if (created.ok === false) return created
    canvasId = created.canvas?.id
  }
  if (typeof canvasId !== 'string') return toolError('STORE_FAILURE', 'The canvas was not created.')
  let skills: string[] = []
  try {
    skills = bindCanvasSkills(engine, hostId).bound
  } catch (error) {
    return toolError('STORE_FAILURE', error instanceof Error ? error.message : 'Canvas skills could not be bound.')
  }
  const forwarded: Record<string, unknown> = {
    briefing: canvasBriefing(canvasId, briefing, skills, canvas.previewPaths(canvasId)),
  }
  if (typeof key === 'string') forwarded.idempotencyKey = key
  if (args.budget != null) forwarded.budget = args.budget
  if (typeof args.correlationId === 'string') forwarded.correlationId = args.correlationId
  const dispatched = await work.dispatch(hostId, forwarded)
  if (dispatched.ok === true && typeof dispatched.ticketId === 'string') {
    if (requested !== '') canvas.attachWriter(canvasId, dispatched.ticketId)
    else canvas.attachTicket(canvasId, dispatched.ticketId)
  }
  return { ...dispatched, canvasId }
}

function ownedCanvas(
  canvas: CanvasStore,
  work: CanvasWork,
  engine: CanvasEngine,
  hostId: string,
): string | ToolPayload {
  if (engine.isBot(hostId)) return toolError('FORBIDDEN', 'The main bot cannot write a canvas preview.')
  const canvasId = canvas.canvasIdForTicket(work.ticketIdOf(hostId))
  if (!canvasId) return toolError('FORBIDDEN', 'Only the canvas worker for this preview can write it.')
  return canvasId
}

function editCanvas(canvas: CanvasStore, canvasId: string, args: Record<string, unknown>) {
  const path = typeof args.path === 'string' ? args.path : ''
  const old = args.old
  const replacement = args.replacement
  if (typeof old !== 'string' || typeof replacement !== 'string')
    return toolError('VALIDATION', 'canvas_edit needs old and replacement text.')
  if (old.length < 1 || old.length > EDIT_TEXT_MAX || replacement.length > EDIT_TEXT_MAX)
    return toolError('VALIDATION', 'canvas_edit text must be between 1 and 8000 characters.')
  const current = canvas.currentFile(canvasId, path)
  if (!current) return toolError('NOT_FOUND', `${path} is not in the current preview. Use canvas_write for a new file.`)
  if (current.type !== 'text/html' && current.type !== 'text/css')
    return toolError('VALIDATION', 'canvas_edit is only for HTML and CSS.')
  const text = current.bytes.toString('utf8')
  const count = countExact(text, old)
  if (count === 0) return toolError('VALIDATION', `old text was not found in ${path}.`)
  if (count > 1) return toolError('VALIDATION', `old text matched ${count} times in ${path}.`)
  const next = text.replace(old, replacement)
  return canvas.writeDraft(canvasId, [{ path, type: current.type, bytes: Buffer.from(next, 'utf8') }])
}

function decodeFiles(input: unknown): ToolPayload | DecodedFile[] {
  if (input == null) return []
  if (!Array.isArray(input)) return toolError('VALIDATION', 'files are not allowed.')
  const files: DecodedFile[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') return toolError('VALIDATION', 'A canvas file is not allowed.')
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string' || typeof record.type !== 'string')
      return toolError('VALIDATION', 'A canvas file is not allowed.')
    if (record.type === 'text') return toolError('VALIDATION', 'type must be text/html or text/css.')
    const text = record.text
    const body = record.body
    const source = record.source
    const present = [typeof text === 'string', typeof body === 'string', typeof source === 'string'].filter(Boolean)
    if (present.length > 1) return toolError('VALIDATION', 'A canvas file has more than one of text, body, and source.')
    if (typeof source === 'string') {
      if (!relativeSource(source)) return toolError('VALIDATION', 'source path is not allowed.')
      files.push({ path: record.path, type: record.type, source })
      continue
    }
    if (typeof text === 'string') {
      if (record.type !== 'text/html' && record.type !== 'text/css')
        return toolError('VALIDATION', 'text is only for text/html and text/css.')
      const bytes = Buffer.from(text, 'utf8')
      if (bytes.length > CANVAS_MAX_FILE_BYTES)
        return toolError('VALIDATION', `${record.path} exceeds the 1.5 MiB file cap. Pass a smaller HTML or CSS file.`)
      files.push({ path: record.path, type: record.type, bytes })
      continue
    }
    if (typeof body === 'string') {
      if (record.type === 'text/html' || record.type === 'text/css')
        return toolError('VALIDATION', 'HTML/CSS 用 text，base64 只给图片和字体。')
      const packed = body.replace(/\s/g, '')
      if (packed.length === 0 || packed.length > CANVAS_MAX_FILE_BYTES * 2 || !/^[A-Za-z0-9+/=]+$/.test(packed))
        return toolError('VALIDATION', `${record.path} body is not base64.`)
      files.push({ path: record.path, type: record.type, bytes: Buffer.from(packed, 'base64') })
      continue
    }
    return toolError('VALIDATION', 'A canvas file needs text, body, or source.')
  }
  return files
}

function materialize(
  files: DecodedFile[],
  sessionId: string,
  filesApi: CanvasFiles,
): ToolPayload | { path: string; type: string; bytes: Buffer }[] {
  const ready = []
  for (const file of files) {
    if ('bytes' in file) {
      ready.push(file)
      continue
    }
    const cwd = filesApi.workspaceCwd?.(sessionId) ?? ''
    const bytes = readWorkspaceFile(cwd, file.source)
    if (!Buffer.isBuffer(bytes)) return bytes
    ready.push({ path: file.path, type: file.type, bytes })
  }
  return ready
}

function relativeSource(source: string) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 200) return false
  if (isAbsolute(source) || source.includes('\0') || source.includes('\\')) return false
  const parts = source.split('/')
  return parts.every(part => part !== '' && part !== '..')
}

function countExact(text: string, needle: string) {
  let count = 0
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
  return count
}

function decodeRemove(input: unknown): ToolPayload | string[] {
  if (input == null) return []
  if (!Array.isArray(input) || input.some(item => typeof item !== 'string'))
    return toolError('VALIDATION', 'remove is not allowed.')
  return input
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, hostId: string) => Promise<ToolPayload>,
) {
  return {
    name,
    description,
    parameters,
    output: OUTPUT,
    async execute(
      args: Record<string, unknown> | null | undefined,
      exec: { agent?: { id?: string } } | null | undefined,
    ): Promise<ToolPayload> {
      const hostId = exec?.agent?.id
      if (typeof hostId !== 'string' || hostId === '')
        return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
      try {
        return await run(args ?? {}, hostId)
      } catch (error) {
        return toolError('STORE_FAILURE', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
