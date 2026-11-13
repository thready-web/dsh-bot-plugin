/** Official authorization and credential settings. */

const en = {
  'auth.title': 'Authorization',
  'auth.open': 'Credentials',
  'auth.empty': 'No authorization flows are available.',
  'auth.start': 'Start',
  'auth.writeVault': 'Write to vault',
  'auth.cancel': 'Cancel',
  'auth.secretMask': '••••••••',
  'auth.unavailable': 'Official authorization is not available on this host.',
  'auth.failed': 'Authorization could not be completed.',
  'auth.close': 'Close',
} as const

const zh: Record<keyof typeof en, string> = {
  'auth.title': '授权',
  'auth.open': '凭据',
  'auth.empty': '当前没有可进行的授权流程。',
  'auth.start': '开始',
  'auth.writeVault': '写入保险库',
  'auth.cancel': '取消',
  'auth.secretMask': '••••••••',
  'auth.unavailable': '此主机未提供官方授权。',
  'auth.failed': '授权未能完成。',
  'auth.close': '关闭',
}

export const authorization = { en, zh }
