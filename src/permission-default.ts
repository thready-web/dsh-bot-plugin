/**
 * Instance-wide default permission for bot main sessions created from now on.
 *
 * The host's `permission` settings namespace pins `defaultPreset` onto every
 * fresh Agent, including workers. This file does not write that namespace.
 * A new bot main session is applied later through `permissionPresets.set`,
 * the same sandbox-mode and approval-policy write the per-session control uses.
 * Sessions that already exist, and any explicit per-session choice, are left
 * alone. Workers are never added to the pending list. A worker copies its
 * parent main session at creation (`worker-permission.ts`), not this file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { toolError, type ToolPayload } from './errors.ts'
import { ensureDir, writeAtomic } from './fs-safe.ts'
import type { HostContext } from './host.ts'
import { permissionView, setPermission, type PermissionOption } from './permissions.ts'

/** Official preset id for full file access and no approval prompts. */
export const PRODUCT_DEFAULT_PRESET = 'danger-full-access'

const MAIN_SESSION = /^session-[A-Za-z0-9-]+$/
const RESERVED = new Set(['auto', 'custom'])

export type PermissionDefaultState = {
  stored: string | null
  ignoredStored: boolean
  pending: string[]
  corrupt: boolean
}

export function permissionDefaultFile(dataDir: string) {
  return join(dataDir, 'permission-default.json')
}

function readBody(file: string): { body: Record<string, unknown>; corrupt: boolean } {
  if (!existsSync(file)) return { body: {}, corrupt: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { body: {}, corrupt: true }
    return { body: parsed as Record<string, unknown>, corrupt: false }
  } catch {
    return { body: {}, corrupt: true }
  }
}

function pendingOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((item): item is string => typeof item === 'string' && MAIN_SESSION.test(item))
  return [...new Set(ids)]
}

function interpretStored(
  body: Record<string, unknown>,
  corrupt: boolean,
): { stored: string | null; ignoredStored: boolean } {
  if (corrupt) return { stored: null, ignoredStored: true }
  if (!Object.hasOwn(body, 'defaultPreset')) return { stored: null, ignoredStored: false }
  const value = body.defaultPreset
  if (typeof value !== 'string' || value === '' || RESERVED.has(value)) return { stored: null, ignoredStored: true }
  return { stored: value, ignoredStored: false }
}

export function readPermissionDefault(file: string): PermissionDefaultState {
  const { body, corrupt } = readBody(file)
  const interpreted = interpretStored(body, corrupt)
  return { ...interpreted, pending: pendingOf(body.pending), corrupt }
}

function writeBody(file: string, body: Record<string, unknown>) {
  ensureDir(dirname(file))
  writeAtomic(file, `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * Preset a new main session should receive. A missing or unusable stored
 * value uses Fully allow when the live catalog contains it.
 */
export function resolveDefaultPreset(stored: string | null, allowed: readonly string[]): string {
  if (stored && allowed.includes(stored)) return stored
  if (allowed.includes(PRODUCT_DEFAULT_PRESET)) return PRODUCT_DEFAULT_PRESET
  return ''
}

function allowedPresets(options: PermissionOption[]): string[] {
  return options.map(option => option.value).filter(value => value !== '' && !RESERVED.has(value))
}

export function permissionDefaultView(ctx: HostContext, file: string) {
  const catalog = permissionView(ctx, '')
  const saved = readPermissionDefault(file)
  const options = catalog.defaultOptions.filter(option => !RESERVED.has(option.value))
  const allowed = allowedPresets(options)
  const ignoredStored = saved.ignoredStored || (saved.stored !== null && !allowed.includes(saved.stored))
  const defaultPreset = catalog.available ? resolveDefaultPreset(saved.stored, allowed) : ''
  return {
    available: catalog.available,
    defaultPreset,
    stored: saved.stored,
    ignoredStored,
    options,
    productDefault: PRODUCT_DEFAULT_PRESET,
    scope: 'new-main-session' as const,
    hostDefault: catalog.defaultPreset,
  }
}

export function setDefaultPermission(ctx: HostContext, file: string, name: string): ToolPayload {
  if (typeof name !== 'string' || name === '' || RESERVED.has(name)) {
    return toolError(
      'VALIDATION',
      'A configured preset is required. Auto and custom cannot be the default for new sessions.',
    )
  }
  const catalog = permissionView(ctx, '')
  if (!catalog.available) {
    return toolError('UNAVAILABLE', 'Official permission presets are not composed on this host.')
  }
  const allowed = new Set(allowedPresets(catalog.defaultOptions))
  if (!allowed.has(name)) {
    return toolError('VALIDATION', 'That preset is not a configured permission mode.')
  }
  const { body } = readBody(file)
  writeBody(file, { ...body, defaultPreset: name })
  return { ok: true, ...permissionDefaultView(ctx, file) }
}

/** Remember a workbench-created main session until its first live permission write. */
export function rememberFreshMain(file: string, sessionId: string) {
  if (!MAIN_SESSION.test(sessionId)) return false
  const { body } = readBody(file)
  const pending = pendingOf(body.pending)
  if (pending.includes(sessionId)) return true
  writeBody(file, { ...body, pending: [...pending, sessionId] })
  return true
}

/** An explicit per-session choice wins over the global default. */
export function forgetPending(file: string, sessionId: string) {
  const { body } = readBody(file)
  const pending = pendingOf(body.pending)
  if (!pending.includes(sessionId)) return false
  writeBody(file, { ...body, pending: pending.filter(id => id !== sessionId) })
  return true
}

function consumePending(file: string, sessionId: string) {
  const { body } = readBody(file)
  const pending = pendingOf(body.pending)
  if (!pending.includes(sessionId)) return false
  writeBody(file, { ...body, pending: pending.filter(id => id !== sessionId) })
  return true
}

function restorePending(file: string, sessionId: string) {
  const { body } = readBody(file)
  const pending = pendingOf(body.pending)
  if (pending.includes(sessionId)) return
  writeBody(file, { ...body, pending: [...pending, sessionId] })
}

/**
 * Apply the configured default once, through the official preset setter.
 * A session that is not pending is not touched, so a later change to the
 * global default does not rewrite it.
 */
export function applyFreshMainPermission(
  ctx: HostContext,
  file: string,
  sessionId: string,
  isBot: (sessionId: string) => boolean,
): { applied: boolean; reason: string; preset?: string } {
  if (!MAIN_SESSION.test(sessionId) || !isBot(sessionId)) return { applied: false, reason: 'not-main' }
  if (!consumePending(file, sessionId)) return { applied: false, reason: 'not-pending' }
  const view = permissionDefaultView(ctx, file)
  if (!view.available || view.defaultPreset === '') {
    restorePending(file, sessionId)
    return { applied: false, reason: view.available ? 'unresolved' : 'unavailable' }
  }
  const result = setPermission(ctx, sessionId, view.defaultPreset)
  if (result.ok === false) {
    if (result.code === 'NOT_FOUND' || result.code === 'UNAVAILABLE') restorePending(file, sessionId)
    return { applied: false, reason: 'rejected' }
  }
  return { applied: true, reason: 'applied', preset: view.defaultPreset }
}
