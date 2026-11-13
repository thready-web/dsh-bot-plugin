/** Human labels for official permission-preset ids. Submitted values stay the official ids. */
import type { Copy } from './i18n/index.ts'

export function presetLabel(preset: string, t: Copy): string {
  if (preset === 'workspace-write') return t('permission.preset.workspaceWrite')
  if (preset === 'read-only' || preset === 'readonly') return t('permission.preset.readOnly')
  if (preset === 'danger-full-access') return t('permission.preset.fullAccess')
  if (preset === 'auto') return t('permission.preset.auto')
  return preset
}

export function presetDisplayName(value: string, officialName: string | undefined, t: Copy): string {
  const mapped = presetLabel(value, t)
  if (mapped !== value) return mapped
  return officialName && officialName !== '' ? officialName : value
}
