/** Official tool-permission approval cards (approval/request waterfall). */

const en = {
  'approval.title': 'Tool approval',
  'approval.allowOnce': 'Allow once',
  'approval.reject': 'Reject',
  'approval.waiting': 'Waiting for your answer',
  'approval.allowed': 'Allowed once',
  'approval.rejected': 'Rejected',
  'approval.cancelled': 'This request was cancelled.',
  'approval.failed': 'This request could not be completed.',
  'approval.submitFailed': 'The decision could not be submitted.',
} as const

const zh: Record<keyof typeof en, string> = {
  'approval.title': '工具许可',
  'approval.allowOnce': '允许一次',
  'approval.reject': '拒绝',
  'approval.waiting': '等待你的回答',
  'approval.allowed': '已允许一次',
  'approval.rejected': '已拒绝',
  'approval.cancelled': '这个请求已被取消。',
  'approval.failed': '这个请求未能完成。',
  'approval.submitFailed': '决定未能提交。',
}

export const approval = { en, zh }
