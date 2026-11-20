/** @type {Map<string, any>} */
const runtimes: Map<string, any> = new Map()

/**
 * @param {string} dataDir
 * @param {any} runtime
 */
export function publishRuntime(dataDir: string, runtime: any) {
  if (runtime) runtimes.set(dataDir, runtime)
  else runtimes.delete(dataDir)
}

/**
 * @param {string} dataDir
 */
export function runtimeFor(dataDir: string) {
  return runtimes.get(dataDir) ?? null
}

/** @type {Map<string, any>} */
const workRuntimes: Map<string, any> = new Map()

/**
 * @param {string} dataDir
 * @param {any} runtime
 */
export function publishWorkRuntime(dataDir: string, runtime: any) {
  if (runtime) workRuntimes.set(dataDir, runtime)
  else workRuntimes.delete(dataDir)
}

/**
 * @param {string} dataDir
 */
export function workRuntimeFor(dataDir: string) {
  return workRuntimes.get(dataDir) ?? null
}

/** @type {Map<string, (sessionIds: readonly string[]) => void>} */
const sessionDrops = new Map<string, (sessionIds: readonly string[]) => void>()

/**
 * The main plugin drops in-memory views when the HTTP plugin deletes a bot.
 * @param {string} dataDir
 * @param {((sessionIds: readonly string[]) => void) | null} drop
 */
export function publishSessionDrop(dataDir: string, drop: ((sessionIds: readonly string[]) => void) | null) {
  if (drop) sessionDrops.set(dataDir, drop)
  else sessionDrops.delete(dataDir)
}

/**
 * @param {string} dataDir
 * @param {readonly string[]} sessionIds
 */
export function dropSessions(dataDir: string, sessionIds: readonly string[]) {
  sessionDrops.get(dataDir)?.(sessionIds)
}
