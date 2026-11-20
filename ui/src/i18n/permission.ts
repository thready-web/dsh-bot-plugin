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
  'permission.defaultTitle': 'Default for new sessions',
  'permission.defaultHelp':
    'Fully allow is the starting default. It gives a new main session broad file access and runs tools without an approval prompt. Saving a choice here changes only main sessions created afterward. A session that already exists, including one whose permission you set by hand, keeps that permission.',
  'permission.confirmDefaultFull':
    'New main sessions will start with full access. This is broad: files outside the workspace can be changed, and approval prompts are skipped.',
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
  'permission.defaultTitle': '新会话的默认权限',
  'permission.defaultHelp':
    '一开始的默认是完全允许。新的主会话会得到很宽的文件访问，工具执行前不再询问。在这里保存的选择只作用于之后新建的主会话。已经存在的会话，包括你单独改过权限的会话，都保持原来的权限。',
  'permission.confirmDefaultFull':
    '之后新建的主会话会从完全允许开始。这是很宽的权限：工作区以外的文件也可以改，并且不再弹出审批。',
}

export const permission = { en, zh }
