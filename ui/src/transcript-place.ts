/**
 * Cards, approvals and canvases keep the slot they first occupied.
 * A later message only appends; it does not pull an earlier item downward.
 */

export interface ApprovalSpot {
  turn: number
  callId?: string
}

export function blockKey(block: { type: string; segment?: { id: string }; turn?: number }): string {
  if (block.type === 'user' && block.segment) return `user:${block.segment.id}`
  if (block.type === 'turn' && typeof block.turn === 'number') return `turn:${block.turn}`
  return 'start'
}

/** The one unanchored work card stays on the block where it first appeared. */
export function resolveFloatingWorks(
  shown: readonly { id: string }[],
  anchored: ReadonlySet<string>,
  pins: Map<string, string>,
  here: string,
): Map<string, string> {
  const visible = new Map<string, string>()
  for (const ticket of shown) {
    const key = pins.get(ticket.id)
    if (key) visible.set(ticket.id, key)
  }
  const first = shown[0]
  if (first && !pins.has(first.id) && !anchored.has(first.id)) {
    pins.set(first.id, here)
    visible.set(first.id, here)
  }
  return visible
}

/**
 * A canvas whose ticket is already on screen stays with that ticket.
 * Anything else is pinned to the block where it first appeared, and stays there.
 */
export function resolveLooseCanvases(
  canvases: readonly { id: string; ticketId: string | null }[],
  coveredTickets: ReadonlySet<string>,
  pins: Map<string, string>,
  here: string,
): Map<string, string> {
  const visible = new Map<string, string>()
  for (const canvas of canvases) {
    const pinned = pins.get(canvas.id)
    if (pinned) {
      visible.set(canvas.id, pinned)
      continue
    }
    if (canvas.ticketId && coveredTickets.has(canvas.ticketId)) continue
    pins.set(canvas.id, here)
    visible.set(canvas.id, here)
  }
  return visible
}

/** An approval sticks to its tool call, or to the turn where it first appeared. */
export function resolveApprovals(
  approvals: readonly { requestId: string; callId?: string }[],
  callTurn: ReadonlyMap<string, number>,
  pins: Map<string, ApprovalSpot>,
  latestTurn: number,
): Map<string, ApprovalSpot> {
  for (const approval of approvals) {
    if (pins.has(approval.requestId)) continue
    const matched = approval.callId ? callTurn.get(approval.callId) : undefined
    if (matched != null) pins.set(approval.requestId, { turn: matched, callId: approval.callId })
    else if (latestTurn >= 0) pins.set(approval.requestId, { turn: latestTurn })
  }
  const visible = new Map<string, ApprovalSpot>()
  for (const approval of approvals) {
    const spot = pins.get(approval.requestId)
    if (spot) visible.set(approval.requestId, spot)
  }
  return visible
}
