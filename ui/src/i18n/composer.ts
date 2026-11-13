/** Composer placeholders, mentions, and send actions. */

const en = {
  'composer.mention': 'Mention a bot',
  'composer.noBot': 'No matching bot',
  'composer.interrupt': 'Sending interrupts this reply',
  'composer.mentionHint': 'Message, or type @ to mention another bot',
  'composer.task': 'Message, or describe a task',
  'composer.pick': 'Choose a session',
  'composer.add': 'Add a file or a command',
  'composer.command': 'Insert a command',
  'composer.filesLater': 'Attaching files is not available yet.',
  'composer.cancel': 'Cancel',
  'composer.send': 'Send',
  'composer.notSent': 'The task was not sent.',
  'composer.supplyFailed': 'Not sent.',
} as const

const zh: Record<keyof typeof en, string> = {
  'composer.mention': '提及 BOT',
  'composer.noBot': '没有匹配的 BOT',
  'composer.interrupt': '发送会打断这一句',
  'composer.mentionHint': '发消息，输入 @ 提及另一个 BOT',
  'composer.task': '发消息，或描述一个任务',
  'composer.pick': '选择一个会话',
  'composer.add': '添加文件或调用指令',
  'composer.command': '调用指令',
  'composer.filesLater': '附带文件还不可用。',
  'composer.cancel': '取消',
  'composer.send': '发送',
  'composer.notSent': '任务没有发送。',
  'composer.supplyFailed': '没有送出。',
}

export const composer = { en, zh }
