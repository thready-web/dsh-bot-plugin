/** Pure send rules for the composer. Persistence and server idempotency stay outside this module. */

export const MESSAGE_LIMIT = 8000
export const SEND_TIMEOUT_MS = 15_000

export type SendOutcome = 'accepted' | 'failed' | 'unknown'

/** A phone or a narrow viewport inserts a newline. A desktop keyboard sends. */
export function enterInsertsNewline(input: { coarse: boolean; narrow: boolean }): boolean {
  return input.coarse || input.narrow
}

/** IME composition must confirm the candidate instead of sending. */
export function isComposingKey(input: { isComposing: boolean; key: string; keyCode: number }): boolean {
  return input.isComposing || input.key === 'Process' || input.keyCode === 229
}

/**
 * Clear the box only when it still holds the snapshot that was just sent.
 * Typing that landed during the save stays in the box.
 */
export function draftAfterSend(current: string, snapshot: string): string {
  return current === snapshot ? '' : current
}

/** Later sends get later sequence numbers, so the timeline keeps click order. */
export function nextSendSeq(maxExisting: number, localCount: number): number {
  return maxExisting + localCount
}

/**
 * Classify one POST /tasks result.
 * A reused key is success only when the stored task was actually accepted.
 * A timeout or a missing status stays unknown so the same key can be checked again.
 */
export function classifySend(input: {
  status: number
  reused?: boolean
  taskStatus?: string
  aborted?: boolean
}): SendOutcome {
  if (input.aborted || input.status === 0) return 'unknown'
  if (input.status === 202) return 'accepted'
  if (input.status === 200 && input.reused === true) {
    if (input.taskStatus === 'failed' || input.taskStatus === 'blocked_unconfigured') return 'failed'
    if (
      input.taskStatus === 'accepted' ||
      input.taskStatus === 'cancel_requested' ||
      input.taskStatus === 'cancelled'
    ) {
      return 'accepted'
    }
    return 'unknown'
  }
  if (input.status >= 400 && input.status < 600) return 'failed'
  return 'unknown'
}
