import type { LogEvent, LogSource } from '../../src/bot-session-snapshot/types.ts'

export function event(seq: number, type = 'user/message'): LogEvent {
  return { type, seq, time: 1_000 + seq, data: { id: `m${seq}`, text: `hello ${seq}` } }
}

export function sequence(count: number): LogEvent[] {
  return Array.from({ length: count }, (_, index) => event(index))
}

export function memorySource(logs: Record<string, LogEvent[]>, options: { delay?: number } = {}): LogSource {
  return {
    async head(sessionId) {
      const events = logs[sessionId] ?? []
      return events.length === 0 ? -1 : events[events.length - 1]!.seq
    },
    async read(sessionId, afterSeq, throughSeq) {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
      const all = [...(logs[sessionId] ?? [])].sort((left, right) => left.seq - right.seq)
      const head = all.length === 0 ? -1 : all[all.length - 1]!.seq
      const end = throughSeq == null ? head : Math.min(throughSeq, head)
      const events = all.filter(item => item.seq > afterSeq && item.seq <= end)
      return { events, throughSeq: end }
    },
  }
}
