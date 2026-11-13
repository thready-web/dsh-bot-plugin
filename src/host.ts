/**
 * Services the DSH host injects onto a Cordis context. They are not part of
 * Cordis's own Context, and this plugin reads them off the same object.
 *
 * Official types are imported so a host API change fails typecheck. The
 * Context members `connection`, `sessions`, `sessionPersistence`, and `sessionQuery` come from the
 * official packages and are not redeclared here.
 */
import type {} from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { SessionStore as OfficialSessionStore } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'

declare module '@deepseek-ai/cordis' {
  interface Context {
    profileContext?: { dir?: string }
    webServer?: any
    agents?: any
    systemPrompt?: any
    tools?: any
    agentPresets?: any
    agentDefaultModel?: { currentSelection?: () => any }
  }
}

/**
 * The slice of a Cordis context this plugin actually reads. Test doubles and
 * the real host both satisfy it; the module augmentation above is what puts
 * the same members on Context.
 */
export interface HostContext {
  effect?(execute: () => void | (() => void)): void
  profileContext?: { dir?: string }
  webServer?: any
  connection?: Pick<HostConnectionHandle, 'fetch' | 'requestRejection'>
  sessionQuery?: {
    observeSession(sessionId: string, options?: { projectionMode?: 'all' | 'none'; signal?: AbortSignal }): Promise<any>
  }
  agents?: any
  /** Official type is OfficialSessionStore; kept structural so test doubles and string session ids typecheck. */
  sessions?: any
  sessionPersistence?: any
  systemPrompt?: any
  tools?: any
  agentPresets?: any
  userQuestions?: {
    answer(agent: unknown, callId: string, answer: unknown): boolean
    attachWait?(agent: unknown, callId: string, signal?: AbortSignal): AsyncIterable<{ remainingMs: number }>
  }
  authorization?: any
  logger?: { info?(...args: any[]): void; warn?(...args: any[]): void }
  on?(
    event: string,
    listener: (...args: any[]) => any,
    options?: boolean | { global?: boolean; prepend?: boolean },
  ): any
  get?(name: string): any
  agentDefaultModel?: { currentSelection?(): any }
}

/** Host passed to the main plugin. These calls are unconditional. */
export interface PluginHost extends HostContext {
  effect(execute: () => void | (() => void)): void
  systemPrompt: any
  tools: any
  on(event: string, listener: (...args: any[]) => any, options?: boolean | { global?: boolean; prepend?: boolean }): any
}

export type { OfficialSessionStore }
