import type { PresenceEngine } from './types.ts'

/** Built-in examples shipped by open-bot-avatar@0.3.0. No gallery files, no remote URLs. */
export const AVATAR_IDS = ['chat', 'mug', 'controller', 'lightbulb', 'sprout', 'watering-can', 'barbell'] as const

export type AvatarId = (typeof AVATAR_IDS)[number]

/**
 * Bright body colors, in the same range as the Grok faces: saturated orange, red,
 * teal, pink, violet, amber, blue, and green. No near-black and no dull brown.
 */
export const PRESENCE_COLORS = [
  '#ff7a18',
  '#ff4d4f',
  '#1ad6c5',
  '#ff4f9a',
  '#a15cff',
  '#ffb020',
  '#3d8bff',
  '#3ee08a',
] as const

/** White eyes, so they read as cutouts on a bright body. */
export const EYE_COLOR = '#ffffff'

const ENGINE_KEY = 'dsh.presence.engine'

export function avatarIdFor(sessionId: string): AvatarId {
  return AVATAR_IDS[hash(sessionId) % AVATAR_IDS.length]!
}

export function presenceColor(sessionId: string): string {
  return PRESENCE_COLORS[hash(`${sessionId}:color`) % PRESENCE_COLORS.length]!
}

export function readPresenceEngine(storage: Pick<Storage, 'getItem'> | null = browserStorage()): PresenceEngine {
  try {
    const value = storage?.getItem(ENGINE_KEY)
    if (value === 'none' || value === 'open-bot-avatar' || value === 'dotform') return value
  } catch {
    /* private mode */
  }
  return 'open-bot-avatar'
}

function browserStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

function hash(value: string): number {
  let sum = 0
  for (let i = 0; i < value.length; i += 1) sum = (sum * 33 + value.charCodeAt(i)) >>> 0
  return sum
}
