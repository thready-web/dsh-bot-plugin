/** Event-log backup panel. */

const en = {
  'snapshot.open': 'Snapshot',
  'snapshot.title': 'Event log snapshot',
  'snapshot.close': 'Close',
  'snapshot.create': 'Create snapshot',
  'snapshot.creating': 'Creating snapshot…',
  'snapshot.refresh': 'Refresh',
  'snapshot.empty': 'No snapshots for this session yet.',
  'snapshot.loading': 'Loading snapshots…',
  'snapshot.failed': 'Could not load snapshots.',
  'snapshot.createFailed': 'Could not create a snapshot.',
  'snapshot.worker': 'Worker sessions are not snapshotted. Open the main Bot session.',
  'snapshot.ordinary': 'Snapshots are only available for a main Bot session.',
  'snapshot.scope':
    'This saves the official event log only. It does not include Memory, Worker state, workspace files, or external side effects. A snapshot is not a restore into a running session.',
  'snapshot.sensitive':
    'A snapshot may contain private messages and tool output. Keep it under the same private access as this bot.',
  'snapshot.cutoff': 'Through seq {seq}',
  'snapshot.count': '{count} events',
  'snapshot.downloadLog': 'Download log',
  'snapshot.downloadArchive': 'Download archive',
  'snapshot.checksum': 'SHA-256 {hash}',
}

const zh: Record<keyof typeof en, string> = {
  'snapshot.open': '快照',
  'snapshot.title': '事件日志快照',
  'snapshot.close': '关闭',
  'snapshot.create': '创建快照',
  'snapshot.creating': '正在创建快照…',
  'snapshot.refresh': '刷新',
  'snapshot.empty': '此会话还没有快照。',
  'snapshot.loading': '正在读取快照…',
  'snapshot.failed': '无法读取快照列表。',
  'snapshot.createFailed': '无法创建快照。',
  'snapshot.worker': '不能为 Worker 会话创建快照。请打开对应的主 Bot 会话。',
  'snapshot.ordinary': '快照仅适用于主 Bot 会话。',
  'snapshot.scope':
    '快照只保存官方事件日志，不包含 Memory、Worker 状态、工作区文件或外部副作用。快照不会写回或覆盖正在运行的会话。',
  'snapshot.sensitive': '快照可能包含私信和工具输出，请按与本 Bot 相同的私有权限保管。',
  'snapshot.cutoff': '截止 seq {seq}',
  'snapshot.count': '{count} 条事件',
  'snapshot.downloadLog': '下载日志',
  'snapshot.downloadArchive': '下载归档',
  'snapshot.checksum': 'SHA-256 {hash}',
}

export const snapshot = { en, zh }
