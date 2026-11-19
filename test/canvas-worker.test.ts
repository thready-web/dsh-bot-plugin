import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openCanvasStore } from '../src/canvas-store.ts'
import { canvasSkillFiles } from '../src/canvas-skills.ts'
import { canvasToolDefinitions, isCanvasWorkerBriefing } from '../src/canvas-tools.ts'
import { CANVAS_WORKER_PRESET, ensureWorkerFilePreset } from '../src/work-child.ts'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'
import type { ToolPayload } from '../src/errors.ts'

const html = '<!doctype html><link rel="stylesheet" href="app.css"><h1>Hi</h1></html>'
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
    const tools = canvasToolDefinitions(canvas, work, engine, {
      workspaceCwd: () => dir,
    })
    const dispatch = tools.find(tool => tool.name === 'foundations_dispatch_canvas')
    const read = tools.find(tool => tool.name === 'canvas_read')
    const edit = tools.find(tool => tool.name === 'canvas_edit')
    const write = tools.find(tool => tool.name === 'canvas_write')
    const publish = tools.find(tool => tool.name === 'canvas_publish')
    assert.ok(dispatch && read && edit && write && publish)
    const opened = await dispatch.execute(
      { briefing: 'A quiet reading card', idempotencyKey: 'canvas-key-1' },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(opened.ok, true)
    const canvasId = opened.canvasId as string
    assert.match(canvasId, /^cnv_/)
    assert.match(briefing, new RegExp(canvasId))
    assert.match(briefing, /canvas_read/)
    assert.match(briefing, /canvas_write/)
    assert.match(briefing, /canvas_edit/)
    assert.match(briefing, /canvas_publish once/)
    assert.match(briefing, /Do not search the disk for cnv_/)
    assert.match(briefing, /no published files yet/)
    assert.match(briefing, /index\.html/)
    assert.equal(isCanvasWorkerBriefing(briefing), true)
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

    const repeat = await publish.execute({}, { agent: { id: 'worker-canvas' } })
    assert.equal(repeat.code, 'VALIDATION')
    assert.match(String(repeat.message), /already published/)
    assert.equal(canvas.get(canvasId).canvas?.previewRevision, 1)

    const listed = await read.execute({}, { agent: { id: 'worker-canvas' } })
    assert.equal(listed.ok, true)
    assert.equal(listed.files.find((file: { path: string }) => file.path === 'index.html').text.includes('<h1>'), true)
    const typed = await write.execute(
      { files: [{ path: 'index.html', type: 'text', text: html }] },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(typed.code, 'VALIDATION')
    assert.match(String(typed.message), /text\/html or text\/css/)
    const encoded = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', body: Buffer.from(html).toString('base64') }] },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(encoded.code, 'VALIDATION')
    assert.match(String(encoded.message), /base64 只给图片和字体/)
    const clipped = html.replace('</html>', '')
    const incomplete = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', text: clipped }] },
      { agent: { id: 'worker-canvas' } },
    )
    assert.equal(incomplete.code, 'VALIDATION')
    assert.match(String(incomplete.message), /closing <\/html> tag/)

    tickets.set('worker-delta', 'ticket-delta')
    canvas.attachWriter(canvasId, 'ticket-delta')
    const edited = await edit.execute(
      { path: 'app.css', old: 'black', replacement: 'white' },
      { agent: { id: 'worker-delta' } },
    )
    assert.equal(edited.ok, true)
    const shortened = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', text: '<p>x</p></html>' }] },
      { agent: { id: 'worker-delta' } },
    )
    assert.equal(shortened.code, 'VALIDATION')
    assert.match(String(shortened.message), /much shorter/)
    const page = join(dir, 'page.html')
    writeFileSync(page, html.replace('Hi', 'Hello'))
    const sourced = await write.execute(
      { files: [{ path: 'index.html', type: 'text/html', source: 'page.html' }] },
      { agent: { id: 'worker-delta' } },
    )
    assert.equal(sourced.ok, true)
    const second = await publish.execute({}, { agent: { id: 'worker-delta' } })
    assert.equal(second.ok, true)
    assert.equal(second.kind, 'delta')
    assert.equal(second.baseRevision, 1)
    assert.equal(second.revision, 2)
    const againDelta = await publish.execute({}, { agent: { id: 'worker-delta' } })
    assert.equal(againDelta.code, 'VALIDATION')

    const cardTicket = canvas.get(canvasId).canvas?.ticketId
    tickets.set('worker-follow', 'ticket-follow')
    const savedDispatch = work.dispatch
    work.dispatch = async (_sessionId, args) => {
      briefing = String(args.briefing)
      return { ok: true, ticketId: 'ticket-follow', status: 'accepted' }
    }
    const follow = await dispatch.execute(
      {
        briefing: `Make the title larger\n\n[canvas-target canvas=${canvasId} rev=2 path=0:h1 tag=h1]Hi[/canvas-target]`,
        canvasId,
      },
      { agent: { id: 'bot-canvas' } },
    )
    work.dispatch = savedDispatch
    assert.equal(follow.ok, true)
    assert.equal(follow.canvasId, canvasId)
    assert.match(briefing, /\[canvas-target/)
    assert.match(briefing, /change only those nodes/)
    assert.match(briefing, /Current files: app\.css, index\.html/)
    assert.equal(canvas.get(canvasId).canvas?.ticketId, cardTicket)
    const stranger = await write.execute(
      { files: [{ path: 'app.css', type: 'text/css', text: 'h1{color:red}' }] },
      { agent: { id: 'worker-other' } },
    )
    assert.equal(stranger.code, 'FORBIDDEN')
    const followed = await write.execute(
      { files: [{ path: 'app.css', type: 'text/css', text: 'h1{color:red}' }] },
      { agent: { id: 'worker-follow' } },
    )
    assert.equal(followed.ok, true)
    const missing = await dispatch.execute(
      { briefing: 'Take over', canvasId: 'cnv_not_in_sessionX' },
      { agent: { id: 'bot-canvas' } },
    )
    assert.equal(missing.code, 'FORBIDDEN')

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

test('canvas workers are registered without bash', async () => {
  const registered: Array<{ id: string; plugins: Array<{ name: string }> }> = []
  const preset = await ensureWorkerFilePreset({
    get() {
      return {
        async register(spec: { id: string; plugins: Array<{ name: string }> }) {
          registered.push(spec)
        },
        mount() {},
      }
    },
  } as never)
  assert.equal(preset, 'foundations-files')
  const canvas = registered.find(item => item.id === CANVAS_WORKER_PRESET)
  assert.ok(canvas)
  assert.equal(
    canvas.plugins.some(plugin => plugin.name.includes('bash') || plugin.name.includes('jobs')),
    false,
  )
  assert.equal(
    registered.some(
      item => item.id === 'foundations-files' && item.plugins.some(plugin => plugin.name.includes('bash')),
    ),
    true,
  )
})
