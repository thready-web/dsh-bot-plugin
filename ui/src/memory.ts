export const MEMORY_TYPES = ['persona', 'profile', 'fact', 'episodic', 'procedural', 'state', 'skill'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]
export type MemoryScope = 'user' | 'session' | 'work' | 'skill'
export type MemoryLifecycle = 'active' | 'corrected' | 'forgotten' | 'candidate'
export type MemoryCreator = 'user' | 'model' | 'system' | 'tool' | 'unknown'
export type CitationForm = 'full' | 'summary' | 'index' | 'recall' | 'absent' | 'unknown'
export type BodyState = 'visible' | 'hidden' | 'mismatch' | 'absent'

export interface MemoryAttribute {
  name: string
  value: string
}

export interface MemoryChainItem {
  id: string
  lifecycle: MemoryLifecycle
  at: string | null
  summary: string
  tombstone: boolean
}

export interface MemoryChange {
  id: number
  tool: string
  outcome: string
  at: string
}

export interface MemorySource {
  creator: MemoryCreator
  recorded: boolean
  createdAt: string | null
  updatedAt: string | null
  eventId: string | null
}

export interface MemoryEntity {
  id: string
  type: MemoryType
  scope: MemoryScope
  lifecycle: MemoryLifecycle
  title: string
  summary: string
  revision: number | null
  createdAt: string | null
  updatedAt: string | null
  creator: MemoryCreator
  tombstone: boolean
  priority?: number
  attributes?: MemoryAttribute[]
  steps?: string[]
  goal?: string
  blockers?: string[]
  next?: string
  versionLabel?: string
  enabled?: boolean
  bindingScope?: 'public' | 'private'
  body?: string | null
  bodyState?: BodyState
  note?: string | null
  source?: MemorySource
  chain?: MemoryChainItem[]
  changes?: MemoryChange[]
}

export interface MemoryFrame {
  revision: number
  frozenAt: string
  presence: string
  hasManifest: boolean
}

export interface MemoryCitation {
  id: string
  form: CitationForm
  reason: string
}

/** Layout slots differ by entity type so a card is not only a shared badge. */
export function memorySlots(type: MemoryType): readonly string[] {
  switch (type) {
    case 'persona':
      return ['title', 'excerpt', 'version']
    case 'profile':
      return ['attributes']
    case 'fact':
      return ['proposition']
    case 'episodic':
      return ['time', 'scene']
    case 'procedural':
      return ['steps']
    case 'state':
      return ['goal', 'blockers', 'next']
    case 'skill':
      return ['name', 'summary', 'load']
  }
}

/** Truncation is a summary. An unrecognized form stays unknown. */
export function citationForm(value: unknown): CitationForm {
  if (value === 'full') return 'full'
  if (value === 'summary' || value === 'truncated') return 'summary'
  if (value === 'index') return 'index'
  if (value === 'recall' || value === 'tool') return 'recall'
  if (value === 'absent' || value === 'none' || value === 'uncited') return 'absent'
  return 'unknown'
}

/** Forgotten rows drop any text the payload still carried. */
export function visibleMemory(entity: MemoryEntity): MemoryEntity {
  const chain = entity.chain?.map(item =>
    item.tombstone || item.lifecycle === 'forgotten' ? { ...item, summary: '', tombstone: true } : item,
  )
  const hidden = entity.tombstone || entity.lifecycle === 'forgotten'
  if (!hidden) return chain ? { ...entity, chain } : entity
  return {
    ...entity,
    tombstone: true,
    title: entity.type === 'skill' ? entity.title : '',
    summary: '',
    body: null,
    bodyState: 'hidden',
    attributes: [],
    steps: [],
    goal: '',
    blockers: [],
    next: '',
    ...(chain ? { chain } : {}),
  }
}

export function readEntities(body: Record<string, unknown>): MemoryEntity[] {
  if (!Array.isArray(body.entities)) return []
  return body.entities.flatMap(item => {
    const entity = asEntity(item)
    return entity ? [visibleMemory(entity)] : []
  })
}

export function readEntity(body: Record<string, unknown>): MemoryEntity | null {
  const entity = asEntity(body.entity)
  return entity ? visibleMemory(entity) : null
}

export function readFrames(body: Record<string, unknown>): MemoryFrame[] {
  if (!Array.isArray(body.frames)) return []
  const frames: MemoryFrame[] = []
  for (const item of body.frames) {
    if (!item || typeof item !== 'object') continue
    const frame = item as Record<string, unknown>
    if (typeof frame.revision !== 'number') continue
    frames.push({
      revision: frame.revision,
      frozenAt: typeof frame.frozenAt === 'string' ? frame.frozenAt : '',
      presence: typeof frame.presence === 'string' ? frame.presence : '',
      hasManifest: frame.hasManifest === true,
    })
  }
  return frames
}

export function readCitations(body: Record<string, unknown>): MemoryCitation[] {
  if (!Array.isArray(body.citations)) return []
  const citations: MemoryCitation[] = []
  for (const item of body.citations) {
    if (!item || typeof item !== 'object') continue
    const citation = item as Record<string, unknown>
    if (typeof citation.id !== 'string') continue
    citations.push({
      id: citation.id,
      form: citationForm(citation.form),
      reason: typeof citation.reason === 'string' ? citation.reason : 'no_manifest',
    })
  }
  return citations
}

function asEntity(value: unknown): MemoryEntity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entity = value as MemoryEntity
  if (typeof entity.id !== 'string' || !isType(entity.type)) return null
  return entity
}

function isType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}
