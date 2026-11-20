/**
 * Turns that produced only a failure or a retry keep their seq slot.
 * Cards are themselves log events, so their block seq is the event seq.
 */

export interface SeqBlock {
  type: string
  segment?: { seq?: number }
  segments?: readonly { seq?: number }[]
}

/** Latest session seq on a block. Empty turn blocks have none. */
export function blockEndSeq(block: SeqBlock): number | null {
  if (block.type === 'user' || block.type === 'card')
    return typeof block.segment?.seq === 'number' ? block.segment.seq : null
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
