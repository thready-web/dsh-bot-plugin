import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { defaultSessionCwd } from '../src/desk.ts'
import {
  DEFAULT_WORK_BUDGET,
  WORK_SLOT_MAX,
  WORK_QUEUE_MAX,
  effectiveWorkLimits,
  normalizeWorkBudget,
  parseWorkBudget,
  resolveWorkBudget,
} from '../src/work-admit.ts'

test('default main budget is 80 steps / 30 minutes on both caps', () => {
  assert.equal(DEFAULT_WORK_BUDGET.chatMaxSteps, 80)
  assert.equal(DEFAULT_WORK_BUDGET.chatWallMs, 1_800_000)
  assert.equal(DEFAULT_WORK_BUDGET.mainMaxSteps, 80)
  assert.equal(DEFAULT_WORK_BUDGET.mainWallMs, 1_800_000)
})

test('work budget text: key=value, JSON, shorthands, durations, and bad keys', () => {
  assert.deepEqual(parseWorkBudget('steps=120,wall=45m').budget, {
    mainMaxSteps: 120,
    chatMaxSteps: 120,
    mainWallMs: 2_700_000,
    chatWallMs: 2_700_000,
  })
  assert.deepEqual(parseWorkBudget('{"mainMaxSteps":10,"mainWallMs":"90s"}').budget, {
    mainMaxSteps: 10,
    mainWallMs: 90_000,
  })
  assert.deepEqual(parseWorkBudget('steps=50,chatMaxSteps=200').budget.chatMaxSteps, 200)
  const bad = parseWorkBudget('steps=0,wall=abc,bogus=3,oops')
  assert.deepEqual(bad.budget, {})
  assert.deepEqual(
    bad.ignored.sort(),
    ['bogus', 'chatMaxSteps', 'chatWallMs', 'mainMaxSteps', 'mainWallMs', 'oops'].sort(),
  )
  assert.deepEqual(parseWorkBudget('').budget, {})
  assert.deepEqual(parseWorkBudget('{not json').budget, {})
  assert.deepEqual(normalizeWorkBudget({ wall: '2h' }).budget.chatWallMs, 7_200_000)
  assert.deepEqual(parseWorkBudget('perBot=2,global=4,perBotQueue=8,globalQueue=16').budget, {
    perBot: 2,
    global: 4,
    perBotQueue: 8,
    globalQueue: 16,
  })
})

test('config.work overrides the environment, which overrides the defaults', () => {
  const resolved = resolveWorkBudget({ mainMaxSteps: 5 }, 'steps=100,wall=1h')
  assert.equal(resolved.budget.mainMaxSteps, 5)
  assert.equal(resolved.budget.chatMaxSteps, 100)
  assert.equal(resolved.budget.chatWallMs, 3_600_000)
  assert.equal(resolved.budget.holdMs, DEFAULT_WORK_BUDGET.holdMs)
  assert.deepEqual(resolveWorkBudget(undefined, undefined).budget, { ...DEFAULT_WORK_BUDGET })
})

test('session cwd defaults to <DSH_HOME>/workspace, never DSH_HOME itself', () => {
  const home = mkdtempSync(join(tmpdir(), 'sf-home-'))
  const cwd = defaultSessionCwd({ DSH_HOME: home })
  assert.equal(cwd, join(home, 'workspace'))
  assert.notEqual(cwd, home)
  assert.equal(existsSync(cwd), true)
  assert.equal(
    defaultSessionCwd({ DSH_HOME: home, THREADY_SESSION_CWD: ' /srv/bots ' }, { mkdir: false }),
    resolve('/srv/bots'),
  )
  assert.equal(defaultSessionCwd({}), '')
})

/** Fake DSH host with one live bot agent, enough for apply() to start the work runtime. */
function fakeHost(dir: string) {
  const listeners = new Map<string, Array<(...args: any[]) => any>>()
  const logs: Array<{ level: string; args: unknown[] }> = []
  const cancels: Array<{ cause: any; options: any }> = []
  const followups: Array<{ id: string; text: string }> = []
  const events: any[] = []
  let idle: () => void = () => {}
  const idlePromise = new Promise<void>(done => {
    idle = done
  })
  const agent = {
    id: 'bot-a',
    session: { snapshotEvents: () => events },
    cancel(cause: any, options: any) {
      cancels.push({ cause, options })
    },
    whenIdle: () => idlePromise,
    followup(message: any) {
      followups.push({ id: message.id, text: message.content[0].text })
      events.push({ type: 'agent/inbox/spliced', seq: events.length + 1, data: { inserted: [{ id: message.id }] } })
    },
    inbox: { nextTurn: [] },
  }
  const ctx: any = {
    profileContext: { dir },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: (id: string) => (id === 'bot-a' ? agent : null) },
    sessions: { get: () => null, flush: async () => true },
    on(name: string, fn: (...args: any[]) => any) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    effect: () => {},
    logger: {
      info: (...args: unknown[]) => logs.push({ level: 'info', args }),
      warn: (...args: unknown[]) => logs.push({ level: 'warn', args }),
    },
  }
  return { ctx, listeners, logs, cancels, followups, idle }
}

test('plugin: pre-step refuses the next step, logs, posts a notice, and never cancels as user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-budget-'))
  const host = fakeHost(dir)
  const plugin = await import('../src/index.ts')
  const previous = process.env.DSH_BOT_WORK_BUDGET
  process.env.DSH_BOT_WORK_BUDGET = 'steps=3'
  try {
    plugin.apply(host.ctx, { dataDir: join(dir, 'data'), timerTickMs: 3_600_000 })
  } finally {
    if (previous == null) delete process.env.DSH_BOT_WORK_BUDGET
    else process.env.DSH_BOT_WORK_BUDGET = previous
  }
  const gate = host.listeners.get('agent/pre-step')
  assert.equal(gate?.length, 1, 'agent/pre-step is registered')
  const sessionEvent = host.listeners.get('session/event')![0]!
  // Mark bot-a as a bot through the store the plugin opened.
  const { openStore } = await import('../src/store.ts')
  const { createEngine } = await import('../src/engine.ts')
  const store = openStore(join(dir, 'data'))
  createEngine(store).markBot('bot-a')
  store.close()

  const session = { id: 'bot-a', header: {} }
  const next = async () => ({ kind: 'enter', messages: [] })
  sessionEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  sessionEvent(session, { type: 'tool/call', seq: 2, data: { name: 'bash' } })
  for (let step = 1; step <= 3; step += 1) {
    sessionEvent(session, { type: 'step/end', seq: 2 + step, data: { turn: 1, step } })
    if (step < 3)
      assert.equal(
        (await gate![0]!({ agent: { id: 'bot-a' }, turn: 1, step: step + 1, messages: [] }, next)).kind,
        'enter',
      )
  }
  assert.equal(host.cancels.length, 0, 'step/end never cancels')
  const refused = await gate![0]!({ agent: { id: 'bot-a' }, turn: 1, step: 4, messages: [] }, next)
  assert.deepEqual(refused, { kind: 'reject' })
  assert.equal(host.cancels.length, 0)
  const warn = host.logs.find(line => line.level === 'warn' && String(line.args[0]).includes('main-budget:steps'))
  assert.ok(warn, 'budget trip is logged at warn')
  // The notice waits for the stopped turn to go idle.
  await tick()
  assert.equal(host.followups.length, 0)
  host.idle()
  for (let i = 0; i < 5 && host.followups.length === 0; i += 1) await tick()
  assert.equal(host.followups.length, 1)
  assert.match(host.followups[0]!.id, /^foundations-budget:1:/)
  assert.match(host.followups[0]!.text, /^\[foundations:budget\]/)
  assert.match(host.followups[0]!.text, /did not cancel it/)
  assert.match(host.followups[0]!.text, /foundations_dispatch/)
})

test('plugin: the wall timer cancels with { kind: hook, reason: main-budget:wall }, not user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-budget-wall-'))
  const host = fakeHost(dir)
  const plugin = await import('../src/index.ts')
  plugin.apply(host.ctx, { dataDir: join(dir, 'data'), timerTickMs: 3_600_000, work: { chatWallMs: 30 } })
  const { openStore } = await import('../src/store.ts')
  const { createEngine } = await import('../src/engine.ts')
  const store = openStore(join(dir, 'data'))
  createEngine(store).markBot('bot-a')
  store.close()
  const sessionEvent = host.listeners.get('session/event')![0]!
  sessionEvent({ id: 'bot-a', header: {} }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await new Promise(done => setTimeout(done, 80))
  assert.equal(host.cancels.length, 1)
  assert.deepEqual(host.cancels[0]!.cause, { kind: 'hook', reason: 'main-budget:wall' })
  assert.equal(host.cancels[0]!.options.keepInbox, true)
  assert.ok(host.logs.some(line => line.level === 'warn' && String(line.args[0]).includes('main-budget:wall')))
  const text = plugin.budgetNoticeText({
    reason: 'wall',
    cause: 'main-budget:wall',
    turn: 2,
    steps: 7,
    elapsedMs: 1_800_000,
    maxSteps: 80,
    wallMs: 1_800_000,
    via: 'timer',
    notify: true,
  })
  assert.match(text, /time limit \(1800s of 1800s\)/)
})

test('slot and queue defaults are perBot=2, global=4, perBotQueue=8, globalQueue=16', () => {
  const resolved = resolveWorkBudget(undefined, undefined)
  assert.equal(resolved.budget.perBot, 2)
  assert.equal(resolved.budget.global, 4)
  assert.equal(resolved.budget.perBotQueue, 8)
  assert.equal(resolved.budget.globalQueue, 16)
  assert.deepEqual(effectiveWorkLimits(resolved.budget), {
    perBot: 2,
    global: 4,
    perBotQueue: 8,
    globalQueue: 16,
  })
})

test('custom perBot=1 and perBot=3 plus a global cap parse from env, JSON, and config.work', () => {
  const one = parseWorkBudget('perBot=1,global=4,perBotQueue=2,globalQueue=8')
  assert.deepEqual(one.budget, { perBot: 1, global: 4, perBotQueue: 2, globalQueue: 8 })
  assert.deepEqual(one.ignored, [])
  assert.deepEqual(one.clamped, [])

  const three = parseWorkBudget('{"perBot":3,"global":5,"perBotQueue":10,"globalQueue":12}')
  assert.deepEqual(three.budget, { perBot: 3, global: 5, perBotQueue: 10, globalQueue: 12 })

  const fromEnv = resolveWorkBudget({}, 'perBot=3,global=6,perBotQueue=9,globalQueue=18')
  assert.equal(fromEnv.budget.perBot, 3)
  assert.equal(fromEnv.budget.global, 6)
  assert.equal(fromEnv.budget.perBotQueue, 9)
  assert.equal(fromEnv.budget.globalQueue, 18)
  const fromConfig = resolveWorkBudget({ perBot: 1, global: 3 }, 'perBot=3,global=6')
  assert.equal(fromConfig.budget.perBot, 1)
  assert.equal(fromConfig.budget.global, 3)
})

test('illegal slot values are ignored so the default stays, never Infinity', () => {
  const bad = parseWorkBudget('perBot=0,global=-1,perBotQueue=1.5,globalQueue=abc,perBot=Infinity')
  // last perBot=Infinity overwrites the 0 entry in the raw object, both ignored
  assert.equal(Object.keys(bad.budget).length, 0)
  assert.ok(bad.ignored.includes('perBot'))
  assert.ok(bad.ignored.includes('global'))
  assert.ok(bad.ignored.includes('perBotQueue'))
  assert.ok(bad.ignored.includes('globalQueue'))
  const resolved = resolveWorkBudget({ perBot: 0, global: Number.POSITIVE_INFINITY, perBotQueue: 2.9 }, 'perBot=-4')
  assert.equal(resolved.budget.perBot, DEFAULT_WORK_BUDGET.perBot)
  assert.equal(resolved.budget.global, DEFAULT_WORK_BUDGET.global)
  assert.equal(resolved.budget.perBotQueue, DEFAULT_WORK_BUDGET.perBotQueue)
  assert.ok(Number.isFinite(resolved.budget.perBot) && resolved.budget.perBot === 2)
  const empty = parseWorkBudget('perBot=,global=')
  assert.deepEqual(empty.budget, {})
  assert.ok(empty.ignored.includes('perBot'))
})

test('oversized slot and queue values clamp to the documented maxima', () => {
  const parsed = parseWorkBudget(
    `perBot=${WORK_SLOT_MAX + 1},global=1000,perBotQueue=${WORK_QUEUE_MAX + 8},globalQueue=9999`,
  )
  assert.equal(parsed.budget.perBot, WORK_SLOT_MAX)
  assert.equal(parsed.budget.global, WORK_SLOT_MAX)
  assert.equal(parsed.budget.perBotQueue, WORK_QUEUE_MAX)
  assert.equal(parsed.budget.globalQueue, WORK_QUEUE_MAX)
  assert.deepEqual(parsed.clamped.sort(), ['global', 'globalQueue', 'perBot', 'perBotQueue'])
  assert.deepEqual(parsed.ignored, [])
})

test('when perBot is greater than global, the effective cap is the minimum', () => {
  const resolved = resolveWorkBudget({ perBot: 8, global: 3, perBotQueue: 20, globalQueue: 6 }, '')
  assert.equal(resolved.budget.perBot, 8)
  assert.equal(resolved.budget.global, 3)
  assert.deepEqual(effectiveWorkLimits(resolved.budget), {
    perBot: 3,
    global: 3,
    perBotQueue: 6,
    globalQueue: 6,
  })
})

test('plugin apply logs the resolved slot caps from config.work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-budget-slots-'))
  const host = fakeHost(dir)
  const previous = process.env.DSH_BOT_WORK_BUDGET
  process.env.DSH_BOT_WORK_BUDGET = 'perBot=3,global=1,perBotQueue=8,globalQueue=4'
  try {
    const plugin = await import('../src/index.ts')
    plugin.apply(host.ctx, { dataDir: join(dir, 'data'), timerTickMs: 3_600_000, work: { perBot: 5 } })
  } finally {
    if (previous == null) delete process.env.DSH_BOT_WORK_BUDGET
    else process.env.DSH_BOT_WORK_BUDGET = previous
  }
  const info = host.logs.find(line => line.level === 'info' && String(line.args[0]).includes('slots perBot='))
  assert.ok(info, 'startup log includes slot caps')
  // config.work perBot=5 wins over env perBot=3; global=1 from env; effective perBot=min(5,1)=1
  assert.equal(info!.args[5], 1)
  assert.equal(info!.args[6], 1)
  assert.equal(info!.args[7], 4)
  assert.equal(info!.args[8], 4)
  const reduced = host.logs.find(line => line.level === 'info' && String(line.args[0]).includes('per-bot cap reduced'))
  assert.ok(reduced, 'logs when perBot is reduced to the global cap')
})
