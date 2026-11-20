/** Read the delete progress stream. One JSON object per line. */

export interface DeleteEvent {
  phase: string
  percent: number
  error?: string
  deletedSessionIds?: string[]
}

export function parseDeleteEvent(line: string): DeleteEvent | null {
  const text = line.trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text) as Partial<DeleteEvent>
    if (!parsed || typeof parsed.phase !== 'string' || typeof parsed.percent !== 'number') return null
    return {
      phase: parsed.phase,
      percent: parsed.percent,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      ...(Array.isArray(parsed.deletedSessionIds)
        ? { deletedSessionIds: parsed.deletedSessionIds.filter(id => typeof id === 'string') }
        : {}),
    }
  } catch {
    return null
  }
}

export async function readDeleteEvents(
  response: Response,
  onEvent: (event: DeleteEvent) => void,
): Promise<DeleteEvent | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    return applyLines(text, onEvent)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let last: DeleteEvent | null = null
  while (true) {
    const step = await reader.read()
    buffer += decoder.decode(step.value ?? new Uint8Array(), { stream: !step.done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    last = applyLines(lines.join('\n'), onEvent) ?? last
    if (step.done) break
  }
  return applyLines(buffer, onEvent) ?? last
}

function applyLines(text: string, onEvent: (event: DeleteEvent) => void) {
  let last: DeleteEvent | null = null
  for (const line of text.split('\n')) {
    const event = parseDeleteEvent(line)
    if (!event) continue
    last = event
    onEvent(event)
  }
  return last
}
