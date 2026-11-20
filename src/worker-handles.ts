/** Child-agent handles that must survive a plugin reload.

DSH HMR evicts a changed plugin module and the modules that import it. This
module stays in the ESM cache when only the plugin entry changes, so the next
`apply` still sees the agents the host kept alive. Fiber unload must not
dispose them: the next tick would treat a live worker as gone. Session delete
forgets a handle and disposes that agent.
 */

export type WorkerHandle = {
  dispose?: () => Promise<void> | void
}

const handles = new Map<string, WorkerHandle>()

export function rememberWorker(sessionId: string, handle: WorkerHandle) {
  if (sessionId !== '') handles.set(sessionId, handle)
}

export function workerHandle(sessionId: string) {
  return handles.get(sessionId)
}

/** Unload keeps every handle. Hot reload publishes a new runtime over the same agents. */
export function retainWorkers() {
  return [...handles.keys()]
}

/** Session delete drops one agent. Other handles stay. */
export async function forgetWorker(sessionId: string) {
  const handle = handles.get(sessionId)
  handles.delete(sessionId)
  if (!handle?.dispose) return
  try {
    await handle.dispose()
  } catch {
    /* already closed */
  }
}
