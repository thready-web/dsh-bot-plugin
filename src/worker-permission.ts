/**
 * Copy a parent main session's effective permission onto a worker at creation.
 *
 * The host pins its composition default, usually `workspace-write`, from an
 * `agent/created` listener registered with `prepend: true`. That pin runs
 * before this plugin's listener. The listener then calls
 * `permissionPresets.set` with the parent preset, the same setter a main
 * session uses, so sandbox mode and approval policy both change.
 *
 * The preset is snapshotted when the worker is dispatched, before
 * `agents.create`. It is applied once. A later change on the parent does
 * not walk workers that already exist, and a resume, clear, or compaction
 * does not apply it again. The intent lives only in this process: a crash
 * between create and the permission write leaves the host pin, and a later
 * restart does not repair that worker. This module does not write the host
 * `permission` settings namespace, so unrelated new agents keep the host pin.
 */
import type { HostContext } from './host.ts'
import { effectivePermission, permissionView, setPermission } from './permissions.ts'

const WORKER_ID = /^worker-[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKIP_SOURCE = new Set(['resume', 'clear', 'compact'])

export type WorkerPermissionIntent = {
  workerId: string
  parentId: string
  /** Selectable preset snapshotted from the parent. Empty means fail closed. */
  preset: string
  reason: string
}

const pending = new Map<string, WorkerPermissionIntent>()

function snapshotParent(ctx: HostContext, parentId: string): { preset: string; reason: string } {
  if (typeof parentId !== 'string' || parentId === '') return { preset: '', reason: 'missing' }
  const effective = effectivePermission(ctx, parentId)
  if (!effective.available) return { preset: '', reason: 'unavailable' }
  if (!effective.found || effective.preset === '') return { preset: '', reason: 'missing' }
  if (effective.preset === 'custom') return { preset: '', reason: 'custom' }
  const known = permissionView(ctx, '').options.some(option => option.value === effective.preset)
  if (!known) return { preset: '', reason: 'invalid' }
  return { preset: effective.preset, reason: 'ok' }
}

/**
 * Record the parent preset before `agents.create`. A worker id that does not
 * match the ticket child form is ignored, so this cannot arm an unrelated agent.
 */
export function rememberWorkerPermission(
  ctx: HostContext,
  workerId: string,
  parentId: string,
): WorkerPermissionIntent | null {
  if (!WORKER_ID.test(workerId)) return null
  const snap = snapshotParent(ctx, parentId)
  const intent: WorkerPermissionIntent = {
    workerId,
    parentId,
    preset: snap.preset,
    reason: snap.reason,
  }
  pending.set(workerId, intent)
  return intent
}

/** Drop an intent when create fails before a worker exists. */
export function dropWorkerPermission(workerId: string) {
  pending.delete(workerId)
}

/** Test isolation. Production create either applies or drops its own intent. */
export function clearPendingWorkerPermissions() {
  pending.clear()
}

export function pendingWorkerPermission(workerId: string) {
  return pending.get(workerId) ?? null
}

/**
 * Apply the snapshotted parent preset once.
 * `resume`, `clear`, and `compact` do not consume the intent: those events
 * are not the creation pin. A missing source is treated as creation because
 * the only writer of an intent is the dispatch create path.
 * An empty snapshot fails closed: the host pin is left in place, and the
 * instance default is not substituted.
 */
export function applyWorkerPermission(
  ctx: HostContext,
  workerId: string,
  source = 'startup',
): { applied: boolean; reason: string; preset?: string } {
  const intent = pending.get(workerId)
  if (!intent) return { applied: false, reason: 'not-pending' }
  if (SKIP_SOURCE.has(source)) return { applied: false, reason: 'not-startup' }
  if (intent.preset === '') {
    pending.delete(workerId)
    return { applied: false, reason: intent.reason }
  }
  const result = setPermission(ctx, workerId, intent.preset)
  if (result.ok === false) {
    if (result.code === 'NOT_FOUND' || result.code === 'UNAVAILABLE') return { applied: false, reason: 'rejected' }
    pending.delete(workerId)
    return { applied: false, reason: 'rejected' }
  }
  pending.delete(workerId)
  return { applied: true, reason: 'applied', preset: intent.preset }
}
