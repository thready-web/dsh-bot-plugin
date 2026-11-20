import { createReadStream, statSync, type ReadStream } from 'node:fs'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { beginDelete, deleteStatus, type DeleteJob, type DeleteProgress } from './deleting.ts'
import { createDesk, defaultSessionCwd, type DeskRequest } from './desk.ts'
import { dropSessions } from './runtime-registry.ts'
import { executeDelete } from './session-delete-job.ts'
import { serveWorkspaceImage } from './workspace-image.ts'
import { selectBrowserHome } from './workspace-files.ts'
import type { HostContext } from './host.ts'
import { toolError, type ToolPayload } from './errors.ts'
import { permissionView, setPermission } from './permissions.ts'
import { cuaAction, cuaSnapshot } from './cua-access.ts'
import { provisionSession } from './provision.ts'
import { handleWorkApi, openPageLive, openWorkLive } from './work-http.ts'
import { releaseLoadedAgent } from './inbox.ts'
import { createLogSource } from './log/source.ts'
import { createLogSnapshotService } from './log/snapshot-service.ts'
import { dispatchLogRequest, probeConnection, registerLogRoutes } from './log/routes.ts'
import { handleMemoryRoute } from './memory-catalog.ts'
import { handleCanvasApi, serveCanvasInspect, serveCanvasMedia } from './canvas-http.ts'
import { openCanvasStore, type CanvasStore } from './canvas-store.ts'
import { bindCanvasCards } from './card-log.ts'

/**
 * Local management routes. Model tools cannot confirm a persona or change revocation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./engine.js').Engine} engine
 * @param {() => import('./triggers.js').ReturnType<typeof import('./triggers.js').createTriggers> | null} [getRuntime]
 * @param {() => import('./work-worker.js').ReturnType<typeof import('./work-worker.js').createWorkRuntime> | null} [getWork]
 */
export function registerHttp(
  ctx: HostContext & { effect(execute: () => void | (() => void)): void },
  engine: import('./engine.ts').Engine,
  getRuntime: () => ReturnType<typeof import('./triggers.ts').createTriggers> | null = () => null,
  getWork: () => ReturnType<typeof import('./work-worker.ts').createWorkRuntime> | null = () => null,
  dataDir = '',
  getQuestions: () => import('./questions.ts').QuestionAnswerer | null = () => null,
  extras: {
    getApprovals?: () => import('./approvals.ts').ApprovalAnswerer | null
    getAuthorization?: () => import('./authorization.ts').AuthorizationController | null
    filesHome?: unknown
  } = {},
) {
  const getApprovals = extras.getApprovals ?? (() => null)
  const getAuthorization = extras.getAuthorization ?? (() => null)
  const webServer = ctx.webServer
  const storeDir = dataDir || (ctx.profileContext?.dir ? join(ctx.profileContext.dir, 'session-foundations') : '')
  const profileDir = ctx.profileContext?.dir || (storeDir !== '' ? dirname(storeDir) : '')
  const canvas: CanvasStore | null = storeDir === '' ? null : openCanvasStore(join(storeDir, 'canvas.sqlite'))
  if (canvas && storeDir !== '') bindCanvasCards(canvas, ctx, storeDir)
  const logService = createLogSnapshotService(createLogSource(ctx))
  const logOnConnection = registerLogRoutes(ctx, logService)
  const persistence = ctx.sessionPersistence as { root?: unknown } | undefined
  const sessionsRoot = typeof persistence?.root === 'string' ? persistence.root : ''
  const desk =
    profileDir === ''
      ? null
      : createDesk({
          ledgerFile: join(storeDir, 'desk-ledger.json'),
          profileDir,
          ...(sessionsRoot !== '' ? { sessionsRoot, stateRoot: dirname(sessionsRoot) } : {}),
          sessionCwd: defaultSessionCwd(process.env),
          isBot: sessionId => engine.isBot(sessionId),
          mark: sessionId => engine.markBot(sessionId),
          hold: sessionId => {
            getWork()?.holdNotices(sessionId)
          },
          release: sessionId => {
            getWork()?.releaseHold(sessionId)
          },
          releaseLoaded: sessionId => releaseLoadedAgent(sessionId),
          releaseAttached: sessionId => unloadAttachedSession(ctx, sessionId),
          stillAttached: sessionId => attachedSession(ctx, sessionId),
          rpc: (endpoint, args, req) => hostRpc(req, endpoint, args),
          usage: req => hostUsage(req),
          files: {
            home: selectBrowserHome(process.env, extras.filesHome),
            dshHome: process.env.DSH_HOME ?? '',
          },
        })
  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function loadPageDesk(req: import('node:http').IncomingMessage) {
    if (!desk) return null
    const base = 'http://127.0.0.1'
    const [sessions, health, usage] = await Promise.all([
      desk.handle('GET', '/session-foundations/api/sessions', new URL('/session-foundations/api/sessions', base), req),
      desk.handle('GET', '/session-foundations/api/health', new URL('/session-foundations/api/health', base), req),
      desk.handle('GET', '/session-foundations/api/usage', new URL('/session-foundations/api/usage', base), req),
    ])
    const bots = engine.listBots()
    return {
      sessions: sessions.body,
      health: health.status === 200 ? health.body : null,
      usage: usage.status === 200 ? usage.body : null,
      bots: { ok: true, sessionIds: bots.map(bot => bot.sessionId), bots },
    }
  }
  // Compact reads do not enumerate the static authorization provider catalog.
  function interactionSnapshot(sessionId: string, compact: boolean) {
    return {
      ok: true,
      sessionId,
      questions: sessionId || !compact ? (getQuestions()?.snapshot(sessionId || undefined) ?? []) : [],
      approvals: sessionId || !compact ? (getApprovals()?.snapshot(sessionId || undefined) ?? []) : [],
      authorization: getAuthorization()?.snapshot({ catalog: !compact }) ?? {
        available: false,
        ...(compact ? { catalogRevision: 0, inFlight: [] } : { entries: [] }),
        notices: [],
        prompts: [],
      },
    }
  }
  const stateRoot = sessionsRoot !== '' ? dirname(sessionsRoot) : ''

  function sessionDeleteRoute(
    res: import('node:http').ServerResponse,
    req: DeskRequest,
    ownerId: string,
    statusOnly: boolean,
  ) {
    if (statusOnly) return send(res, 200, deleteStatus(ownerId) ?? { phase: 'absent', percent: 0 })
    const job = beginDelete(ownerId, publish =>
      executeDelete(
        {
          store: engine.store,
          canvas,
          sessionsRoot,
          stateRoot,
          running: sessionId => sessionListedRunning(req, sessionId),
          stop: sessionId => stopForDelete(ctx, sessionId),
          silence: sessionId => {
            getWork()?.silence(sessionId)
          },
          cancelQuestions: sessionId => {
            getQuestions()?.cancelSession(sessionId)
          },
          abandonApprovals: sessionId => {
            getApprovals()?.abandonSession(sessionId)
          },
          forgetDesk: sessionIds => {
            desk?.forgetSessions(sessionIds)
          },
          dropMemory: sessionIds => {
            for (const sessionId of sessionIds) {
              engine.openViews.delete(sessionId)
              engine.surface.delete(sessionId)
            }
            dropSessions(engine.store.root, sessionIds)
          },
        },
        ownerId,
        publish,
      ),
    )
    writeDeleteStream(res, job)
  }

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const requestTarget = req.url ?? '/'
    if ((requestTarget.split('?')[0] ?? '').startsWith('/dsh-bot/canvas-media/')) {
      return serveCanvasMedia(req, res, requestTarget, canvas)
    }
    if (
      (requestTarget.split('?')[0] ?? '') === '/dsh-bot/canvas-inspector.js' ||
      (requestTarget.split('?')[0] ?? '').startsWith('/dsh-bot/canvas-inspect/')
    ) {
      return serveCanvasInspect(req, res, requestTarget, canvas)
    }
    const rejection = reject(ctx, req)
    if (rejection) return send(res, rejection, { ok: false, code: 'FORBIDDEN' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rawPath = url.pathname.replace(/\/+$/, '') || '/'
    if (!logOnConnection && rawPath.startsWith('/api/dsh-bot/log')) {
      const response = await dispatchLogRequest(logService, await asFetchRequest(req))
      if (response) return sendFetchResponse(res, response)
    }
    if (rawPath === '/dsh-bot' || (rawPath.startsWith('/dsh-bot/') && !rawPath.startsWith('/dsh-bot/api'))) {
      if (await proxyDevUi(req, res)) return
      if (serveDesk(req, res, rawPath)) return
      if (serveWorkspaceImage(req, res, rawPath, defaultSessionCwd(process.env, { mkdir: false }))) return
      return send(res, 404, { ok: false, code: 'NOT_FOUND' })
    }
    const path = rawPath.startsWith('/dsh-bot/api')
      ? '/session-foundations/api' + rawPath.slice('/dsh-bot/api'.length)
      : rawPath
    try {
      if (desk && req.method === 'GET' && path === '/session-foundations/api/files/raw') {
        return pipeDownload(res, await desk.openDownload(req, url), url.searchParams.get('inline') === '1')
      }
      if (desk && req.method === 'POST' && path === '/session-foundations/api/files') {
        const outcome = await desk.saveUpload(req, url)
        send(res, outcome.status, outcome.body)
        if (outcome.status === 413) res.on('finish', () => req.destroy())
        return
      }
      const sessionDelete = path.match(/^\/session-foundations\/api\/sessions\/(session-[A-Za-z0-9-]+)\/delete$/)
      if (sessionDelete && (req.method === 'GET' || req.method === 'POST')) {
        return sessionDeleteRoute(res, req, sessionDelete[1], req.method === 'GET')
      }
      if (desk && desk.owns(req.method ?? 'GET', path)) {
        const outcome = await desk.handle(req.method ?? 'GET', path, url, req)
        return send(res, outcome.status, outcome.body)
      }
      if (req.method === 'GET' && path === '/session-foundations/api/status') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        return send(res, 200, status(engine, sessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/mark') {
        const body = await readJson(req)
        if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '')
          return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        const binding = engine.markBot(body.sessionId.trim())
        return send(res, 200, { ok: true, kind: 'bot', sessionId: binding.session_id })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/sessions/bots') {
        const bots = engine.listBots()
        return send(res, 200, { ok: true, sessionIds: bots.map(bot => bot.sessionId), bots })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/questions/answer') {
        const questions = getQuestions()
        if (!questions)
          return send(
            res,
            503,
            toolError('UNAVAILABLE', 'The user-questions answerer is not attached to this host yet.'),
          )
        const body = await readJson(req)
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
          return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        }
        const result = questions.submit({
          sessionId: body.sessionId,
          callId: typeof body.callId === 'string' ? body.callId : undefined,
          answers: body.answers,
        })
        if (result.ok === false) {
          const status =
            result.code === 'NOT_FOUND'
              ? 404
              : result.code === 'CONFLICT'
                ? 409
                : result.code === 'FORBIDDEN'
                  ? 403
                  : result.code === 'UNAVAILABLE'
                    ? 503
                    : 400
          return send(res, status, result)
        }
        return send(res, 200, result)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/questions/cancel') {
        const questions = getQuestions()
        if (!questions)
          return send(
            res,
            503,
            toolError('UNAVAILABLE', 'The user-questions answerer is not attached to this host yet.'),
          )
        const body = await readJson(req)
        return sendTool(
          res,
          questions.cancel({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            callId: typeof body.callId === 'string' ? body.callId : undefined,
            answers: Array.isArray(body.answers) ? body.answers : undefined,
          }),
        )
      }
      if (req.method === 'POST' && path === '/session-foundations/api/questions/timeout') {
        const questions = getQuestions()
        if (!questions)
          return send(
            res,
            503,
            toolError('UNAVAILABLE', 'The user-questions answerer is not attached to this host yet.'),
          )
        const body = await readJson(req)
        return sendTool(
          res,
          questions.timeout({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            callId: typeof body.callId === 'string' ? body.callId : undefined,
          }),
        )
      }
      if (req.method === 'POST' && path === '/session-foundations/api/questions/take-time') {
        const questions = getQuestions()
        if (!questions)
          return send(
            res,
            503,
            toolError('UNAVAILABLE', 'The user-questions answerer is not attached to this host yet.'),
          )
        const body = await readJson(req)
        return sendTool(
          res,
          questions.takeTime({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            callId: typeof body.callId === 'string' ? body.callId : undefined,
          }),
        )
      }
      if (req.method === 'GET' && path === '/session-foundations/api/interactions') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        return send(res, 200, interactionSnapshot(sessionId, url.searchParams.get('compact') === '1'))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/approvals/answer') {
        const approvals = getApprovals()
        if (!approvals)
          return send(
            res,
            503,
            toolError('UNAVAILABLE', 'The tool-approval answerer is not attached to this host yet.'),
          )
        const body = await readJson(req)
        return sendTool(
          res,
          approvals.submit({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            requestId: typeof body.requestId === 'string' ? body.requestId : '',
            outcome: body.outcome,
          }),
        )
      }
      if (req.method === 'GET' && path === '/session-foundations/api/permissions') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        return send(res, 200, { ok: true, ...permissionView(ctx, sessionId) })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/permissions') {
        const body = await readJson(req)
        return sendTool(
          res,
          setPermission(
            ctx,
            typeof body.sessionId === 'string' ? body.sessionId : '',
            typeof body.name === 'string' ? body.name : '',
          ),
        )
      }
      if (req.method === 'GET' && path === '/session-foundations/api/authorization') {
        const authorization = getAuthorization()
        if (!authorization) return send(res, 200, { ok: true, available: false, entries: [], notices: [], prompts: [] })
        return send(res, 200, { ok: true, ...authorization.snapshot() })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/authorization/begin') {
        const authorization = getAuthorization()
        if (!authorization)
          return send(res, 503, toolError('UNAVAILABLE', 'Official authorization is not attached to this host yet.'))
        const body = await readJson(req)
        return sendTool(
          res,
          await authorization.begin({
            key: body.key,
            method: typeof body.method === 'string' ? body.method : undefined,
          }),
        )
      }
      if (req.method === 'POST' && path === '/session-foundations/api/authorization/answer') {
        const authorization = getAuthorization()
        if (!authorization)
          return send(res, 503, toolError('UNAVAILABLE', 'Official authorization is not attached to this host yet.'))
        const body = await readJson(req)
        return sendTool(
          res,
          authorization.answer({
            promptId: typeof body.promptId === 'string' ? body.promptId : '',
            value: typeof body.value === 'string' ? body.value : undefined,
            declined: body.declined === true,
          }),
        )
      }
      if (req.method === 'POST' && path === '/session-foundations/api/authorization/cancel') {
        const authorization = getAuthorization()
        if (!authorization)
          return send(res, 503, toolError('UNAVAILABLE', 'Official authorization is not attached to this host yet.'))
        const body = await readJson(req)
        return sendTool(res, authorization.cancel({ key: body.key }))
      }
      if (req.method === 'GET' && path === '/session-foundations/api/cua') {
        const locale = url.searchParams.get('locale') ?? 'en'
        return send(res, 200, { ok: true, ...(await cuaSnapshot(ctx, locale)) })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/cua') {
        const body = await readJson(req)
        return sendTool(res, await cuaAction(ctx, body))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/sessions/open') {
        const body = await readJson(req)
        const opened = await provisionSession(engine, body)
        if (opened.ok === false) return send(res, 400, opened)
        return send(res, 200, {
          ...status(engine, opened.sessionId),
          fact: opened.fact,
        })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/persona/confirm') {
        const body = await readJson(req)
        if (typeof body.text !== 'string' || body.text.trim() === '')
          return send(res, 400, toolError('VALIDATION', 'text is required.'))
        const persona = engine.confirmPersona(body.text, typeof body.note === 'string' ? body.note : undefined)
        if (typeof body.sessionId === 'string' && body.sessionId !== '') {
          if (!engine.isBot(body.sessionId))
            return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can bind a persona.'))
          engine.bindPersona(body.sessionId, persona.id)
        }
        return send(res, 200, { ok: true, persona })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/memory') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') return send(res, 400, toolError('VALIDATION', 'sessionId is required.'))
        return send(res, 200, { ok: true, ...memoryView(engine, sessionId) })
      }
      if (req.method === 'GET' && path.startsWith('/session-foundations/api/memory/')) {
        const memoryHit = handleMemoryRoute(engine, path, url)
        if (memoryHit) return send(res, memoryHit.status, memoryHit.body)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/skills/register') {
        const body = await readJson(req)
        if (!engine.isBot(body.sessionId))
          return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can register a skill.'))
        const row = engine.registerSkillFromDisk(
          body.sessionId,
          body.scope === 'private' ? 'private' : 'public',
          body.skillId,
        )
        return send(res, 200, { ok: true, skill: row })
      }
      const hookMatch = /^\/session-foundations\/hooks\/([^/]+)$/.exec(path)
      if (req.method === 'POST' && hookMatch) {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const raw = await readRaw(req, 65536)
        const result = await runtime.acceptWebhook(hookMatch[1], raw, {
          timestamp: header(req, 'x-foundations-timestamp'),
          signature: header(req, 'x-foundations-signature'),
          eventId: header(req, 'x-foundations-event-id'),
        })
        return send(res, result.http, result.body)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/allow') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.allow(body.targetSessionId, body.senderSessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/deny') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.deny(body.targetSessionId, body.senderSessionId))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/messages/send') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        if (typeof body.senderSessionId !== 'string')
          return send(res, 400, toolError('VALIDATION', 'senderSessionId is required.'))
        const result = await runtime.send(body.senderSessionId, body)
        return send(res, result.ok ? 202 : 400, result)
      }
      if (req.method === 'GET' && path === '/session-foundations/api/deliveries') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, {
          ok: true,
          deliveries: runtime.listDeliveries(
            url.searchParams.get('sessionId') ?? '',
            url.searchParams.get('correlationId') ?? '',
          ),
        })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/timers') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(
          res,
          200,
          runtime.addSchedule({
            sessionId: body.sessionId,
            kind: body.kind,
            cron: body.cron,
            runAt: body.runAt,
            timezone: body.timezone,
            note: body.note,
          }),
        )
      }
      if (req.method === 'GET' && path === '/session-foundations/api/timers') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, { ok: true, timers: runtime.listSchedules() })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/timers/flags') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        if (body.deleted === true) return send(res, 200, runtime.deleteSchedule(body.id))
        return send(res, 200, runtime.setScheduleEnabled(body.id, body.enabled !== false))
      }
      if (req.method === 'POST' && path === '/session-foundations/api/webhooks') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        const created = runtime.registerWebhook(body.targetSessionId)
        if (created.ok === false) return send(res, 400, created)
        return send(res, 200, { ok: true, hook: created.hook })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/webhooks') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        return send(res, 200, { ok: true, webhooks: runtime.listWebhooks() })
      }
      if (req.method === 'POST' && path === '/session-foundations/api/webhooks/revoke') {
        const runtime = getRuntime()
        if (!runtime) return send(res, 503, toolError('UNAVAILABLE', 'Triggers are not attached to this host yet.'))
        const body = await readJson(req)
        return send(res, 200, runtime.revokeWebhook(body.id))
      }
      if (req.method === 'GET' && path === '/session-foundations/api/live') {
        const work = getWork()
        if (!work) return send(res, 503, toolError('UNAVAILABLE', 'The work host is not attached yet.'))
        return openPageLive(req, res, {
          workStamp: () => work.liveStamp(),
          workBoard: () => work.liveBoardAll(),
          loadDesk: () => loadPageDesk(req),
          interactions: () => interactionSnapshot(url.searchParams.get('sessionId') ?? '', true),
          ...(canvas ? { canvas: () => canvas.live(url.searchParams.get('sessionId') ?? '') } : {}),
        })
      }
      if (req.method === 'GET' && path === '/session-foundations/api/work/live') {
        const work = getWork()
        if (!work) return send(res, 503, toolError('UNAVAILABLE', 'The work host is not attached yet.'))
        return openWorkLive(req, res, url.searchParams.get('sessionId') ?? '', work)
      }
      if (
        canvas &&
        (path === '/session-foundations/api/canvas' || path.startsWith('/session-foundations/api/canvas/'))
      ) {
        const outcome = await handleCanvasApi(req, path, url, canvas)
        return send(res, outcome.status, outcome.body)
      }
      if (path.startsWith('/session-foundations/api/work')) {
        const workBody = req.method === 'GET' ? {} : await readJson(req)
        const workHit = await handleWorkApi(req.method ?? 'GET', path, url, workBody, getWork())
        if (workHit) return send(res, workHit.status, workHit.body)
      }
      if (req.method === 'POST' && path === '/session-foundations/api/skills/flags') {
        const body = await readJson(req)
        if (!engine.isBot(body.sessionId))
          return send(res, 400, toolError('FORBIDDEN', 'Only a bot session can change a skill.'))
        const row = engine.setSkillFlags(body.sessionId, body.skillId, {
          enabled: body.enabled,
          revoked: body.revoked,
        })
        return send(res, 200, { ok: true, skill: row })
      }
      return send(res, 404, { ok: false, code: 'NOT_FOUND' })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STORE_FAILURE'
      return send(res, code === 'VALIDATION' || code === 'NOT_FOUND' || code === 'FORBIDDEN' ? 400 : 500, {
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  ctx.effect(() => {
    const disposeFoundations = webServer.register({
      kind: 'prefix',
      path: '/session-foundations',
      handler,
    })
    const disposeDesk = webServer.register({
      kind: 'prefix',
      path: '/dsh-bot',
      handler,
    })
    const disposeLog = logOnConnection
      ? null
      : webServer.register({
          kind: 'prefix',
          path: '/api/dsh-bot',
          handler,
        })
    const disposeUpgrade =
      devUiSocket() && typeof webServer.registerUpgrade === 'function'
        ? webServer.registerUpgrade({
            path: '/dsh-bot/',
            handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
              if (reject(ctx, req)) {
                socket.destroy()
                return
              }
              proxyDevUpgrade(req, socket, head)
            },
          })
        : null
    return () => {
      if (typeof disposeFoundations === 'function') disposeFoundations()
      if (typeof disposeDesk === 'function') disposeDesk()
      if (typeof disposeLog === 'function') disposeLog()
      if (typeof disposeUpgrade === 'function') disposeUpgrade()
      try {
        canvas?.close()
      } catch {
        /* closed */
      }
    }
  })
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} sessionId
 */
export function status(engine: import('./engine.ts').Engine, sessionId: string) {
  if (sessionId === '') {
    const persona = engine.latestPersona()
    return { ok: true, persona, personaText: personaText(engine, persona) }
  }
  const binding = engine.binding(sessionId)
  const view = binding ? engine.currentView(sessionId) : null
  const persona = binding?.persona_version_id ? engine.persona(binding.persona_version_id) : null
  return {
    ok: true,
    kind: binding?.kind === 'bot' ? 'bot' : 'session',
    binding,
    view,
    persona,
    personaText: personaText(engine, persona),
    skills: binding
      ? engine.store.db
          .prepare(
            'SELECT skill_id, scope, version, enabled, revoked, content_hash FROM skill_bindings WHERE session_id = ?',
          )
          .all(sessionId)
      : [],
    isolation: 'host-session-id',
    sandbox: false,
  }
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {{ content_hash: string } | null} persona
 */
function personaText(engine: import('./engine.ts').Engine, persona: { content_hash: string } | null) {
  if (!persona) return ''
  const bytes = engine.store.readBlob('persona', persona.content_hash)
  return bytes ? bytes.toString('utf8') : ''
}

/**
 * @param {import('./engine.js').Engine} engine
 * @param {string} sessionId
 */
export function memoryView(engine: import('./engine.ts').Engine, sessionId: string) {
  return {
    facts: engine.store.db
      .prepare('SELECT id, content, status, revision, priority FROM facts WHERE session_id = ? ORDER BY id')
      .all(sessionId),
    memories: engine.store.db
      .prepare('SELECT id, title, content, status, revision FROM memories WHERE session_id = ? ORDER BY id')
      .all(sessionId),
    state: engine.statePayload(sessionId),
  }
}

/**
 * A live store entry means some fiber still has the session open.
 * The caller must inject `sessions`. Reading it without inject throws.
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
export function attachedSession(ctx: HostContext, sessionId: string) {
  const sessions = ctx.sessions as { get?: (id: string) => unknown } | undefined
  return typeof sessions?.get === 'function' && sessions.get(sessionId) != null
}

/**
 * Drop an idle session another fiber still has open, then let the caller delete its log.
 * The host has no delete RPC. The store entry's detach is the same disposer `enter` keeps,
 * and it emits `session/disposed`, which closes the JSONL writer.
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
export async function unloadAttachedSession(ctx: HostContext, sessionId: string) {
  const agent = liveAgentOf(ctx, sessionId)
  if (agent && typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'hook', reason: 'session-delete' }, { keepInbox: false })
    } catch {
      /* already idle */
    }
  }
  if (agent && typeof agent.whenIdle === 'function') await agent.whenIdle()
  const writer = sessionWriter(ctx, sessionId)
  if (writer && typeof writer.close === 'function') await writer.close()
  detachAgentEntry(ctx, sessionId)
  detachSessionEntry(ctx, sessionId)
}

/**
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
function liveAgentOf(ctx: HostContext, sessionId: string) {
  try {
    return ctx.agents?.get?.(sessionId) ?? null
  } catch {
    return null
  }
}

/**
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
function sessionWriter(ctx: HostContext, sessionId: string) {
  const writers = ctx.sessionPersistence?.tracker?.writers
  if (!writers || typeof writers.get !== 'function') return null
  const writer = writers.get(sessionId)
  return writer && typeof writer === 'object' ? writer : null
}

/**
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
function detachAgentEntry(ctx: HostContext, sessionId: string) {
  const agents = ctx.agents
  const entry = agents?.store?.get?.(sessionId)
  if (!entry || typeof agents.detachEntered !== 'function') return
  agents.detachEntered(entry)
}

/**
 * @param {import('./host.ts').HostContext} ctx
 * @param {string} sessionId
 */
function detachSessionEntry(ctx: HostContext, sessionId: string) {
  const entry = ctx.sessions?.store?.get?.(sessionId)
  if (entry && typeof entry.detach === 'function') entry.detach()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} req
 */
function reject(ctx: HostContext, req: import('node:http').IncomingMessage) {
  const connection = probeConnection(ctx)
  const rejection = connection?.requestRejection?.(req)
  if (rejection !== undefined) return rejection
  const remote = req.socket?.remoteAddress ?? ''
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return 403
  return 0
}

function imageMedia(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return null
}

function pipeDownload(
  res: import('node:http').ServerResponse,
  opened: { status: number; body: { error: string } } | { status: 200; name: string; size: number; stream: ReadStream },
  inline = false,
) {
  if (!('stream' in opened)) return send(res, opened.status, opened.body)
  const encoded = encodeURIComponent(opened.name)
  const image = inline ? imageMedia(opened.name) : null
  res.writeHead(opened.status, {
    'content-type': image ?? 'application/octet-stream',
    'content-length': opened.size,
    'content-disposition': image ? `inline; filename*=UTF-8''${encoded}` : `attachment; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  opened.stream.on('error', () => res.destroy())
  res.on('close', () => opened.stream.destroy())
  opened.stream.pipe(res)
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  if (status === 0) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendTool(res: import('node:http').ServerResponse, result: ToolPayload) {
  if (result.ok !== false) return send(res, 200, result)
  const status =
    result.code === 'NOT_FOUND'
      ? 404
      : result.code === 'CONFLICT' || result.code === 'ALREADY_IN_FLIGHT' || result.code === 'REPLY_QUEUED'
        ? 409
        : result.code === 'FORBIDDEN'
          ? 403
          : result.code === 'UNAVAILABLE'
            ? 503
            : 400
  return send(res, status, result)
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 */
function header(req: DeskRequest | import('node:http').IncomingMessage, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 */
function readRaw(req: import('node:http').IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: any[] = []
    let size = 0
    req.on('data', (chunk: any) => {
      size += chunk.length
      if (size > max) {
        rejectPromise(Object.assign(new Error('The body is too long.'), { code: 'VALIDATION' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

function readJson(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: any[] = []
    req.on('data', (chunk: any) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        rejectPromise(Object.assign(new Error('invalid json'), { code: 'VALIDATION', cause: error }))
      }
    })
    req.on('error', rejectPromise)
  })
}

/**
 * Call the host RPC on this same DSH process. The cookie is the browser session cookie.
 * This process does not read the launch token.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} endpoint
 * @param {Record<string, unknown>} args
 */
async function sessionListedRunning(req: DeskRequest, sessionId: string): Promise<boolean | null> {
  const listed = await hostRpc(req, 'session/list', { _request: {} })
  const items = listed.body?.result?.value?.items
  if (listed.body?.result?.ok !== true || !Array.isArray(items)) return null
  const item = items.find((entry: { sessionId?: string }) => entry?.sessionId === sessionId)
  if (!item) return false
  return item.running === true
}

async function stopForDelete(ctx: HostContext, sessionId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([
    unloadAttachedSession(ctx, sessionId).then(
      () => true,
      () => true,
    ),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 15_000)
    }),
  ])
  clearTimeout(timer)
  return stopped
}

function writeDeleteStream(res: import('node:http').ServerResponse, job: DeleteJob) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })
  let finished = false
  const write = (event: DeleteProgress) => {
    if (finished || res.writableEnded) return
    res.write(`${JSON.stringify(event)}\n`)
  }
  const finish = () => {
    if (finished) return
    finished = true
    job.unlisten(listener)
    if (!res.writableEnded) res.end()
  }
  const listener = (event: DeleteProgress) => {
    write(event)
    if (event.phase === 'done' || event.phase === 'error') finish()
  }
  job.listen(listener)
  write(job.latest)
  res.on('close', () => {
    job.unlisten(listener)
  })
  void job.promise.finally(finish)
}

async function hostRpc(req: DeskRequest, endpoint: string, args: Record<string, unknown>) {
  const origin = localOrigin(req)
  const cookie = header(req, 'cookie') ?? ''
  if (origin === '' || cookie === '') {
    return {
      status: 503,
      body: {
        result: {
          ok: false,
          error: { code: 'primary_unready', message: 'This process has not issued a session cookie yet.' },
        },
      },
    }
  }
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie,
      origin,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: { args },
    }),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const result = parsed?.result ?? { ok: false, error: { code: 'bad-response', message: `HTTP ${response.status}` } }
  return { status: response.status, body: { result } }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function hostUsage(req: DeskRequest) {
  const origin = localOrigin(req)
  const cookie = header(req, 'cookie') ?? ''
  if (origin === '' || cookie === '')
    return { connected: false, code: 'primary_unready', error: 'This process has not issued a session cookie yet.' }
  let response
  try {
    response = await fetch(`${origin}/ollama-usage/api/summary`, {
      headers: { accept: 'application/json', cookie, origin },
    })
  } catch {
    return { connected: false, code: 'primary_down', error: 'The runtime could not be reached.' }
  }
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (response.status === 404)
    return { connected: false, code: 'usage_not_installed', error: 'The usage plugin is not installed.' }
  if (!body || body.ok !== true) {
    return {
      connected: false,
      code: 'usage_unconfigured',
      status: response.status,
      error: typeof body?.error === 'string' ? body.error : 'The usage upstream is unavailable.',
    }
  }
  return { connected: true, summary: body }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function localOrigin(req: DeskRequest) {
  const port = req.socket?.localPort
  if (!port) return ''
  const address = req.socket?.localAddress ?? ''
  const host = address === '::1' ? '[::1]' : '127.0.0.1'
  return `http://${host}:${port}`
}

const DESK_DIR = fileURLToPath(new URL('../public/', import.meta.url))
const DESK_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
])

/**
 * Absolute Unix socket where the dev Vite server listens.
 * Unset in production, where `/dsh-bot/` is read from `public/`.
 */
export function devUiSocket(): string | null {
  const raw = process.env.DSH_BOT_UI_DEV
  if (!raw || !isAbsolute(raw)) return null
  return raw
}

/**
 * Forward one workbench document or asset to the Vite socket.
 * A connection failure returns false so the caller can serve `public/`.
 */
export function proxyDevUi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const socketPath = devUiSocket()
  if (!socketPath) return Promise.resolve(false)
  return new Promise(resolvePromise => {
    let settled = false
    const finish = (proxied: boolean) => {
      if (settled) return
      settled = true
      resolvePromise(proxied)
    }
    const headers = { ...req.headers }
    delete headers.connection
    delete headers['transfer-encoding']
    const proxy = httpRequest(
      {
        socketPath,
        method: req.method,
        path: req.url,
        headers,
      },
      upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
        finish(true)
      },
    )
    proxy.on('error', () => {
      proxy.destroy()
      finish(false)
    })
    req.pipe(proxy)
  })
}

/** Forward the workbench hot-reload upgrade to the Vite socket. */
export function proxyDevUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const socketPath = devUiSocket()
  if (!socketPath) {
    socket.destroy()
    return
  }
  const upstream = connectSocket(socketPath)
  const fail = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', fail)
  socket.on('error', () => upstream.destroy())
  upstream.once('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || key === 'transfer-encoding') continue
      const items = Array.isArray(value) ? value : [value]
      for (const item of items) lines.push(`${key}: ${item}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
}

/** Workbench files built into public/. API routes are handled before this. */
function serveDesk(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  pathname: string,
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const rel = pathname === '/dsh-bot' ? 'index.html' : pathname.slice('/dsh-bot/'.length)
  let decoded = rel
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return false
  }
  if (decoded === '' || decoded.includes('\0') || decoded.includes('..')) return false
  const root = resolve(DESK_DIR)
  const file = resolve(root, decoded)
  if (file !== root && !file.startsWith(root + sep)) return false
  let stat
  try {
    stat = statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  res.writeHead(200, {
    'content-type': DESK_TYPES.get(extname(file)) ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
  return true
}

async function asFetchRequest(req: import('node:http').IncomingMessage) {
  const host = req.headers.host ?? '127.0.0.1'
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    }
  }
  return new Request(url, { method: req.method ?? 'GET', headers })
}

async function sendFetchResponse(res: import('node:http').ServerResponse, response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0)
  res.writeHead(response.status, headers)
  res.end(body)
}
