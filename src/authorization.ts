/**
 * Official `ctx.authorization` surface for the desk settings UI.
 *
 * Authorization is config-time, never part of the transcript or model
 * context. The desk supplies the official interaction: notices, prompts,
 * and cancel. Secret prompts are answered with the exact submitted value;
 * the UI must not use a password input.
 */
import { toolError, type ToolPayload } from './errors.ts'
import type { HostContext } from './host.ts'

export type AuthorizationMethod = { id: string; label: string }

export type AuthorizationEntryView = {
  key: unknown
  label: string
  methods: AuthorizationMethod[]
  inFlight: boolean
}

export type AuthorizationPromptView = {
  promptId: string
  key: unknown
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string; description?: string }>
}

export type AuthorizationNoticeView = {
  key: unknown
  message: string
  url?: string
  code?: string
}

type PendingPrompt = {
  promptId: string
  key: unknown
  prompt: AuthorizationPromptView
  resolve: (value: string) => void
  reject: (error: unknown) => void
}

class DeclinedError extends Error {
  code = 'DECLINED'
  constructor(message = 'The authorization prompt was declined.') {
    super(message)
    this.name = 'AuthorizationDeclinedError'
  }
}

const controllers: Map<string, AuthorizationController> = new Map()

export function publishAuthorization(dataDir: string, controller: AuthorizationController | null) {
  if (controller) controllers.set(dataDir, controller)
  else controllers.delete(dataDir)
}

export function authorizationFor(dataDir: string) {
  return controllers.get(dataDir) ?? null
}

export type AuthorizationController = ReturnType<typeof createAuthorizationController>

export function createAuthorizationController() {
  const prompts = new Map<string, PendingPrompt>()
  const notices: AuthorizationNoticeView[] = []
  let host: HostContext | null = null
  let nextId = 1
  let catalogRevision = 0
  const active = new Map<symbol, unknown>()

  function service() {
    return host?.get?.('authorization')
  }

  function declined(message?: string) {
    const ctor = service()?.constructor?.AuthorizationDeclinedError
    if (typeof ctor === 'function') {
      try {
        return new ctor(message)
      } catch {
        /* fall through */
      }
    }
    const AuthorizationDeclinedError = service()?.AuthorizationDeclinedError
    if (typeof AuthorizationDeclinedError === 'function') {
      try {
        return new AuthorizationDeclinedError(message)
      } catch {
        /* fall through */
      }
    }
    return new DeclinedError(message)
  }

  function list(): AuthorizationEntryView[] {
    const entries = service()?.list?.()
    if (!Array.isArray(entries)) return []
    return entries.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return []
      const row = entry as Record<string, unknown>
      const methods = Array.isArray(row.methods)
        ? row.methods.flatMap(method => {
            if (!method || typeof method !== 'object') return []
            const item = method as Record<string, unknown>
            if (typeof item.id !== 'string' || item.id === '') return []
            return [
              {
                id: item.id,
                label: typeof item.label === 'string' && item.label !== '' ? item.label : item.id,
              },
            ]
          })
        : []
      return [
        {
          key: row.key,
          label: typeof row.label === 'string' ? row.label : '',
          methods,
          inFlight: row.inFlight === true,
        },
      ]
    })
  }

  type SnapshotBase = { available: boolean; notices: AuthorizationNoticeView[]; prompts: AuthorizationPromptView[] }
  type CompactSnapshot = SnapshotBase & { catalogRevision: number; inFlight: unknown[] }
  type CatalogSnapshot = SnapshotBase & { entries: AuthorizationEntryView[] }
  function snapshot(options: { catalog: false }): CompactSnapshot
  function snapshot(options?: { catalog?: true }): CatalogSnapshot
  function snapshot(options: { catalog?: boolean }): CompactSnapshot | CatalogSnapshot
  function snapshot(options: { catalog?: boolean } = {}): CompactSnapshot | CatalogSnapshot {
    return {
      available: Boolean(service()),
      ...(options.catalog === false ? { catalogRevision, inFlight: [...active.values()] } : { entries: list() }),
      notices: [...notices],
      prompts: [...prompts.values()].map(entry => entry.prompt),
    }
  }

  async function begin(input: { key: unknown; method?: string }): Promise<ToolPayload> {
    const auth = service()
    if (!auth || typeof auth.begin !== 'function') {
      return toolError('UNAVAILABLE', 'Official authorization is not composed on this host.')
    }
    if (input.key == null) return toolError('VALIDATION', 'A credential key is required.')
    const activeKey = Symbol()
    active.set(activeKey, input.key)
    catalogRevision++
    try {
      const outcome = await auth.begin({
        key: input.key,
        method: typeof input.method === 'string' && input.method !== '' ? input.method : undefined,
        interaction: {
          notify(notice: { message?: unknown; url?: unknown; code?: unknown }) {
            const view: AuthorizationNoticeView = {
              key: input.key,
              message: typeof notice?.message === 'string' ? notice.message : '',
            }
            if (typeof notice?.url === 'string' && notice.url !== '') view.url = notice.url
            if (typeof notice?.code === 'string' && notice.code !== '') view.code = notice.code
            notices.push(view)
            if (notices.length > 20) notices.shift()
          },
          prompt(prompt: { kind?: unknown; message?: unknown; placeholder?: unknown; options?: unknown }) {
            return new Promise<string>((resolve, reject) => {
              const kind = prompt?.kind === 'secret' || prompt?.kind === 'select' ? prompt.kind : 'text'
              const view: AuthorizationPromptView = {
                promptId: `auth-${nextId++}`,
                key: input.key,
                kind,
                message: typeof prompt?.message === 'string' ? prompt.message : '',
              }
              if (typeof prompt?.placeholder === 'string' && prompt.placeholder !== '') {
                view.placeholder = prompt.placeholder
              }
              if (kind === 'select' && Array.isArray(prompt?.options)) {
                view.options = prompt.options.flatMap(option => {
                  if (!option || typeof option !== 'object') return []
                  const row = option as Record<string, unknown>
                  if (typeof row.id !== 'string' || row.id === '') return []
                  const item: { id: string; label: string; description?: string } = {
                    id: row.id,
                    label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
                  }
                  if (typeof row.description === 'string' && row.description !== '') item.description = row.description
                  return [item]
                })
              }
              prompts.set(view.promptId, { promptId: view.promptId, key: input.key, prompt: view, resolve, reject })
            })
          },
        },
      })
      return { ok: true, outcome }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNAVAILABLE'
      const message = error instanceof Error ? error.message : 'Authorization could not be started.'
      if (code === 'DECLINED') return { ok: true, outcome: { status: 'cancelled' } }
      return toolError(
        code === 'NO_FLOW' || code === 'UNKNOWN_METHOD' || code === 'ALREADY_IN_FLIGHT' ? code : 'UNAVAILABLE',
        message,
      )
    } finally {
      active.delete(activeKey)
      catalogRevision++
    }
  }

  function answer(input: { promptId: string; value?: string; declined?: boolean }): ToolPayload {
    if (typeof input.promptId !== 'string' || input.promptId === '') {
      return toolError('VALIDATION', 'promptId is required.')
    }
    const entry = prompts.get(input.promptId)
    if (!entry) return toolError('NOT_FOUND', 'No open authorization prompt matches this request.')
    prompts.delete(input.promptId)
    if (input.declined) {
      entry.reject(declined())
      return { ok: true, path: 'declined' }
    }
    if (typeof input.value !== 'string') return toolError('VALIDATION', 'A prompt answer is required.')
    entry.resolve(input.value)
    return { ok: true, path: 'answered' }
  }

  function cancel(input: { key: unknown }): ToolPayload {
    const auth = service()
    if (!auth || typeof auth.cancel !== 'function') {
      return toolError('UNAVAILABLE', 'Official authorization is not composed on this host.')
    }
    if (input.key == null) return toolError('VALIDATION', 'A credential key is required.')
    for (const [id, entry] of [...prompts]) {
      if (entry.key === input.key || JSON.stringify(entry.key) === JSON.stringify(input.key)) {
        prompts.delete(id)
        entry.reject(declined())
      }
    }
    catalogRevision++
    auth.cancel(input.key)
    return { ok: true, path: 'cancelled' }
  }

  function bind(ctx: HostContext) {
    host = ctx
    catalogRevision++
    return () => {
      if (host === ctx) host = null
      catalogRevision++
      active.clear()
      for (const entry of [...prompts.values()]) {
        prompts.delete(entry.promptId)
        entry.reject(declined())
      }
    }
  }

  return { bind, list, snapshot, begin, answer, cancel }
}
