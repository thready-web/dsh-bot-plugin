import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openCanvasStore } from '../src/canvas-store.ts'
import { canvasSkillFiles } from '../src/canvas-skills.ts'
import { canvasToolDefinitions } from '../src/canvas-tools.ts'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'
import type { ToolPayload } from '../src/errors.ts'

const html = '<!doctype html><link rel="stylesheet" href="app.css"><h1>Hi</h1>'
const css = 'h1{color:black}'

test('canvas worker publishes a snapshot then a delta; the main bot cannot write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-worker-'))
  const persona = openStore(join(dir, 'persona'))
  const engine = createEngine(persona)
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  const tickets = new Map<string, string>([['worker-canvas', 'ticket-canvas']])
  let briefing = ''
  const work = {
    async dispatch(_sessionId: string, args: Record<string, unknown>): Promise<ToolPayload> {
      briefing = String(args.briefing)
      return { ok: true, ticketId: 'ticket-canvas', status: 'accepted' }
    },
    ticketIdOf(sessionId: string) {
      return tickets.get(sessionId) ?? null
    },
  }
  try {
    engine.markBot('bot-canvas')
    const tools = canvasToolDefinitions(canvas, work, engine)
    const dispatch = tools.find(tool => tool.name === 'foundations_dispatch_canvas')
    const write = tools.find(tool => tool.name === 'canvas_write')
    const publish = tools.find(tool => tool.name === 'canvas_publish')
    assert.ok(dispatch && write && publish)
    const opened = await dispatch.execute(
      { briefing: 'A quiet reading card', idempotencyKey: 'canvas-key-1' },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(opened.ok, true)
    const canvasId = opened.canvasId as string
    assert.match(canvasId, /^cnv_/)
    assert.match(briefing, new RegExp(canvasId))
    assert.match(briefing, /canvas_write/)
    assert.match(briefing, /canvas_publish/)
    assert.match(briefing, /index\.html/)
    assert.match(briefing, /ui-design/)
    assert.match(briefing, /budget pause is not a failed preview/)
    const again = await dispatch.execute(
      { briefing: 'A quiet reading card', idempotencyKey: 'canvas-key-1' },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(again.canvasId, canvasId)
    assert.equal(canvas.list('bot-canvas').canvases?.length, 1)
    const loaded = engine.loadSkill('bot-canvas', 'ui-design')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.data?.grantsTools, false)
    assert.equal(engine.loadSkill('bot-canvas', 'frontend-design').ok, true)
    assert.equal(
      canvasSkillFiles().some(skill => skill.id === 'ui-design'),
      true,
    )

    const botWrite = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', text: html }] },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(botWrite.code, 'FORBIDDEN')
    const other = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', text: html }] },
      { agent: { id: 'worker-other' } },
    )
    assert.equal(other.code, 'FORBIDDEN')
    tickets.set('worker-other', 'ticket-other')
    const ordinary = await publish.execute({}, { agent: { id: 'worker-other' } })
    assert.equal(ordinary.code, 'FORBIDDEN')

    const staged = await write.execute(
      {
        files: [
          { path: 'index.html', type: 'text/html', text: html },
          { path: 'app.css', type: 'text/css', text: css },
        ],
      },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(staged.ok, true)
    const first = await publish.execute({}, { agent: { id: 'worker-canvas' } })
    assert.equal(first.ok, true)
    assert.equal(first.kind, 'snapshot')
    assert.equal(first.revision, 1)
    const reader = openCanvasStore(join(dir, 'canvas.sqlite'))
    const notice = reader.live('bot-canvas')
    assert.equal(notice.events[0]?.revision, 1)
    assert.equal(JSON.stringify(notice).includes('<h1>'), false)
    reader.close()

    const edited = await write.execute(
      { files: [{ path: 'app.css', type: 'text/css', text: 'h1{color:white}' }] },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(edited.ok, true)
    const second = await publish.execute({}, { agent: { id: 'worker-canvas' } })
    assert.equal(second.ok, true)
    assert.equal(second.kind, 'delta')
    assert.equal(second.baseRevision, 1)
    assert.equal(second.revision, 2)

    const script = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', text: '<script>1</script>' }] },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(script.code, 'VALIDATION')
    assert.equal(canvas.get(canvasId).canvas?.previewRevision, 2)
    const paused = await dispatch.execute(
      { briefing: 'Another card', idempotencyKey: 'canvas-key-2' },
      { agent: { id: 'bot-canvas' } },
    )
    work.dispatch = async () => ({ ok: false, code: 'BUDGET', message: 'full' })
    const denied = await dispatch.execute(
      { briefing: 'A third card', idempotencyKey: 'canvas-key-3' },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(paused.ok, true)
    assert.equal(denied.code, 'BUDGET')
    assert.equal(canvas.get(String(denied.canvasId)).canvas?.previewRevision, null)
    assert.equal(canvas.get(canvasId).canvas?.previewRevision, 2)
    assert.equal(readFileSync(new URL('../src/canvas-tools.ts', import.meta.url), 'utf8').includes('.fail('), false)
  } finally {
    canvas.close()
    persona.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
