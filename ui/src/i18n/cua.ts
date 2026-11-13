/** Official Computer Use system permissions and saved grants. */

const en = {
  'cua.title': 'Computer Use permissions',
  'cua.open': 'Computer Use',
  'cua.system': 'System permissions',
  'cua.accessibility': 'Accessibility',
  'cua.screenRecording': 'Screen recording',
  'cua.granted': 'Granted',
  'cua.missing': 'Not granted',
  'cua.request': 'Request',
  'cua.openSettings': 'Open system settings',
  'cua.grants': 'Always-allow list',
  'cua.blocked': 'Refused applications',
  'cua.revoke': 'Revoke',
  'cua.askAgain': 'Ask again',
  'cua.emptyGrants': 'No saved application grants.',
  'cua.emptyBlocked': 'No refused applications.',
  'cua.failed': 'Computer Use permissions could not be updated.',
  'cua.close': 'Close',
} as const

const zh: Record<keyof typeof en, string> = {
  'cua.title': '计算机使用权限',
  'cua.open': '计算机使用',
  'cua.system': '系统权限',
  'cua.accessibility': '辅助功能',
  'cua.screenRecording': '屏幕录制',
  'cua.granted': '已授予',
  'cua.missing': '未授予',
  'cua.request': '请求',
  'cua.openSettings': '打开系统设置',
  'cua.grants': '始终允许列表',
  'cua.blocked': '已拒绝的应用',
  'cua.revoke': '撤销',
  'cua.askAgain': '再次询问',
  'cua.emptyGrants': '没有已保存的应用授权。',
  'cua.emptyBlocked': '没有已拒绝的应用。',
  'cua.failed': '计算机使用权限未能更新。',
  'cua.close': '关闭',
}

export const cua = { en, zh }
