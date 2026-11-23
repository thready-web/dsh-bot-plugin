import { avatarIdFor, EYE_COLOR, presenceColor, type AvatarId } from './catalog.ts'
import type { PresenceState } from './types.ts'

export interface StillRequest {
  sessionId: string
  state: PresenceState
  definitionId?: string
  color?: string
}

export interface LiveRequest extends StillRequest {
  /** Eyes and body turn toward the pointer. The open title leaves this off. */
  followPointer?: boolean
  /** Fixed look (-1..1, x right, y down). Wins over the pointer. */
  lookAt?: { x: number; y: number } | null
}

export interface LiveHandle {
  update(state: PresenceState, lookAt?: { x: number; y: number } | null): void
  destroy(): void
}

function sameLook(a: { x: number; y: number } | null, b: { x: number; y: number } | null): boolean {
  if (a == null || b == null) return a == null && b == null
  return a.x === b.x && a.y === b.y
}

const stillCache = new Map<string, string>()

/** Static SVG for lists and cards. Validates the built-in definition before any markup is returned. */
export async function renderStill(request: StillRequest): Promise<string | null> {
  const definitionId = request.definitionId ?? avatarIdFor(request.sessionId)
  const color = request.color ?? presenceColor(request.sessionId)
  const key = `${definitionId}|${color}|${EYE_COLOR}|${request.state}|neutral`
  const cached = stillCache.get(key)
  if (cached) return cached
  try {
    const { getExample, renderAvatarSvg, validateAvatar } = await import('open-bot-avatar')
    const definition = getExample(definitionId)
    if (!definition) return null
    const checked = validateAvatar(definition)
    if (!checked.ok) return null
    const svg = renderAvatarSvg(checked.value, {
      color,
      eyeColor: EYE_COLOR,
      state: request.state,
      mood: 'neutral',
      reducedMotion: true,
    })
    if (!svg.startsWith('<svg') || svg.includes('<script')) return null
    stillCache.set(key, svg)
    return svg
  } catch {
    return null
  }
}

/**
 * One live canvas. The caller must destroy it on unmount and when the definition changes.
 * Reduced motion follows the system setting.
 */
export async function mountLive(host: HTMLElement, request: LiveRequest): Promise<LiveHandle | null> {
  try {
    const [{ getExample, validateAvatar }, { mountAvatar }] = await Promise.all([
      import('open-bot-avatar'),
      import('open-bot-avatar/dom'),
    ])
    const definitionId = (request.definitionId ?? avatarIdFor(request.sessionId)) as AvatarId
    const definition = getExample(definitionId)
    if (!definition) return null
    const checked = validateAvatar(definition)
    if (!checked.ok) return null
    const color = request.color ?? presenceColor(request.sessionId)
    let current = request.state
    let currentLook = request.lookAt ?? null
    const mounted = mountAvatar(host, {
      definition: checked.value,
      color,
      eyeColor: EYE_COLOR,
      state: current,
      mood: 'neutral',
      followPointer: request.followPointer === true && request.lookAt == null,
      lookAt: request.lookAt ?? null,
      reducedMotion: 'system',
      renderer: 'canvas',
      label: '',
    })
    return {
      update(state, lookAt) {
        const look = lookAt === undefined ? currentLook : lookAt
        if (state === current && sameLook(look, currentLook)) return
        current = state
        currentLook = look
        mounted.update({ state, mood: 'neutral', lookAt: look })
      },
      destroy() {
        mounted.destroy()
      },
    }
  } catch {
    return null
  }
}
