/** Official session permission-preset settings. */

const en = {
  'permission.title': 'Permissions',
  'permission.open': 'Session permissions',
  'permission.current': 'Current preset',
  'permission.confirmTitle': 'Confirm this permission',
  'permission.confirmFull': 'Give this session full access?',
  'permission.confirmAuto': 'Turn on Auto for this session?',
  'permission.confirm': 'Confirm',
  'permission.cancel': 'Cancel',
  'permission.unavailable': 'Official permission presets are not available on this host.',
  'permission.failed': 'The permission could not be changed.',
  'permission.close': 'Close',
  'permission.preset.readOnly': 'Read Only',
  'permission.preset.workspaceWrite': 'Workspace Write',
  'permission.preset.fullAccess': 'Full access',
  'permission.preset.auto': 'Auto review',
} as const

const zh: Record<keyof typeof en, string> = {
  'permission.title': '权限',
  'permission.open': '会话权限',
  'permission.current': '当前预设',
  'permission.confirmTitle': '确认此项权限',
  'permission.confirmFull': '为此会话开启完全访问？',
  'permission.confirmAuto': '为此会话开启自动审阅？',
  'permission.confirm': '确认',
  'permission.cancel': '取消',
  'permission.unavailable': '此主机未提供官方权限预设。',
  'permission.failed': '权限未能更改。',
  'permission.close': '关闭',
  'permission.preset.readOnly': '只读',
  'permission.preset.workspaceWrite': '工作区可写',
  'permission.preset.fullAccess': '完全访问',
  'permission.preset.auto': '自动审阅',
}

export const permission = { en, zh }
