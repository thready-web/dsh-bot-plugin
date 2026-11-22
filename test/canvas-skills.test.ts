import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { strict as assert } from 'node:assert'
import { openCanvasStore } from '../src/canvas-store.ts'
import { CanvasSkillsError, bundledCanvasSkillsRoot, canvasSkillFiles } from '../src/canvas-skills.ts'
import { canvasToolDefinitions } from '../src/canvas-tools.ts'
import { createEngine } from '../src/engine.ts'
import type { ToolPayload } from '../src/errors.ts'
import { openStore } from '../src/store.ts'

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function writePackage(root: string, files: Record<string, string>) {
  mkdirSync(join(root, 'skills'), { recursive: true })
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    sha256: sha256(text),
  }))
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  writeFileSync(
    join(root, 'skills', 'release-manifest.json'),
    `${JSON.stringify({ version: 1, purpose: 'test', files: entries }, null, 2)}\n`,
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', files: ['skills'] }))
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

const contract = '---\nname: ui-design\ndescription: Contract for one static preview.\n---\n\n# Canvas UI design\n'
const catalog = '---\nname: better-ui\ndescription: Polish surfaces.\n---\n\n# Polish\n'
const helper = '# surfaces\n\nUse the radius rule.\n'
const sources = '{"skills":[{"id":"better-ui"}]}\n'

test('bundled skills load from the package directory and include ui-design', () => {
  const root = bundledCanvasSkillsRoot()
  assert.equal(basename(root), 'ui')
  assert.equal(basename(dirname(root)), 'skills')
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(root)), 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@thready-web/dsh-bot-plugin')
  assert.ok(pkg.files.includes('skills'))
  const skills = canvasSkillFiles()
  const design = skills.find(skill => skill.id === 'ui-design')
  assert.ok(design)
  assert.equal(design.version, '1')
  assert.equal(design.helpers.length, 0)
  assert.equal(design.bytes.toString('utf8'), readFileSync(join(root, 'ui-design', 'SKILL.md'), 'utf8'))
  assert.equal(
    skills.some(skill => skill.id === 'frontend-design'),
    true,
  )
  assert.equal(
    skills.find(skill => skill.id === 'frontend-design')?.bytes.toString('utf8'),
    readFileSync(join(root, 'frontend-design', 'SKILL.md'), 'utf8'),
  )
})

test('a text helper beside SKILL.md is part of the loaded skill body', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skill-helper-'))
  try {
    writePackage(root, {
      'skills/ui/ui-design/SKILL.md': contract,
      'skills/ui/better-ui/SKILL.md': catalog,
      'skills/ui/better-ui/surfaces.md': helper,
      'skills/ui/sources.json': sources,
    })
    const skills = canvasSkillFiles(join(root, 'skills', 'ui'))
    const polish = skills.find(skill => skill.id === 'better-ui')
    assert.deepEqual(polish?.helpers, ['surfaces.md'])
    assert.match(polish?.bytes.toString('utf8') ?? '', /Use the radius rule/)
    assert.match(polish?.bytes.toString('utf8') ?? '', /^---\nname: better-ui/)
    const design = skills.find(skill => skill.id === 'ui-design')
    assert.equal(design?.bytes.toString('utf8'), contract)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing bundled skills name the release path and do not create a canvas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-missing-'))
  const persona = openStore(join(dir, 'persona'))
  const engine = createEngine(persona)
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  let dispatched = 0
  const work = {
    async dispatch(): Promise<ToolPayload> {
      dispatched += 1
      return { ok: true, ticketId: 'ticket-should-not-run', status: 'accepted' }
    },
    ticketIdOf() {
      return null
    },
  }
  try {
    engine.markBot('bot-missing')
    const kept = canvas.create({ sessionId: 'bot-missing', title: 'keep', createdBy: 'bot' })
    assert.equal(kept.ok, true)
    const keptId = kept.canvas?.id as string
    const tools = canvasToolDefinitions(canvas, work, engine, {}, join(dir, 'absent', 'skills', 'ui'))
    const dispatch = tools.find(tool => tool.name === 'foundations_dispatch_canvas')
    assert.ok(dispatch)
    const opened = await dispatch.execute({ briefing: 'A quiet reading card' }, { agent: { id: 'bot-missing' } })
    assert.equal(opened.ok, false)
    assert.equal(opened.code, 'UNAVAILABLE')
    assert.equal(opened.canvasId, undefined)
    assert.match(opened.message, /skills\/ui\/ui-design\/SKILL.md/)
    assert.match(opened.message, /will not open a canvas/)
    assert.match(opened.message, /npm pack/)
    assert.equal(dispatched, 0)
    assert.equal(canvas.list('bot-missing').canvases?.length, 1)
    const again = await dispatch.execute(
      { briefing: 'Revise the card', canvasId: keptId },
      { agent: { id: 'bot-missing' } },
    )
    assert.equal(again.code, 'UNAVAILABLE')
    assert.equal(canvas.get(keptId).canvas?.id, keptId)
    assert.equal(canvas.get(keptId).canvas?.ticketId, null)
    assert.equal(dispatched, 0)
    assert.throws(() => canvasSkillFiles(join(dir, 'absent', 'skills', 'ui')), CanvasSkillsError)
  } finally {
    canvas.close()
    persona.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a private ui-design stays bound and a public copy is not required to open a canvas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-private-'))
  const persona = openStore(join(dir, 'persona'))
  const engine = createEngine(persona)
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  const work = {
    async dispatch(): Promise<ToolPayload> {
      return { ok: true, ticketId: 'ticket-private', status: 'accepted' }
    },
    ticketIdOf() {
      return null
    },
  }
  try {
    engine.markBot('bot-private')
    engine.registerSkill('bot-private', 'private', 'ui-design', 'private', 'kept', Buffer.from('PRIVATE CONTRACT'))
    const tools = canvasToolDefinitions(canvas, work, engine)
    const dispatch = tools.find(tool => tool.name === 'foundations_dispatch_canvas')
    assert.ok(dispatch)
    const opened = await dispatch.execute({ briefing: 'A quiet reading card' }, { agent: { id: 'bot-private' } })
    assert.equal(opened.ok, true)
    assert.match(String(opened.canvasId), /^cnv_/)
    const loaded = engine.loadSkill('bot-private', 'ui-design')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.data?.body, 'PRIVATE CONTRACT')
    assert.equal(loaded.data?.scope, 'private')
  } finally {
    canvas.close()
    persona.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bundled skill that cannot be stored does not leave a canvas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-store-'))
  const canvas = openCanvasStore(join(dir, 'canvas.sqlite'))
  const engine = {
    isBot() {
      return true
    },
    registerSkill(_sessionId: string, _scope: 'private' | 'public', skillId: string) {
      if (skillId !== 'ui-design') return null
      throw Object.assign(new Error('skill blob mismatch'), { code: 'HASH_MISMATCH' })
    },
  }
  const work = {
    async dispatch(): Promise<ToolPayload> {
      return { ok: true, ticketId: 'ticket-no', status: 'accepted' }
    },
    ticketIdOf() {
      return null
    },
  }
  try {
    const tools = canvasToolDefinitions(canvas, work, engine)
    const dispatch = tools.find(tool => tool.name === 'foundations_dispatch_canvas')
    assert.ok(dispatch)
    const opened = await dispatch.execute({ briefing: 'A quiet reading card' }, { agent: { id: 'bot-store' } })
    assert.equal(opened.ok, false)
    assert.equal(opened.code, 'UNAVAILABLE')
    assert.match(opened.message, /ui-design/)
    assert.equal(opened.canvasId, undefined)
    assert.equal(canvas.list('bot-store').canvases?.length ?? 0, 0)
  } finally {
    canvas.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
