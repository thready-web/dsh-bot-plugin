import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_TYPES,
  citationForm,
  memorySlots,
  readCitations,
  readEntities,
  visibleMemory,
  type MemoryEntity,
} from './memory.ts'

const base = {
  id: 'fact:1',
  type: 'fact',
  scope: 'session',
  lifecycle: 'active',
  title: '',
  summary: 'The user prefers short replies.',
  revision: 1,
  createdAt: null,
  updatedAt: null,
  creator: 'tool',
  tombstone: false,
} satisfies MemoryEntity

test('each memory type keeps its own layout slots', () => {
  const slots = MEMORY_TYPES.map(type => memorySlots(type).join('|'))
  assert.equal(new Set(slots).size, MEMORY_TYPES.length)
  assert.equal(memorySlots('fact').includes('proposition'), true)
  assert.equal(memorySlots('profile').includes('proposition'), false)
  assert.equal(memorySlots('state').join(','), 'goal,blockers,next')
  assert.equal(memorySlots('skill').includes('load'), true)
})

test('a truncated citation is a summary and an unknown form stays unknown', () => {
  assert.equal(citationForm('truncated'), 'summary')
  assert.equal(citationForm('summary'), 'summary')
  assert.equal(citationForm('full'), 'full')
  assert.equal(citationForm('index'), 'index')
  assert.equal(citationForm('recall'), 'recall')
  assert.equal(citationForm('absent'), 'absent')
  assert.equal(citationForm('nope'), 'unknown')
  assert.equal(citationForm(''), 'unknown')
  assert.equal(citationForm(null), 'unknown')
})

test('forgotten text is dropped even when the payload still has it', () => {
  const shown = visibleMemory({
    ...base,
    lifecycle: 'forgotten',
    tombstone: false,
    summary: 'hidden-fact',
    body: 'hidden-fact',
    chain: [{ id: 'fact:1', lifecycle: 'forgotten', at: null, summary: 'hidden-fact', tombstone: false }],
  })
  assert.equal(shown.summary, '')
  assert.equal(shown.body, null)
  assert.equal(shown.bodyState, 'hidden')
  assert.equal(shown.chain?.[0]?.summary, '')
  assert.equal(JSON.stringify(shown).includes('hidden-fact'), false)
})

test('citation parsing does not promote an unknown form to full text', () => {
  const citations = readCitations({
    citations: [
      { id: 'fact:1', form: 'truncated' },
      { id: 'episodic:2', form: 'fullish' },
    ],
  })
  assert.deepEqual(
    citations.map(item => item.form),
    ['summary', 'unknown'],
  )
  const entities = readEntities({
    entities: [
      { ...base, summary: 'visible' },
      { id: 1 },
      { ...base, id: 'fact:2', lifecycle: 'forgotten', summary: 'secret' },
    ],
  })
  assert.equal(entities.length, 2)
  assert.equal(entities[1]?.summary, '')
})
