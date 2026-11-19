/**
 * Host adapter over the native DSH inbox. The durable pending queue is
 * agent.followup(), which appends agent/inbox/spliced and wakes a later turn.
 * This module does not keep a second execution queue.
 */

import type { HostContext } from './host.ts'
import {
  createLogSource,
  logHasMessage as eventsHaveMessage,
  spliceSeq as seqOfSplice,
  type LogEvent,
} from './log/source.ts'
import { workerFileSetup } from './work-child.ts'

const handles = new Map()
const loading = new Map()

/**
 * An agent already entered in this process. Reading must not call `resume`:
 * resume announces `session/created`, and disposing that handle announces
 * `session/disposed`, which the native session list treats as removal.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 */
export function liveAgent(ctx: HostContext, sessionId: string) {
  try {
    const live = ctx.agents?.get?.(sessionId)
    if (live) return live
  } catch {
    /* not entered */
  }
  return handles.get(sessionId)?.agent ?? null
}

/**
 * Close a session this module resumed, so its writer drains before a hard delete.
 * A session owned by another fiber is left alone.
 * @param {string} sessionId
 */
export async function releaseLoadedAgent(sessionId: string) {
  const pending = loading.get(sessionId)
  if (pending) {
    try {
      await pending
    } catch {
      return
    }
  }
  const owned = handles.get(sessionId)
  if (!owned || typeof owned.dispose !== 'function') return
  await owned.dispose()
  if (handles.get(sessionId) === owned) handles.delete(sessionId)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 */
export async function loadAgent(ctx: HostContext, sessionId: string) {
  const live = ctx.agents.get(sessionId)
  if (live) return { agent: live, owned: false }
  const owned = handles.get(sessionId)
  if (owned) return { agent: owned.agent, owned: true }
  const pending = loading.get(sessionId)
  if (pending) return pending
  const job = ctx.agents
    .resume({
      resumeSessionId: sessionId,
      ...(sessionId.startsWith('worker-') ? { setup: workerFileSetup(ctx, null) } : {}),
    })
    .then((handle: any) => {
      handles.set(sessionId, handle)
      loading.delete(sessionId)
      return { agent: handle.agent, owned: true }
    })
    .catch((error: any) => {
      loading.delete(sessionId)
      throw error
    })
  loading.set(sessionId, job)
  return job
}

/**
 * Follow-up into the native next-turn inbox, then flush. Flush failure does
 * not by itself mean the append is durable. session/event is not the boundary.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {string} messageId
 * @param {string} text
 */
export async function followupDurable(ctx: HostContext, sessionId: string, messageId: string, text: string) {
  if (process.env.SESSION_FOUNDATIONS_CRASH_BEFORE_FLUSH === '1') {
    const loaded = await loadAgent(ctx, sessionId)
    loaded.agent.followup(userMessage(messageId, text))
    process.exit(97)
  }
  return deliverUser(ctx, sessionId, messageId, text, 'followup')
}

/**
 * Steering for the nearest step. On a running worker the host aborts first,
 * so this call lands after the abort and wakes the next turn. An idle worker
 * starts a turn immediately.
 */
export async function steerDurable(ctx: HostContext, sessionId: string, messageId: string, text: string) {
  return deliverUser(ctx, sessionId, messageId, text, 'steer')
}

async function deliverUser(
  ctx: HostContext,
  sessionId: string,
  messageId: string,
  text: string,
  method: 'followup' | 'steer',
) {
  const loaded = await loadAgent(ctx, sessionId)
  const agent = loaded.agent
  try {
    agent[method](userMessage(messageId, text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('already pending')) throw error
  }
  let seq: number | null = null
  try {
    seq = seqOfSplice((await createLogSource(ctx).read(sessionId, -1)).events, messageId)
  } catch {
    seq = spliceSeq(agent.session, messageId)
  }
  let flushed = false
  let flushError = ''
  try {
    flushed = (await ctx.sessions!.flush(agent.session)) === true
  } catch (error) {
    flushError = error instanceof Error ? error.message : String(error)
  }
  return {
    ok: flushed && seq != null,
    ambiguous: !flushed,
    seq,
    error: flushError,
    target: method === 'steer' ? 'next-step' : 'next-turn',
    wakeup: true,
  }
}

/**
 * @param {{ snapshotEvents?: () => Array<{ type?: string, seq?: number, data?: { inserted?: Array<{ id?: string }> } }> }} session
 * @param {string} messageId
 */
export function logHasMessage(session: { snapshotEvents?: () => LogEvent[] } | readonly LogEvent[], messageId: string) {
  const events = Array.isArray(session)
    ? session
    : 'snapshotEvents' in session
      ? (session.snapshotEvents?.() ?? [])
      : []
  return eventsHaveMessage(events, messageId)
}

/**
 * Live snapshot when the agent is already entered. Otherwise a read-only
 * stored log, which does not enter the session or take the write claim.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @returns {Promise<Array<{ type?: string, seq?: number, data?: { id?: string, message?: { id?: string }, inserted?: Array<{ id?: string }> } }>>}
 */
export async function sessionEvents(ctx: HostContext, sessionId: string): Promise<LogEvent[]> {
  const { events } = await createLogSource(ctx).read(sessionId, -1)
  return events
}

/**
 * @param {{ snapshotEvents?: () => Array<{ type?: string, seq?: number, data?: { inserted?: Array<{ id?: string }> } }> }} session
 * @param {string} messageId
 */
export function spliceSeq(session: { snapshotEvents?: () => LogEvent[] }, messageId: string) {
  const events = session.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'agent/inbox/spliced' && insertedIds(event).includes(messageId)) return event.seq ?? null
  }
  return null
}

/**
 * Drop a still-pending native inbox item. Claimed messages are left alone.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {string} messageId
 */
export async function removePending(ctx: HostContext, sessionId: string, messageId: string) {
  const live = ctx.agents.get(sessionId) ?? handles.get(sessionId)?.agent
  if (!live?.inbox?.remove) return false
  return live.inbox.remove(messageId) === true
}

/**
 * @param {string} messageId
 * @param {string} text
 */
export function userMessage(messageId: string, text: string) {
  return Object.freeze({
    id: messageId,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * @param {{ data?: { inserted?: Array<{ id?: string }> } }} event
 */
function insertedIds(event: LogEvent) {
  const data =
    event.data && typeof event.data === 'object' ? (event.data as { inserted?: Array<{ id?: string }> }) : null
  const inserted = data?.inserted
  if (!Array.isArray(inserted)) return []
  return inserted.map(message => message?.id).filter((id): id is string => typeof id === 'string')
}

/**
 * @param {{ data?: { id?: string, message?: { id?: string } } }} event
 */
function messageIdOf(event: LogEvent) {
  const data =
    event.data && typeof event.data === 'object' ? (event.data as { id?: string; message?: { id?: string } }) : null
  return data?.id ?? data?.message?.id ?? ''
}
