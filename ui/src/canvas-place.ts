export interface CanvasPlaceItem {
  id: string
  title: string
  ticketId: string | null
  previewRevision: number | null
  stableRevision: number | null
}

/**
 * Every delivered canvas stays on the ticket that produced it, including the newest.
 * A card is rendered only when that ticket's dispatch message is in the loaded transcript.
 * A preview that is still being written stays hidden.
 */
export function placeCanvases<T extends CanvasPlaceItem>(
  items: readonly T[],
  tickets: readonly { id: string; status: string }[],
): { byTicket: Map<string, T>; loose: T[] } {
  const status = new Map(tickets.map(ticket => [ticket.id, ticket.status]))
  const byTicket = new Map<string, T>()
  const loose: T[] = []
  for (const item of items) {
    if (!canvasDelivered(item, status)) continue
    if (!item.ticketId) {
      loose.push(item)
      continue
    }
    byTicket.set(item.ticketId, item)
  }
  return { byTicket, loose }
}

function canvasDelivered(item: CanvasPlaceItem, status: Map<string, string>) {
  if (item.previewRevision == null) return false
  if (!item.ticketId) return true
  const state = status.get(item.ticketId)
  if (state == null) return true
  return state === 'delivered'
}
