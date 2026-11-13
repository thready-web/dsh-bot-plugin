import { toolError, type ToolPayload } from './errors.ts'

const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  render(_args: unknown, value: unknown) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  },
}

/**
 * Bot tools plus the worker report. Execute checks the host session.
 * Model arguments never supply owner, attempt, or fence.
 * @param {ReturnType<typeof import('./work-worker.js').createWorkRuntime>} work
 * @param {import('./engine.js').Engine} engine
 */
export function workToolDefinitions(
  work: ReturnType<typeof import('./work-worker.ts').createWorkRuntime>,
  engine: import('./engine.ts').Engine,
) {
  return [
    tool(
      'foundations_dispatch',
      'Hand a non-trivial job to a worker session. Prefer this over doing the work with bash, write, edit, or an official subagent in the main session. Available only on a bot. status=accepted means received, and may wait for an execution slot. status=enqueued means it entered the execution queue, not that it has started. queued=true means it is waiting for a slot and will start automatically when one is free. The return value is never started. A BUDGET error means both the slot cap and the queue cap are full; do not start the job in the main session. ownerSessionId is ignored.',
      {
        type: 'object',
        properties: {
          briefing: { type: 'string' },
          idempotencyKey: { type: 'string' },
          budget: {
            type: 'object',
            description:
              'Time and token estimate for this ticket. When omitted, the host estimates from the task text. It cannot exceed the host ceiling.',
            properties: {
              wallMs: { type: 'integer', description: 'Expected maximum runtime in milliseconds.' },
              maxTokens: { type: 'integer', description: 'Expected maximum tokens.' },
            },
          },
          correlationId: { type: 'string' },
          ownerSessionId: { type: 'string', description: 'Ignored. The host uses the current session.' },
          parentTicketId: { type: 'string', description: 'The MVP rejects a non-empty value.' },
        },
        required: ['briefing'],
      },
      (args, hostId) => work.dispatch(hostId, args),
      'bot',
    ),
    tool(
      'foundations_supply',
      'Write the user supplement into the next briefing generation. The host binds the ticket and ignores owner, attempt, and fence.',
      {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ticketId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['text'],
      },
      (args, hostId) => work.supply(hostId, args),
      'bot',
    ),
    tool(
      'foundations_redirect',
      'Redirect with a new briefing generation. In-flight old reports become stale. Running tools are not stopped automatically.',
      {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ticketId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['text'],
      },
      (args, hostId) => work.redirect(hostId, args),
      'bot',
    ),
    tool(
      'foundations_cancel',
      'Cancel the ticket. Ticket notices that have not been claimed are removed from the inbox. It does not start again on its own.',
      {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          note: { type: 'string' },
          expectedRevision: { type: 'integer' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
      },
      (args, hostId) => work.cancelTicket(hostId, args),
      'bot',
    ),
    tool(
      'foundations_grant',
      'Grant more active runtime or tokens to an unfinished ticket. wallMs and maxTokens are amounts to ADD, not totals. Exhausted workers wait at the next safe loop boundary without expiry. Use current usage/required totals and headroom in the notice/result: insufficient grants remain paused, host ceilings cannot be raised. deny=true stops this round; do not redispatch a replacement.',
      {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          wallMs: { type: 'integer', description: 'Milliseconds to add.' },
          maxTokens: { type: 'integer', description: 'Tokens to add.' },
          deny: { type: 'boolean', description: 'Refuse the grant and stop.' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['ticketId'],
      },
      (args, hostId) => work.grant(hostId, args),
      'bot',
    ),
    tool(
      'foundations_retry',
      'When the user explicitly asks, open a new attempt for a failed or cancelled ticket. Do not call this automatically.',
      {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
      },
      (args, hostId) => work.retry(hostId, args),
      'bot',
    ),
    tool(
      'foundations_publish',
      'Record one intent to publish to the user. Each result has one row. The user has not seen it yet. Then write the reply in your own words.',
      {
        type: 'object',
        properties: {
          resultEventId: { type: 'string' },
          text: { type: 'string' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['resultEventId', 'text'],
      },
      (args, hostId, exec) => work.publish(hostId, { ...args, turn: exec?.turn ?? null }),
      'bot',
    ),
    tool(
      'foundations_reject',
      'Reject the current candidate. That result cannot be published afterward.',
      {
        type: 'object',
        properties: {
          resultEventId: { type: 'string' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['resultEventId'],
      },
      (args, hostId) => work.reject(hostId, args),
      'bot',
    ),
    tool(
      'foundations_report',
      'The worker reports progress, a question, an artifact, a result, or a failure. This only writes the ledger. ticket, attempt, fence, and owner are discarded.',
      {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['progress', 'question', 'artifact', 'result', 'failure'] },
          text: { type: 'string' },
          ticketId: { type: 'string', description: 'Ignored.' },
          attemptId: { type: 'string', description: 'Ignored.' },
          fencingToken: { type: 'integer', description: 'Ignored.' },
          briefingRevision: { type: 'integer', description: 'Ignored.' },
          ownerSessionId: { type: 'string', description: 'Ignored.' },
        },
        required: ['kind', 'text'],
      },
      async (args, hostId) => {
        if (engine.isBot(hostId))
          return toolError('FORBIDDEN', 'The main session cannot report in place of the worker.')
        return work.report(hostId, args)
      },
      'worker',
    ),
  ]
}

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} parameters
 * @param {(args: Record<string, unknown>, hostId: string, exec: { turn?: number }) => Promise<unknown>} run
 * @param {'bot' | 'worker'} who
 */
function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, hostId: string, exec: { turn?: number | null }) => Promise<ToolPayload>,
  who: 'bot' | 'worker',
) {
  return {
    name,
    description,
    parameters,
    output: OUTPUT,
    audience: who,
    async execute(
      args: Record<string, unknown> | null | undefined,
      exec: { agent?: { id?: string }; turn?: number | null } | null | undefined,
    ): Promise<ToolPayload> {
      const hostId = exec?.agent?.id
      if (typeof hostId !== 'string' || hostId === '')
        return toolError('UNAVAILABLE', 'The host did not bind a sessionId.')
      try {
        return await run(args ?? {}, hostId, exec ?? {})
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STORE_FAILURE'
        return toolError(
          code === 'CAS_CONFLICT' ? 'CAS_CONFLICT' : 'STORE_FAILURE',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  }
}
