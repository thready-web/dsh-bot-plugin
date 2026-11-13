/** In-process mock provider for host tests. This is not a real model. */

export const name = 'foundations-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['foundations-mock'], {
    providerInfo(provider) {
      return { id: provider, name: 'Foundations mock (not a real LLM)' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image?.width, height: image?.height, maxBytes: image?.bytes }
    },
    listModels(provider) {
      return Promise.resolve([{
        provider,
        id: 'mock-1',
        name: 'Foundations mock',
        inputModalities: ['text'],
      }])
    },
    resolveModel(provider, model) {
      return Promise.resolve({
        provider,
        id: model,
        name: 'Foundations mock',
        inputModalities: ['text'],
        context: { contextWindow: 128000 },
      })
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal)
      return { model: info, stream: (options) => this.stream(options) }
    },
    stream(options) {
      return generate(options)
    },
  })
}

/**
 * @param {{ messages?: Array<{ role?: string, content?: unknown }>, purpose?: string, signal?: AbortSignal }} options
 */
async function* generate(options) {
  if (options.signal?.aborted) {
    yield { type: 'finish', reason: { kind: 'aborted' } }
    return
  }
  const messages = options.messages ?? []
  const text = directedUserText(messages)
  const directed = options.purpose == null && text.trimStart().startsWith('FOUNDATIONS_TOOL') && directiveIsLatest(messages)
  const relay = !directed && options.purpose == null && trailingUserIs(messages, '[foundations:message]')
    ? relayRequest(plainUserText(messages))
    : null
  if (relay) {
    const args = JSON.stringify({
      correlationId: relay.correlation,
      text: 'relay',
      idempotencyKey: `relay-${relay.correlation}-${relay.hop}`,
    })
    const id = `call_mock_${Date.now()}`
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'foundations_reply', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'foundations_reply', arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const hostTool = !directed && options.purpose == null ? nextHostTool(messages) : null
  if (hostTool) {
    const id = `call_mock_${Date.now()}`
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: hostTool.name, argumentsDelta: hostTool.arguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: hostTool.name, arguments: hostTool.arguments } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  // Deterministic quota-loop fixture: first request consumes 2k and reports
  // progress; after the gate resumes the next request reports the result.
  const quotaHistory = JSON.stringify(messages)
  if (!directed && options.purpose == null && quotaHistory.includes('FOUNDATIONS_QUOTA_LOOP') && !quotaHistory.includes('quota-finished')) {
    const first = !quotaHistory.includes('quota-progress')
    const args = JSON.stringify({ kind: first ? 'progress' : 'result', text: first ? 'quota-progress' : 'quota-finished' })
    const id = `call_mock_quota_${Date.now()}`
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'foundations_report', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'foundations_report', arguments: args } }
    yield { type: 'usage', usage: { inputTokens: first ? 1992 : 8, outputTokens: 8, totalTokens: first ? 2000 : 16 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const briefingArgs = !directed && options.purpose == null && briefingIsLatest(messages)
    ? briefingReport(plainUserText(messages))
    : null
  const delay = !directed && options.purpose == null ? delayRequest(messages) : null
  if (delay) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, Number(delay))
      const signal = options.signal
      if (!signal) return
      const stop = () => {
        clearTimeout(timer)
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted' } }
      return
    }
  }
  if (briefingArgs) {
    const id = `call_mock_${Date.now()}`
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'foundations_report', argumentsDelta: briefingArgs }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'foundations_report', arguments: briefingArgs } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const summary = !directed && (
    options.purpose != null
    || /compact|summar/.test(plainUserText(options.messages ?? []))
  )
  if (directed) {
    const match = /^FOUNDATIONS_TOOL\s+(\S+)\s+(\{[\s\S]*\})\s*$/.exec(text.trim())
    // Explicit native tools used by the activity API regression; all other directives keep the foundations prefix.
    const name = ['bash', 'todo_write'].includes(match?.[1]) || match?.[1]?.startsWith('foundations_') ? match[1] : `foundations_${match?.[1] ?? 'recall'}`
    const args = match?.[2] ?? '{}'
    const id = `call_mock_${Date.now()}`
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const reply = summary ? 'Summary: keep the current goal. This is a mock, not a real model.' : 'mock-ok'
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * @param {Array<{ role?: string, content?: unknown }>} messages
 */
function trailingUserIs(messages, marker) {
  let index = -1
  messages.forEach((message, position) => {
    if (message?.role === 'user' && message.source?.kind !== 'runtime-context' && textOf(message.content).includes(marker)) index = position
  })
  if (index < 0) return false
  return !messages.slice(index + 1).some(message => message?.role === 'assistant' || message?.role === 'tool')
}

/**
 * Test fixture only. A real model does not use this adapter.
 * A worker briefing may carry one line `FOUNDATIONS_TOOL foundations_report {json}`
 * so a real DSH process can exercise native report without a live provider.
 * @param {string} text
 */
/**
 * The host appends a runtime-context user snapshot after the typed line.
 * That snapshot is not the delay command, even when its source kind is absent.
 * A briefing may also carry a report line. The delay runs first, then the report.
 * A later step in the same turn already has an assistant or tool reply, so it does not wait again.
 * @param {Array<{ role?: string, source?: { kind?: string }, content?: unknown }>} messages
 */
function delayRequest(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message.source?.kind === 'runtime-context') continue
    const text = textOf(message.content)
    if (text.includes('Current runtime context') || text.startsWith('Time sampled')) continue
    const match = /(?:^|\n)\s*FOUNDATIONS_DELAY\s+(\d+)\s*(?:\n|$)/.exec(text.trim())
    if (!match) return null
    const consumed = messages.slice(index + 1).some(item => item?.role === 'assistant' || item?.role === 'tool')
    return consumed ? null : match[1]
  }
  return null
}

/**
 * Capability check only. A briefing may list `FOUNDATIONS_HOST_TOOL write|edit {json}`
 * lines. The fixture calls those real host tools in order. It does not decide
 * dispatch, report, redirect, or publish.
 * @param {Array<{ role?: string, source?: { kind?: string }, content?: unknown }>} messages
 */
function nextHostTool(messages) {
  let index = -1
  let text = ''
  messages.forEach((message, position) => {
    if (message?.role === 'user' && message.source?.kind !== 'runtime-context' && textOf(message.content).includes('[foundations:briefing]')) {
      index = position
      text = textOf(message.content)
    }
  })
  if (index < 0) return null
  const lines = [...text.matchAll(/^FOUNDATIONS_HOST_TOOL\s+(write|edit|bash)\s+(\{[\s\S]*?\})\s*$/gm)]
  if (lines.length === 0) return null
  const after = messages.slice(index + 1)
  const done = after.filter(message => message?.role === 'tool').length
  const assistants = after.filter(message => message?.role === 'assistant').length
  if (done >= lines.length || assistants > done) return null
  return { name: lines[done][1], arguments: lines[done][2] }
}

function briefingIsLatest(messages) {
  let index = -1
  messages.forEach((message, position) => {
    if (message?.role === 'user' && message.source?.kind !== 'runtime-context' && textOf(message.content).includes('[foundations:briefing]')) {
      index = position
    }
  })
  if (index < 0) return false
  return !messages.slice(index + 1).some(message => message?.role === 'assistant' || message?.role === 'tool')
}

function briefingReport(text) {
  if (!text.includes('[foundations:briefing]')) return null
  const match = /^FOUNDATIONS_TOOL\s+foundations_report\s+(\{[\s\S]*?\})\s*$/m.exec(text)
  return match?.[1] ?? null
}

function relayRequest(text) {
  if (!text.includes('[foundations:message]')) return null
  const correlation = /correlation: ([^\s]+)/.exec(text)?.[1]
  const hop = Number(/hop: (\d+)/.exec(text)?.[1] ?? '0')
  if (!correlation || !text.endsWith('relay')) return null
  return { correlation, hop }
}

function directiveIsLatest(messages) {
  let directive = -1
  messages.forEach((message, index) => {
    if (message?.role === 'user' && message.source?.kind !== 'runtime-context' && textOf(message.content).trim().startsWith('FOUNDATIONS_TOOL')) {
      directive = index
    }
  })
  if (directive < 0) return false
  return !messages.slice(directive + 1).some(message => message?.role === 'assistant' || message?.role === 'tool')
}

function directedUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (message.source?.kind === 'runtime-context') continue
    const text = textOf(message.content)
    const at = text.indexOf('FOUNDATIONS_TOOL ')
    if (at >= 0) return text.slice(at).trim()
  }
  return ''
}

function plainUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message.source?.kind === 'runtime-context') continue
    return textOf(message.content)
  }
  return ''
}

/**
 * @param {unknown} content
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && typeof block === 'object' && block.type === 'text').map(block => block.text ?? '').join('\n')
}
