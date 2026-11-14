/** Admission and host budgets. Neither function calls a model or reorders an inbox. */

export interface WorkBudget {
  mainMaxSteps: number
  mainWallMs: number
  chatMaxSteps: number
  chatWallMs: number
  holdMs: number
  workerMaxSteps: number
  workerWallMs: number
  workerMaxTokens: number
  /** Execution slots per bot: enqueued, started, or a reserved start. needs_user does not count. */
  perBot: number
  /** Execution slots across every bot. */
  global: number
  /** Accepted tickets waiting for a slot, per bot. */
  perBotQueue: number
  /** Accepted tickets waiting for a slot, across every bot. */
  globalQueue: number
  leaseMs: number
  starveMs: number
  mergeWindowMs: number
}

/**
 * Main-session caps. The main bot may still call host tools; these caps are a
 * runaway guard. Worker parallelism is a separate slot/queue policy: `perBot`
 * and `global` limit running workers, and `perBotQueue` / `globalQueue` cap
 * tickets waiting for a slot. `needs_user` does not occupy a running slot.
 * `main*` is the cap after a dispatch or a host tool and is never looser than
 * `chat*`.
 */
/** Hard ceiling so a typo cannot raise a slot cap without bound. */
export const WORK_SLOT_MAX = 64
/** Hard ceiling so a typo cannot raise a queue cap without bound. */
export const WORK_QUEUE_MAX = 256

export const DEFAULT_WORK_BUDGET: WorkBudget = Object.freeze({
  mainMaxSteps: 80,
  mainWallMs: 30 * 60 * 1000,
  chatMaxSteps: 80,
  chatWallMs: 30 * 60 * 1000,
  holdMs: 15_000,
  workerMaxSteps: 8,
  /** One budget slice. A grant adds another slice; there is no cumulative ceiling. */
  workerWallMs: 30 * 60 * 1000,
  /** One budget slice. A grant adds another slice; there is no cumulative ceiling. */
  workerMaxTokens: 1_000_000,
  perBot: 2,
  global: 4,
  perBotQueue: 8,
  globalQueue: 16,
  leaseMs: 60_000,
  starveMs: 30_000,
  mergeWindowMs: 1_000,
})

const BUDGET_KEYS = Object.keys(DEFAULT_WORK_BUDGET) as Array<keyof WorkBudget>

const INT_MAX: Partial<Record<keyof WorkBudget, number>> = {
  perBot: WORK_SLOT_MAX,
  global: WORK_SLOT_MAX,
  perBotQueue: WORK_QUEUE_MAX,
  globalQueue: WORK_QUEUE_MAX,
}

/**
 * A single bot cannot run more workers than the global cap, even if `perBot`
 * is larger. The same applies to the queue caps. Existing running workers are
 * not cancelled when a later process start uses a lower cap.
 * @param {WorkBudget} budget
 */
export function effectiveWorkLimits(budget: WorkBudget) {
  return {
    perBot: Math.min(budget.perBot, budget.global),
    global: budget.global,
    perBotQueue: Math.min(budget.perBotQueue, budget.globalQueue),
    globalQueue: budget.globalQueue,
  }
}

/** Environment variable the launcher uses to pass `--work-budget` to the plugin. */
export const WORK_BUDGET_ENV = 'DSH_BOT_WORK_BUDGET'

/**
 * Milliseconds from a number or a `90s` / `30m` / `2h` / `1500ms` string.
 * @param {unknown} value
 */
function durationMs(value: unknown) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return Number.NaN
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value)
  if (!match) return Number.NaN
  const unit = (match[2] ?? 'ms').toLowerCase()
  const scale = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1
  return Number(match[1]) * scale
}

/**
 * Keep only known, positive, finite budget fields. Unknown keys and bad values
 * are dropped (and listed in `ignored`) so a typo never zeroes a cap or raises
 * it to Infinity. Slot and queue integers above WORK_SLOT_MAX / WORK_QUEUE_MAX
 * are clamped (and listed in `clamped`). Non-integer slot/queue/step values
 * are ignored.
 * Shorthands: `steps` sets mainMaxSteps and chatMaxSteps; `wall` sets mainWallMs and chatWallMs.
 * Fields ending in `Ms` accept duration strings such as `30m`.
 * @param {unknown} input
 */
export function normalizeWorkBudget(input: unknown): {
  budget: Partial<WorkBudget>
  ignored: string[]
  clamped: string[]
} {
  const budget: Partial<WorkBudget> = {}
  const ignored: string[] = []
  const clamped: string[] = []
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { budget, ignored, clamped }
  const raw = { ...(input as Record<string, unknown>) }
  const expanded: Record<string, unknown> = {}
  if ('steps' in raw) {
    expanded.mainMaxSteps = raw.steps
    expanded.chatMaxSteps = raw.steps
    delete raw.steps
  }
  if ('wall' in raw) {
    expanded.mainWallMs = raw.wall
    expanded.chatWallMs = raw.wall
    delete raw.wall
  }
  Object.assign(expanded, raw)
  for (const [key, value] of Object.entries(expanded)) {
    if (!(BUDGET_KEYS as string[]).includes(key)) {
      ignored.push(key)
      continue
    }
    const duration = key.endsWith('Ms')
    const number = duration ? durationMs(value) : Number(value)
    if (!Number.isFinite(number) || number <= 0) {
      ignored.push(key)
      continue
    }
    if (!duration && !Number.isInteger(number)) {
      ignored.push(key)
      continue
    }
    const max = INT_MAX[key as keyof WorkBudget]
    if (max != null && number > max) {
      budget[key as keyof WorkBudget] = max
      clamped.push(key)
      continue
    }
    budget[key as keyof WorkBudget] = duration ? Math.floor(number) : number
  }
  return { budget, ignored, clamped }
}

/**
 * Parse `--work-budget` / DSH_BOT_WORK_BUDGET: JSON (`{"steps":80,"wall":"30m"}`)
 * or comma-separated `key=value` (`steps=80,wall=30m,mainMaxSteps=10`).
 * @param {string | undefined} text
 */
export function parseWorkBudget(text: string | undefined | null): {
  budget: Partial<WorkBudget>
  ignored: string[]
  clamped: string[]
} {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '') return { budget: {}, ignored: [], clamped: [] }
  if (source.startsWith('{')) {
    try {
      return normalizeWorkBudget(JSON.parse(source))
    } catch {
      return { budget: {}, ignored: [source], clamped: [] }
    }
  }
  const object: Record<string, string> = {}
  const ignored: string[] = []
  for (const part of source.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const eq = piece.indexOf('=')
    if (eq <= 0) {
      ignored.push(piece)
      continue
    }
    object[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim()
  }
  const normalized = normalizeWorkBudget(object)
  return { budget: normalized.budget, ignored: [...ignored, ...normalized.ignored], clamped: normalized.clamped }
}

/**
 * Defaults, then the environment (launcher `--work-budget` / `DSH_BOT_WORK_BUDGET`),
 * then plugin config `work`. Limits are applied when the work runtime is created
 * (process start or plugin load). They are not hot-reloaded into an already
 * running runtime. Lowering a cap never cancels a worker that is already running;
 * later dispatch and promotion use the new caps.
 * @param {unknown} config
 * @param {string | undefined} envText
 */
export function resolveWorkBudget(config: unknown, envText: string | undefined | null) {
  const fromEnv = parseWorkBudget(envText)
  const fromConfig = normalizeWorkBudget(config)
  return {
    budget: { ...DEFAULT_WORK_BUDGET, ...fromEnv.budget, ...fromConfig.budget } as WorkBudget,
    ignored: [...fromEnv.ignored, ...fromConfig.ignored],
    clamped: [...fromEnv.clamped, ...fromConfig.clamped],
  }
}

/**
 * Pending next-turn ids whose source is not a ticket notice and not a delivery.
 * @param {string[]} pendingIds
 * @param {Iterable<string>} backgroundIds
 */
export function userPending(pendingIds: string[], backgroundIds: Iterable<string>) {
  const background = backgroundIds instanceof Set ? backgroundIds : new Set(backgroundIds)
  return pendingIds.filter(id => typeof id === 'string' && id !== '' && !background.has(id))
}

/**
 * @param {{
 *   pendingIds: string[] | null,
 *   backgroundIds?: Iterable<string>,
 *   noticeOpen: boolean,
 *   deliveryOpen: boolean,
 *   lastNoticeAt?: number | null,
 *   nowMs: number,
 *   mergeWindowMs: number,
 *   terminalSince?: number | null,
 *   starveMs: number,
 * }} input
 */
export function decideAdmission(input: {
  pendingIds: string[] | null
  backgroundIds?: Iterable<string>
  noticeOpen: boolean
  deliveryOpen: boolean
  lastNoticeAt?: number | null
  nowMs: number
  mergeWindowMs: number
  terminalSince?: number | null
  starveMs: number
}) {
  if (input.pendingIds == null) return { admit: false, reason: 'inbox-unreadable', starve: false, userAhead: 0 }
  const users = userPending(input.pendingIds, input.backgroundIds ?? [])
  const terminalSince = input.terminalSince ?? null
  const age = terminalSince == null ? null : input.nowMs - terminalSince
  const starve = age != null && age >= input.starveMs
  if (starve) return { admit: true, reason: 'starve', starve: true, userAhead: users.length }
  if (users.length > 0) return { admit: false, reason: 'user-pending', starve: false, userAhead: users.length }
  if (input.noticeOpen) return { admit: false, reason: 'notice-open', starve: false, userAhead: 0 }
  if (input.deliveryOpen) return { admit: false, reason: 'delivery-open', starve: false, userAhead: 0 }
  const last = input.lastNoticeAt ?? null
  if (last != null && input.nowMs - last < input.mergeWindowMs) {
    return { admit: false, reason: 'merge-window', starve: false, userAhead: 0 }
  }
  return { admit: true, reason: 'clear', starve: false, userAhead: 0 }
}

/**
 * @param {{ steps?: number, elapsedMs: number, maxSteps?: number, wallMs: number, tokens?: number, maxTokens?: number }} input
 * @returns {'steps' | 'wall' | 'tokens' | null}
 */
export function budgetTrip(input: {
  steps?: number
  elapsedMs: number
  maxSteps?: number
  wallMs: number
  tokens?: number
  maxTokens?: number
}): 'steps' | 'wall' | 'tokens' | null {
  const maxSteps = input.maxSteps
  const maxTokens = input.maxTokens
  if (maxSteps != null && Number.isFinite(maxSteps) && Number(input.steps) >= maxSteps) return 'steps'
  if (maxTokens != null && Number.isFinite(maxTokens) && Number(input.tokens) >= maxTokens) return 'tokens'
  if (input.elapsedMs >= input.wallMs) return 'wall'
  return null
}

/**
 * Positive integer at or above `min`. A non-finite value is omitted.
 * @param {unknown} value
 * @param {number} min
 */
function clampAtLeast(value: unknown, min: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(min, Math.floor(number))
}

/**
 * Ticket budget chosen when the main bot dispatches.
 * An omitted field is one standard slice. An explicit estimate is kept, with a
 * floor of 1000. Later grants add on top and are not capped by this slice.
 * @param {string} _briefing
 * @param {{ wallMs?: number, maxTokens?: number } | null | undefined} suggestion
 * @param {typeof DEFAULT_WORK_BUDGET} defaults
 */
export function estimateWorkerBudget(
  _briefing: string,
  suggestion: { wallMs?: number; maxTokens?: number } | null | undefined,
  defaults: typeof DEFAULT_WORK_BUDGET = DEFAULT_WORK_BUDGET,
) {
  return {
    wallMs: clampAtLeast(suggestion?.wallMs, 1000) ?? defaults.workerWallMs,
    maxTokens: clampAtLeast(suggestion?.maxTokens, 1000) ?? defaults.workerMaxTokens,
    perBot: defaults.perBot,
    global: defaults.global,
    perBotQueue: defaults.perBotQueue,
    globalQueue: defaults.globalQueue,
  }
}

/**
 * Child creation options. parentAgent and meta.parentSession are omitted on purpose:
 * the parent link lives only on the ticket row.
 * Real DSH rejects a turn when AgentOptions.provider and model are both absent
 * (`has no provider/model`). The deployment default is not applied by create()
 * itself, so the caller copies the owner selection or the deployment default.
 * @param {string} sessionId
 * @param {string} [cwd]
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | null} [model]
 * @param {number} [maxTokens] Test-only output cap. Omit it and the host default stays.
 */
export function childCreateOptions(
  sessionId: string,
  cwd?: string,
  model?: { provider?: string; model?: string; reasoningEffort?: string } | null,
  maxTokens?: number,
) {
  const options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }
    setup?: Function
  } = { sessionId }
  if (typeof cwd === 'string' && cwd !== '') options.meta = { cwd }
  if (
    model &&
    typeof model.provider === 'string' &&
    model.provider !== '' &&
    typeof model.model === 'string' &&
    model.model !== ''
  ) {
    options.agentOptions = { provider: model.provider, model: model.model }
    if (typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '') {
      options.agentOptions.reasoningEffort = model.reasoningEffort
    }
    if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0)
      options.agentOptions.maxTokens = maxTokens
  }
  return options
}
