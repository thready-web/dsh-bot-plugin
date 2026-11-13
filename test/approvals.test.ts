import { strict as assert } from 'node:assert'
import test from 'node:test'
import { approvalSessionIdOf, createApprovalAnswerer, type OfficialApprovalRequest } from '../src/approvals.ts'

class OfficialApprovalHost {
  listeners: Array<
    (
      request: OfficialApprovalRequest,
      next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
    ) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  > = []

  on(
    _event: string,
    listener: (
      request: OfficialApprovalRequest,
      next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
    ) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
    options?: boolean | { prepend?: boolean },
  ) {
    const prepend = options === true || (typeof options === 'object' && options.prepend === true)
    if (prepend) this.listeners.unshift(listener)
    else this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(entry => entry !== listener)
    }
  }

  waterfall(request: OfficialApprovalRequest) {
    const fallback = async () => 'unavailable' as const
    const chain = [...this.listeners]
    const run = (index: number): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> => {
      const listener = chain[index]
      if (!listener) return fallback()
      return Promise.resolve(listener(request, () => run(index + 1)))
    }
    return run(0)
  }
}

test('the prepended approval answerer claims the official waterfall and fails closed without a session', async () => {
  const ctx = new OfficialApprovalHost()
  const typtert: string[] = []
  ctx.on('approval/request', (_request, next) => {
    typtert.push('later')
    return next()
  })
  const answerer = createApprovalAnswerer()
  const stop = answerer.listen(ctx as never)
  assert.equal(await ctx.waterfall({ toolName: 'bash', reason: 'write outside workspace' }), 'unavailable')
  assert.deepEqual(typtert, [])
  const asked = ctx.waterfall({
    agent: { id: 'sess-bot' },
    toolName: 'bash',
    callId: 'call_bash',
    reason: 'Write a file outside the workspace',
  })
  const open = answerer.snapshot('sess-bot')
  assert.equal(open[0]?.state, 'open')
  assert.equal(open[0]?.toolName, 'bash')
  assert.equal(approvalSessionIdOf({ id: 'sess-bot' }), 'sess-bot')
  const denied = answerer.submit({
    sessionId: 'sess-bot',
    requestId: open[0]!.requestId,
    outcome: 'allowed-once',
  })
  // typo check below after we also test reject and always-allow rejection
  assert.equal(denied.ok, true)
  assert.equal(denied.outcome, 'allowed-once')
  assert.equal(await asked, 'allowed-once')
  assert.deepEqual(typtert, [])
  const again = answerer.submit({
    sessionId: 'sess-bot',
    requestId: open[0]!.requestId,
    outcome: 'rejected',
  })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'NOT_FOUND')
  stop()
})

test('tool approval rejects always-allow and cannot be answered across sessions', async () => {
  const ctx = new OfficialApprovalHost()
  const answerer = createApprovalAnswerer()
  answerer.listen(ctx as never)
  const asked = ctx.waterfall({ agent: { id: 'sess-bot' }, toolName: 'edit', reason: 'Edit a file' })
  const open = answerer.snapshot('sess-bot')[0]!
  const always = answerer.submit({ sessionId: 'sess-bot', requestId: open.requestId, outcome: 'unavailable' })
  assert.equal(always.ok, false)
  assert.equal(always.code, 'VALIDATION')
  const cross = answerer.submit({ sessionId: 'other', requestId: open.requestId, outcome: 'rejected' })
  assert.equal(cross.ok, false)
  assert.equal(answerer.pendingCount(), 1)
  const result = answerer.submit({ sessionId: 'sess-bot', requestId: open.requestId, outcome: 'rejected' })
  assert.equal(result.ok, true)
  assert.equal(await asked, 'rejected')
})

test('an already-aborted approval request resolves cancelled instead of hanging', async () => {
  const answerer = createApprovalAnswerer()
  const started = Date.now()
  const outcome = await answerer.handle(
    { agent: { id: 'sess-bot' }, toolName: 'bash', signal: AbortSignal.abort() },
    () => Promise.resolve('unavailable'),
  )
  assert.equal(outcome, 'cancelled')
  assert.ok(Date.now() - started < 1000)
  assert.equal(answerer.pendingCount(), 0)
})
