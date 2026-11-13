/** Official tool-permission approval card payload. */

export type ToolApprovalView = {
  requestId: string
  sessionId: string
  toolName: string
  callId?: string
  reason: string
  displayReason?: { en: string; [locale: string]: string }
  state: 'open' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
}
