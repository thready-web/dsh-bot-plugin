import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from './store.ts'
import { createEngine } from './engine.ts'
import { registerHttp } from './http.ts'
import type { HostContext } from './host.ts'
import { questionAnswererFor } from './questions.ts'
import { approvalAnswererFor } from './approvals.ts'
import { authorizationFor } from './authorization.ts'
import { runtimeFor, workRuntimeFor } from './runtime-registry.ts'

export const name = 'session-foundations-http'
export const inject = ['webServer', 'agents', 'sessionPersistence', 'sessionQuery']

/**
 * Local management routes for the same SQLite the main plugin uses.
 * Loaded only on profiles that have a web server, so headless does not need it.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataDir?: string }} [config]
 */
export function apply(
  ctx: HostContext & { effect(execute: () => void | (() => void)): void },
  config: { dataDir?: string } = {},
) {
  const dataDir = config.dataDir ?? (ctx.profileContext?.dir ? join(ctx.profileContext.dir, 'session-foundations') : '')
  if (dataDir === '') throw new Error('session-foundations-http: pass dataDir or launch with dsh profileContext')
  const store = openStore(dataDir)
  const engine = createEngine(store)
  ctx.effect(() => () => {
    try {
      store.close()
    } catch {
      /* closed */
    }
  })
  let key = dataDir
  try {
    key = realpathSync(dataDir)
  } catch {
    /* not created yet */
  }
  registerHttp(
    ctx,
    engine,
    () => runtimeFor(key) ?? runtimeFor(dataDir),
    () => workRuntimeFor(key) ?? workRuntimeFor(dataDir),
    dataDir,
    () => questionAnswererFor(key) ?? questionAnswererFor(dataDir),
    {
      getApprovals: () => approvalAnswererFor(key) ?? approvalAnswererFor(dataDir),
      getAuthorization: () => authorizationFor(key) ?? authorizationFor(dataDir),
    },
  )
}
