/**
 * Sorted-key JSON used as the event-log canonical form.
 * Matches the plugin transport canonical so a backup can be verified
 * against the same bytes the live log APIs would emit.
 * NDJSON is one event per line, so an append only changes the tail.
 */

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export interface NdjsonLine {
  seq: number
  start: number
  end: number
}

export function eventNdjson(events: readonly unknown[]): { bytes: Buffer; lines: NdjsonLine[] } {
  const parts: Buffer[] = []
  const lines: NdjsonLine[] = []
  let offset = 0
  for (const event of events) {
    const seq =
      event && typeof event === 'object' && typeof (event as { seq?: unknown }).seq === 'number'
        ? (event as { seq: number }).seq
        : lines.length
    const line = Buffer.from(`${stableStringify(event)}\n`, 'utf8')
    lines.push({ seq, start: offset, end: offset + line.length })
    parts.push(line)
    offset += line.length
  }
  return { bytes: parts.length ? Buffer.concat(parts) : Buffer.alloc(0), lines }
}
