import { randomUUID } from 'node:crypto'

/**
 * In-process stand-in for the native inbox and agents.create.
 * It is not a DSH process and not a real model.
 */
export function createMockWorld() {
  /** @type {Map<string, { nextTurn: Array<{ id: string, text: string }>, events: Array<Record<string, unknown>>, seq: number, turn: number }>} */
  const sessions: Map<
    string,
    { nextTurn: Array<{ id: string; text: string }>; events: Array<Record<string, any>>; seq: number; turn: number }
  > = new Map()
  const calls: Array<Record<string, unknown>> = []
  const cancels: Array<{ sessionId: string; keepInbox: boolean; reason?: string }> = []
  const pushes: Array<{ sessionId: string; messageId: string; text: string }> = []
  const state = {
    failCreate: false,
    flushMode: 'accepted',
  }

  return {
    calls,
    cancels,
    pushes,
    state,
    session,
    pendingIds(sessionId: string) {
      return session(sessionId).nextTurn.map(item => item.id)
    },
    events(sessionId: string) {
      return session(sessionId).events.map(event => ({ ...event }))
    },
    postUser(sessionId: string, text: string) {
      const id = randomUUID()
      const slot = session(sessionId)
      slot.nextTurn.push({ id, text })
      append(slot, 'agent/inbox/spliced', { inserted: [{ id }], target: 'next-turn' })
      return id
    },
    claim(sessionId: string) {
      const slot = session(sessionId)
      const message = slot.nextTurn.shift()
      if (!message) return null
      slot.turn += 1
      append(slot, 'agent/inbox/claimed', { id: message.id, turn: slot.turn })
      return { messageId: message.id, turn: slot.turn, text: message.text }
    },
    seeUser(sessionId: string, messageId: string, turn: number) {
      const slot = session(sessionId)
      return append(slot, 'user/message', { id: messageId, turn, message: { id: messageId } })
    },
    endTurn(sessionId: string, turn: number, reasonKind: string) {
      const slot = session(sessionId)
      return append(slot, 'turn/end', { turn, reason: { kind: reasonKind } })
    },
    toolCall(sessionId: string, name: string, args: unknown) {
      const slot = session(sessionId)
      return append(slot, 'tool/call', { name, arguments: args })
    },
    assistant(sessionId: string, text: string) {
      const slot = session(sessionId)
      return append(slot, 'assistant/message', { text, message: { content: [{ type: 'text', text }] } })
    },
    forgetLog(sessionId: string, messageId: string) {
      const slot = session(sessionId)
      slot.events = slot.events.filter(
        event =>
          !(
            event.type === 'agent/inbox/spliced' &&
            Array.isArray(event.data?.inserted) &&
            event.data.inserted.some((item: any) => item?.id === messageId)
          ),
      )
      slot.nextTurn = slot.nextTurn.filter(item => item.id !== messageId)
    },
    async createChild(spec: { sessionId: string }) {
      calls.push({ ...spec })
      if (state.failCreate) throw new Error('create failed')
      session(spec.sessionId)
      return spec.sessionId
    },
    async push(sessionId: string, messageId: string, text: string) {
      pushes.push({ sessionId, messageId, text })
      if (state.flushMode === 'fail') return { ok: false, ambiguous: false, seq: null, error: 'push-failed' }
      if (state.flushMode === 'ambiguous') return { ok: false, ambiguous: true, seq: null, error: 'flush-unconfirmed' }
      const slot = session(sessionId)
      if (!slot.nextTurn.some(item => item.id === messageId)) slot.nextTurn.push({ id: messageId, text })
      const event = append(slot, 'agent/inbox/spliced', { inserted: [{ id: messageId }], target: 'next-turn' })
      return { ok: true, ambiguous: false, seq: event.seq, target: 'next-turn' }
    },
    async logHas(sessionId: string, messageId: string) {
      return session(sessionId).events.some(
        event =>
          event.type === 'agent/inbox/spliced' &&
          Array.isArray(event.data?.inserted) &&
          event.data.inserted.some((item: any) => item?.id === messageId),
      )
    },
    async remove(sessionId: string, messageId: string) {
      const slot = session(sessionId)
      const index = slot.nextTurn.findIndex(item => item.id === messageId)
      if (index < 0) return false
      slot.nextTurn.splice(index, 1)
      return true
    },
    async cancel(sessionId: string, options: { keepInbox?: boolean; reason?: string } | null) {
      cancels.push({
        sessionId,
        keepInbox: options?.keepInbox === true,
        ...(typeof options?.reason === 'string' ? { reason: options.reason } : {}),
      })
    },
    async snapshot(sessionId: string) {
      return session(sessionId).events.map(event => ({ ...event, data: event.data }))
    },
    hasSession(sessionId: string) {
      return sessions.has(sessionId)
    },
    dropChild(sessionId: string) {
      sessions.delete(sessionId)
    },
  }

  /**
   * @param {string} sessionId
   */
  function session(sessionId: string) {
    let slot = sessions.get(sessionId)
    if (!slot) {
      slot = { nextTurn: [], events: [], seq: 0, turn: 0 }
      sessions.set(sessionId, slot)
    }
    return slot
  }

  /**
   * @param {{ events: Array<Record<string, unknown>>, seq: number }} slot
   * @param {string} type
   * @param {Record<string, unknown>} data
   */
  function append(slot: { events: Array<Record<string, any>>; seq: number }, type: string, data: Record<string, any>) {
    slot.seq += 1
    const event: Record<string, any> = { type, seq: slot.seq, data }
    slot.events.push(event)
    return event
  }
}
