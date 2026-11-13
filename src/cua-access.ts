/**
 * Official Computer Use access controls, exposed only when `ctx.cuaAccess`
 * is composed. Runtime app consent still uses the approval-intent card in
 * the session; this surface manages system permissions and saved grants.
 */
import { toolError, type ToolPayload } from './errors.ts'
import type { HostContext } from './host.ts'

const SYSTEM_PERMISSIONS = new Set(['accessibility', 'screenRecording'])

function service(ctx: HostContext) {
  return ctx.get?.('cuaAccess')
}

export async function cuaSnapshot(ctx: HostContext, locale = 'en'): Promise<Record<string, unknown>> {
  const access = service(ctx)
  if (!access) return { available: false }
  try {
    const [systemStatus, applications, ptcConfiguration, applicationIcons] = await Promise.all([
      typeof access.systemStatus === 'function' ? access.systemStatus() : null,
      typeof access.applications === 'function' ? access.applications() : null,
      typeof access.ptcConfiguration === 'function' ? access.ptcConfiguration() : null,
      typeof access.applicationIcons === 'function' ? access.applicationIcons() : null,
    ])
    return {
      available: true,
      locale,
      systemStatus,
      applications,
      ptcConfiguration,
      applicationIcons,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Computer Use access could not be read.'
    return { available: true, error: message }
  }
}

export async function cuaAction(
  ctx: HostContext,
  input: { action?: string; permission?: string; id?: string; locale?: string },
): Promise<ToolPayload> {
  const access = service(ctx)
  if (!access) return toolError('UNAVAILABLE', 'Computer Use is not installed on this host.')
  const locale = typeof input.locale === 'string' && input.locale !== '' ? input.locale : 'en'
  const action = input.action
  try {
    if (action === 'requestPermission') {
      if (!SYSTEM_PERMISSIONS.has(String(input.permission))) {
        return toolError('VALIDATION', 'A supported system permission is required.')
      }
      const systemStatus = await access.requestPermission(input.permission, locale)
      return { ok: true, systemStatus }
    }
    if (action === 'openSettings') {
      if (!SYSTEM_PERMISSIONS.has(String(input.permission))) {
        return toolError('VALIDATION', 'A supported system permission is required.')
      }
      await access.openSettings(input.permission, locale)
      return { ok: true }
    }
    if (action === 'revoke') {
      if (typeof input.id !== 'string' || input.id === '')
        return toolError('VALIDATION', 'An application id is required.')
      await access.revoke(input.id)
      return { ok: true }
    }
    if (action === 'retryApproval') {
      if (typeof input.id !== 'string' || input.id === '')
        return toolError('VALIDATION', 'An application id is required.')
      await access.retryApproval(input.id)
      return { ok: true }
    }
    if (action === 'enablePersistentPtc') {
      await access.enablePersistentPtc()
      return { ok: true }
    }
    return toolError('VALIDATION', 'An official Computer Use action is required.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The Computer Use action could not be completed.'
    return toolError('UNAVAILABLE', message)
  }
}
