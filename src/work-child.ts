/**
 * File tools for a worker. Plugin-created agents do not inherit the web preset,
 * so their request header otherwise lists only host tools.
 * This preset mounts official file tools and official command tools
 * (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-jobs`). It does not
 * change the host sandbox mode, add writable roots, or mount the web preset
 * (no web_fetch, subagent, or other profile tools). The session cwd copied
 * at create remains the workspace-write boundary; bash uses the already
 * composed host bash-sandbox and approval policy.
 */

export const WORKER_FILE_PRESET = 'foundations-files'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function presetsOf(ctx: import('./host.ts').HostContext) {
  try {
    if (typeof ctx.get === 'function') return ctx.get('agentPresets') ?? null
  } catch {
    /* preset service is optional until a worker is created */
  }
  try {
    return ctx.agentPresets ?? null
  } catch {
    return null
  }
}

/**
 * Register the worker file preset once per process. A duplicate from a reload
 * is the same preset and is not an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function ensureWorkerFilePreset(ctx: import('./host.ts').HostContext) {
  const presets = presetsOf(ctx)
  if (!presets?.register || !presets?.mount) return Promise.resolve(null)
  return presets
    .register({
      id: WORKER_FILE_PRESET,
      plugins: [
        {
          id: 'tool-fs',
          name: '@deepseek-ai/dsh-tool-fs',
          config: { applyPatch: false, readImage: false },
        },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      ],
    })
    .then(() => WORKER_FILE_PRESET)
    .catch((error: any) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Duplicate')) return WORKER_FILE_PRESET
      throw error
    })
}

/**
 * Bind the file preset before the agent is published. Resume uses the id
 * recorded on the session header, because select() refuses a session that
 * has already started a turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string | null} presetId
 */
export function workerFileSetup(ctx: import('./host.ts').HostContext, presetId: string | null) {
  return async (agentCtx: any, agent: any) => {
    const presets = presetsOf(ctx)
    if (!presets?.mount) return
    const recorded =
      agent?.session && typeof presets.presetForSession === 'function' ? presets.presetForSession(agent.session) : null
    const id = presetId || recorded || presets.defaultId
    if (!id) return
    const resolved = typeof presets.resolve === 'function' ? await presets.resolve(id) : { id }
    if (resolved?.broken) throw new Error(`worker file-tool preset is unavailable: ${resolved.broken}`)
    await presets.mount(agentCtx, resolved?.id ?? id)
  }
}
