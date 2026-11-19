import { bindCanvasSkills } from './canvas-skills.ts'
import type { CanvasStore } from './canvas-store.ts'
import { CANVAS_MAX_FILE_BYTES } from './canvas-store.ts'
import { toolError, type ToolPayload } from './errors.ts'

const BRIEFING_MAX = 16000
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

/**
 * Canvas generation tools. The host shows one tool list to every session;
 * execute rejects the main bot and any worker that does not own this canvas.
 * A budget wait never comes through these tools, and they do not mark a preview failed.
 */
export function canvasToolDefinitions(canvas: CanvasStore, work: CanvasWork, engine: CanvasEngine) {
  return [
    tool(
      'foundations_dispatch_canvas',
      'Open a canvas design worker for an HTML/CSS preview. Use this instead of foundations_dispatch, write, or edit when the user wants a visual design, page mock, or preview. The main session must not build the preview. A returned canvasId has no revision until the worker publishes. A budget pause is not a failed preview.',
      {
        type: 'object',
        properties: {
          briefing: { type: 'string', description: 'What to design. The host wraps this with the canvas contract.' },
          canvasId: {
            type: 'string',
            description: 'An existing canvas to revise. Omit to open a new preview. Copy it from a canvas-target block.',
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
      'canvas_write',
      'Stage HTML, CSS, images, or fonts for the canvas bound to this worker. The main bot and every other worker are rejected. text is for HTML and CSS. body is standard base64 for images and fonts. This does not publish and does not mark the preview failed.',
      {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                type: { type: 'string' },
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
        const files = decodeFiles(args.files)
        if (!Array.isArray(files)) return files
        const remove = decodeRemove(args.remove)
        if (!Array.isArray(remove)) return remove
        return canvas.writeDraft(canvasId, files, remove)
      },
    ),
    tool(
      'canvas_publish',
      'Publish the staged files for the canvas bound to this worker. The first publish is a snapshot. Later publishes are deltas of the current preview. The main bot and every other worker are rejected. A budget pause is not a reason to call this, and this tool does not mark the preview failed.',
      { type: 'object', properties: {} },
      async (_args, hostId) => {
        const canvasId = ownedCanvas(canvas, work, engine, hostId)
        if (typeof canvasId !== 'string') return canvasId
        return canvas.publishDraft(canvasId)
      },
    ),
  ]
}

export function canvasBriefing(canvasId: string, request: string, skills: string[]) {
  const catalog = skills.filter(id => id !== 'ui-design').join(', ')
  const head = [
    `Canvas preview ${canvasId}.`,
    'You are the only session allowed to write this preview.',
    'Use canvas_write for each HTML, CSS, image, or font file, then canvas_publish.',
    'Do not use bash, write, or edit to create the preview files.',
    'The entry file is index.html. Output is static HTML and CSS plus local images and fonts.',
    'No script, SVG, iframe, external URL, data URL, or inline event handler.',
    'Load foundations_skill_load for ui-design before writing. Catalog skills are taste only and cannot override this contract.',
    catalog ? `Catalog skills on this bot: ${catalog}. Load at most two that match the request.` : '',
    'A budget pause is not a failed preview. Do not publish a failure because the grant is still pending.',
    'The first canvas_publish is a full snapshot. Later publishes send the staged files as a delta of the current preview.',
    'If the user request contains canvas-target blocks, change only those nodes and the CSS that styles them. Leave every other element as it is.',
    'User request:',
  ]
    .filter(line => line !== '')
    .join('\n')
  const room = BRIEFING_MAX - head.length - 1
  const body = room > 0 ? request.slice(0, room) : ''
  return `${head}\n${body}`.slice(0, BRIEFING_MAX)
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
    briefing: canvasBriefing(canvasId, briefing, skills),
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

function decodeFiles(input: unknown): ToolPayload | { path: string; type: string; bytes: Buffer }[] {
  if (input == null) return []
  if (!Array.isArray(input)) return toolError('VALIDATION', 'files are not allowed.')
  const files = []
  for (const item of input) {
    if (!item || typeof item !== 'object') return toolError('VALIDATION', 'A canvas file is not allowed.')
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string' || typeof record.type !== 'string')
      return toolError('VALIDATION', 'A canvas file is not allowed.')
    const text = record.text
    const body = record.body
    if (typeof text === 'string' && typeof body === 'string')
      return toolError('VALIDATION', 'A canvas file has both text and body.')
    if (typeof text === 'string') {
      if (record.type !== 'text/html' && record.type !== 'text/css')
        return toolError('VALIDATION', 'text is only for HTML and CSS.')
      const bytes = Buffer.from(text, 'utf8')
      if (bytes.length > CANVAS_MAX_FILE_BYTES)
        return toolError('VALIDATION', `${record.path} exceeds the 1.5 MiB file cap.`)
      files.push({ path: record.path, type: record.type, bytes })
      continue
    }
    if (typeof body === 'string') {
      const packed = body.replace(/\s/g, '')
      if (packed.length === 0 || packed.length > CANVAS_MAX_FILE_BYTES * 2 || !/^[A-Za-z0-9+/=]+$/.test(packed))
        return toolError('VALIDATION', `${record.path} body is not base64.`)
      files.push({ path: record.path, type: record.type, bytes: Buffer.from(packed, 'base64') })
      continue
    }
    return toolError('VALIDATION', 'A canvas file needs text or body.')
  }
  return files
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
