/** Bot turn status and inter-bot inbox copy. */

const en = {
  'bot.waiting': 'Waiting',
  'bot.running': 'Running',
  'bot.stopped': 'Stopped',
  'bot.stoppedBackground': 'This turn stopped. Background work is still running.',
  'bot.retry': 'Retry',
  'bot.thinking': 'Thinking',
  'bot.replying': 'Replying',
  'bot.processed': 'Done',
  'bot.untitled': 'Untitled',
  'inbox.received': 'sent a message',
  'inbox.open': 'Open bot messages, {who}: {line}',
  'inbox.lead':
    "These are the words bots sent each other. They do not include the other bot's persona, memory, or permissions.",
  'inbox.empty': 'No bot messages yet.',
  'inbox.other': 'another bot',
  'inbox.sentTo': 'Sent to {name}',
  'inbox.hop': 'Hop {hop}',
  'inbox.source': 'Source',
} as const

const zh: Record<keyof typeof en, string> = {
  'bot.waiting': '等待操作',
  'bot.running': '运行中',
  'bot.stopped': '已停下',
  'bot.stoppedBackground': '这一轮已经停下。后台还在跑。',
  'bot.retry': '重试',
  'bot.thinking': '正在想',
  'bot.replying': '正在回复',
  'bot.processed': '已处理',
  'bot.untitled': '未命名',
  'inbox.received': '发来一条消息',
  'inbox.open': '打开 BOT 消息，{who}：{line}',
  'inbox.lead': '这里是 BOT 之间传来的正文，不带对方的人格、记忆或权限。',
  'inbox.empty': '还没有 BOT 消息。',
  'inbox.other': '另一个 BOT',
  'inbox.sentTo': '发给 {name}',
  'inbox.hop': '第 {hop} 跳',
  'inbox.source': '来源',
}

export const bot = { en, zh }
