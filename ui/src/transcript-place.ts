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
 * The dispatch message already loaded for this canvas.
 * A canvas with no such message stays hidden. It is not parked on the latest block.
 */
export function canvasMessageId(ticketId: string | null, anchors: ReadonlyMap<string, string>): string | null {
  if (!ticketId) return null
  return anchors.get(ticketId) ?? null
}

export interface SeqBlock {
  type: string
  segment?: { seq?: number }
  segments?: readonly { seq?: number }[]
}

/** Latest session seq on a block. Empty turn blocks have none. */
export function blockEndSeq(block: SeqBlock): number | null {
  if (block.type === 'user') return typeof block.segment?.seq === 'number' ? block.segment.seq : null
  if (block.type !== 'turn' || !block.segments) return null
  let max = -1
  for (const segment of block.segments) {
    if (typeof segment.seq === 'number' && segment.seq > max) max = segment.seq
  }
  return max < 0 ? null : max
}

/**
 * Seq of the last retry or the terminal failure.
 * A timed-out turn has no assistant segment, so this seq is what keeps its panel
 * after the user line that started it and before the next chat line.
 */
export function turnAnchorSeq(
  failure: { seq?: number } | undefined,
  attempts: readonly { seq?: number }[] | undefined,
): number | undefined {
  let max: number | undefined
  if (typeof failure?.seq === 'number') max = failure.seq
  for (const attempt of attempts ?? []) {
    if (typeof attempt.seq === 'number' && (max == null || attempt.seq > max)) max = attempt.seq
  }
  return max
}

/** Insert turns that produced only retries or a failure into the chat, in seq order. */
export function placeOrphanTurns<T extends SeqBlock>(
  blocks: readonly T[],
  orphans: readonly { seq?: number; block: T }[],
): T[] {
  const next = [...blocks]
  const ordered = [...orphans].sort((a, b) => (a.seq ?? Number.POSITIVE_INFINITY) - (b.seq ?? Number.POSITIVE_INFINITY))
  for (const orphan of ordered) {
    let index = next.length
    if (typeof orphan.seq === 'number') {
      for (let i = 0; i < next.length; i++) {
        const end = blockEndSeq(next[i]!)
        if (end != null && end > orphan.seq) {
          index = i
          break
        }
      }
    }
    next.splice(index, 0, orphan.block)
  }
  return next
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
