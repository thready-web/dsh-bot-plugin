/**
 * Official session permission-preset surface for the desk settings UI.
 *
 * The write path is `ctx.permissionPresets.set(session, name)`. Auto is
 * offered only when the live catalog includes it (the experimental package
 * has registered it). This is a settings concern, not a transcript card.
 * The instance default for a future main session is `permission-default.ts`;
 * a worker copies its parent with `worker-permission.ts`. Both call this
 * setter and do not invent a second sandbox policy.
 */
import { toolError, type ToolPayload } from './errors.ts'
import type { HostContext } from './host.ts'

export type PermissionOption = {
  value: string
  name: string
  description?: string
}

export type PermissionView = {
  available: boolean
  currentValue: string
  options: PermissionOption[]
  defaultOptions: PermissionOption[]
  defaultPreset: string
  autoAvailable: boolean
}

function sessionOf(ctx: HostContext, sessionId: string): unknown {
  const agent = ctx.agents?.get?.(sessionId)
  if (agent?.session) return agent.session
  const sessions = ctx.sessions ?? ctx.get?.('sessions')
  return sessions?.get?.(sessionId)
}

function optionList(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.value !== 'string' || row.value === '') return []
    const option: PermissionOption = {
      value: row.value,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.value,
    }
    if (typeof row.description === 'string' && row.description !== '') option.description = row.description
    return [option]
  })
}

export type EffectivePermission = {
  available: boolean
  /** False when no live session object exists for this id. */
  found: boolean
  /** `permissionPresets.current` when the session is live. Empty when it is not. */
  preset: string
}

/**
 * The preset the live session is actually running under.
 * A missing session does not fall back to the catalog composition default:
 * that default is the host pin, not this session's policy.
 */
export function effectivePermission(ctx: HostContext, sessionId: string): EffectivePermission {
  const service = ctx.get?.('permissionPresets')
  if (!service || typeof service.catalog !== 'function' || typeof service.current !== 'function') {
    return { available: false, found: false, preset: '' }
  }
  const session = sessionOf(ctx, sessionId)
  if (!session) return { available: true, found: false, preset: '' }
  return { available: true, found: true, preset: String(service.current(session) ?? '') }
}

export function permissionView(ctx: HostContext, sessionId: string): PermissionView {
  const service = ctx.get?.('permissionPresets')
  if (!service || typeof service.catalog !== 'function') {
    return {
      available: false,
      currentValue: '',
      options: [],
      defaultOptions: [],
      defaultPreset: '',
      autoAvailable: false,
    }
  }
  const catalog = service.catalog() ?? {}
  const options = optionList(catalog.options)
  const defaultOptions = optionList(catalog.defaultOptions)
  const session = sessionId !== '' ? sessionOf(ctx, sessionId) : undefined
  const currentValue =
    session && typeof service.current === 'function'
      ? String(service.current(session) ?? '')
      : typeof catalog.defaultPreset === 'string'
        ? catalog.defaultPreset
        : ''
  return {
    available: true,
    currentValue,
    options,
    defaultOptions,
    defaultPreset: typeof catalog.defaultPreset === 'string' ? catalog.defaultPreset : '',
    autoAvailable: options.some(option => option.value === 'auto'),
  }
}

export function setPermission(ctx: HostContext, sessionId: string, name: string): ToolPayload {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return toolError('VALIDATION', 'sessionId is required.')
  }
  if (typeof name !== 'string' || name === '' || name === 'custom') {
    return toolError('VALIDATION', 'A selectable preset name is required.')
  }
  const service = ctx.get?.('permissionPresets')
  if (!service || typeof service.set !== 'function') {
    return toolError('UNAVAILABLE', 'Official permission presets are not composed on this host.')
  }
  const session = sessionOf(ctx, sessionId)
  if (!session) return toolError('NOT_FOUND', 'No live session is available for this permission change.')
  try {
    service.set(session, name)
    return { ok: true, ...permissionView(ctx, sessionId) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The permission preset could not be changed.'
    return toolError('VALIDATION', message)
  }
}
