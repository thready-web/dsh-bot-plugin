import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { citationForm, type MemoryEntity } from '../ui/src/memory.ts'

const compiled = await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server'
      import { MemoryCard, MemoryDetail } from './ui/src/MemoryPanel.tsx'
      const t = (key, vars) => (vars ? key + ' ' + JSON.stringify(vars) : key)
      export const row = (entity) => renderToStaticMarkup(
        <MemoryCard entity={entity} selected={false} t={t} onSelect={() => {}} />
      )
      export const detail = (entity, citation = null) => renderToStaticMarkup(
        <MemoryDetail entity={entity} citation={citation} sourceReady={true} t={t} onClose={() => {}} onSelect={() => {}} />
      )
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'tsx',
  },
  alias: {
    react: new URL('../ui/node_modules/react', import.meta.url).pathname,
    'react-dom': new URL('../ui/node_modules/react-dom', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
})
const mod = {
  exports: {} as Record<
    string,
    (entity: MemoryEntity, citation?: { id: string; form: string; reason: string } | null) => string
  >,
}
new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
)
const { row, detail } = mod.exports

const entity = (patch: Partial<MemoryEntity> & Pick<MemoryEntity, 'id' | 'type'>): MemoryEntity => ({
  scope: 'session',
  lifecycle: 'active',
  title: '',
  summary: '',
  revision: 1,
  createdAt: '2026-11-17T01:00:00.000Z',
  updatedAt: '2026-11-17T02:00:00.000Z',
  creator: 'unknown',
  tombstone: false,
  ...patch,
})

test('each memory type renders a different document structure', () => {
  const persona = detail(
    entity({
      id: 'persona:1',
      type: 'persona',
      scope: 'user',
      title: 'Scout',
      summary: 'Keep it short.',
      versionLabel: '1',
      creator: 'user',
    }),
    null,
  )
  const profile = detail(
    entity({
      id: 'profile:1',
      type: 'profile',
      title: '',
      attributes: [
        { name: '称呼', value: 'Ada' },
        { name: '偏好', value: '短句' },
      ],
    }),
    null,
  )
  const fact = detail(
    entity({ id: 'fact:1', type: 'fact', summary: 'The user prefers short replies.', priority: 100 }),
    null,
  )
  const episode = detail(
    entity({ id: 'episodic:1', type: 'episodic', title: 'Tuesday', summary: 'met on the platform' }),
    null,
  )
  const procedure = detail(
    entity({ id: 'procedural:1', type: 'procedural', steps: ['Write the brief', 'Check the hash'] }),
    null,
  )
  const state = detail(
    entity({
      id: 'state:current',
      type: 'state',
      goal: 'ship the panel',
      blockers: ['wait for manifest'],
      next: 'draw cards',
    }),
    null,
  )
  const skill = detail(
    entity({
      id: 'skill:guide',
      type: 'skill',
      scope: 'skill',
      title: 'guide',
      summary: 'guide summary',
      bindingScope: 'private',
      enabled: true,
    }),
    null,
  )
  assert.match(persona, /memory-doc-persona/)
  assert.match(persona, /memory-version/)
  assert.match(persona, /memory-excerpt/)
  assert.match(profile, /memory-doc-profile/)
  assert.match(profile, /<dl/)
  assert.doesNotMatch(fact, /<dl/)
  assert.match(fact, /memory-proposition/)
  assert.match(episode, /<time/)
  assert.match(episode, /memory-scene/)
  assert.match(procedure, /<ol/)
  assert.match(state, /memory-goal/)
  assert.match(state, /memory-blockers/)
  assert.match(state, /memory-next/)
  assert.match(skill, /memory-skill-name/)
  assert.match(skill, /memory-skill-load/)
  assert.match(skill, /memory.skill.loadUnknown/)
  const classes = [persona, profile, fact, episode, procedure, state, skill].map(
    html => /memory-doc-([a-z]+)/.exec(html)?.[1],
  )
  assert.equal(new Set(classes).size, 7)
})

test('citation and source stay honest in the rendered document', () => {
  const summary = detail(entity({ id: 'fact:1', type: 'fact', summary: 'A short fact.' }), {
    id: 'fact:1',
    form: citationForm('truncated'),
    reason: 'no_manifest',
  })
  assert.match(summary, /memory-cite-summary/)
  assert.doesNotMatch(summary, /memory-cite-full/)
  const forgotten = detail(
    entity({
      id: 'fact:2',
      type: 'fact',
      lifecycle: 'forgotten',
      tombstone: true,
      summary: 'hidden-fact',
      body: 'hidden-fact',
    }),
    { id: 'fact:2', form: 'unknown', reason: 'no_manifest' },
  )
  assert.equal(forgotten.includes('hidden-fact'), false)
  assert.match(forgotten, /memory-tombstone/)
  const listed = row(
    entity({
      id: 'fact:2',
      type: 'fact',
      lifecycle: 'forgotten',
      tombstone: true,
      summary: 'hidden-fact',
      body: 'hidden-fact',
    }),
  )
  assert.equal(listed.includes('hidden-fact'), false)
  assert.match(listed, /memory\.tombstone/)
  const unrecorded = detail(
    entity({
      id: 'state:current',
      type: 'state',
      source: { creator: 'user', recorded: false, createdAt: null, updatedAt: null, eventId: null },
    }),
  )
  assert.match(unrecorded, /memory.source.unrecorded/)
  assert.doesNotMatch(unrecorded, /memory.source.user/)
  const unknown = detail(
    entity({
      id: 'fact:3',
      type: 'fact',
      summary: 'Known fact.',
      source: {
        creator: 'unknown',
        recorded: true,
        createdAt: '2026-11-17T01:00:00.000Z',
        updatedAt: null,
        eventId: null,
      },
    }),
  )
  assert.match(unknown, /memory.source.unknown/)
  assert.doesNotMatch(unknown, /memory.source.user/)
})
