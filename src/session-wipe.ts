/** Remove rows and files that belong to a bot and the workers derived from it. */

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasStore } from './canvas-store.ts'
import { eraseSessionStorage } from './session-files.ts'
import { now, type SqlDatabase, type Store } from './store.ts'

const STORED_ID = /^(?:session|worker)-[A-Za-z0-9-]+$/

export function sessionClosure(db: SqlDatabase, ownerId: string) {
  const ids = new Set<string>([ownerId])
  let grew = true
  while (grew) {
    grew = false
    const list = [...ids]
    const marks = list.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT child_session_id AS id FROM work_tickets
         WHERE owner_session_id IN (${marks}) AND child_session_id IS NOT NULL
         UNION
         SELECT a.child_session_id AS id FROM work_attempts a
         JOIN work_tickets t ON t.id = a.ticket_id
         WHERE t.owner_session_id IN (${marks}) AND a.child_session_id IS NOT NULL
         UNION
         SELECT session_id AS id FROM session_bindings
         WHERE fork_parent_session_id IN (${marks}) AND session_id IS NOT NULL`,
      )
      .all(...list, ...list, ...list) as Array<{ id?: string }>
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id === '' || ids.has(row.id)) continue
      ids.add(row.id)
      grew = true
    }
  }
  return [...ids]
}

/** Stop schedules and open tickets before the turns are cancelled. */
export async function quietSessions(store: Store, sessionIds: readonly string[]) {
  const ids = unique(sessionIds)
  if (ids.length === 0) return
  const marks = ids.map(() => '?').join(', ')
  const stamp = now()
  await store.write('work', () => {
    store.db
      .prepare(`UPDATE schedules SET enabled = 0, updated_at = ? WHERE session_id IN (${marks})`)
      .run(stamp, ...ids)
    store.db
      .prepare(
        `UPDATE work_tickets SET status = 'cancelled', updated_at = ?
         WHERE owner_session_id IN (${marks})
           AND status IN ('accepted','enqueued','started','needs_user','ready')`,
      )
      .run(stamp, ...ids)
    store.db
      .prepare(
        `UPDATE work_attempts SET status = 'cancelled', ended_at = ?
         WHERE status IN ('starting','enqueued','started')
           AND (
             child_session_id IN (${marks})
             OR ticket_id IN (SELECT id FROM work_tickets WHERE owner_session_id IN (${marks}))
           )`,
      )
      .run(stamp, ...ids, ...ids)
  })
}

/**
 * Delete session-owned rows, then content-addressed files nothing else references.
 * Shared persona text, public skill blobs, and the workspace directory stay.
 */
export async function deleteOwnedSessions(store: Store, sessionIds: readonly string[]) {
  const ids = unique(sessionIds)
  if (ids.length === 0) return
  const written = await store.write('session-delete', () => deleteOwnedRows(store.db, ids))
  const hookIds = Array.isArray(written) ? written.filter((id): id is string => typeof id === 'string') : []
  removeOwnedFiles(store, ids, hookIds)
}

export function deleteOwnedCanvases(canvas: CanvasStore, sessionIds: readonly string[]) {
  canvas.deleteSessions(unique(sessionIds))
}

export function deleteOwnedLogs(input: { sessionsRoot: string; stateRoot: string; sessionIds: readonly string[] }) {
  for (const sessionId of unique(input.sessionIds)) {
    if (!STORED_ID.test(sessionId)) continue
    eraseSessionStorage({ sessionsRoot: input.sessionsRoot, stateRoot: input.stateRoot, sessionId })
  }
}

function deleteOwnedRows(db: SqlDatabase, ids: string[]) {
  const marks = ids.map(() => '?').join(', ')
  const ticketIds = db
    .prepare(`SELECT id FROM work_tickets WHERE owner_session_id IN (${marks})`)
    .all(...ids) as Array<{ id: string }>
  const tickets = ticketIds.map(row => row.id)
  const ticketMarks = tickets.length > 0 ? tickets.map(() => '?').join(', ') : ''
  const hookRows = db
    .prepare(`SELECT id FROM webhook_hooks WHERE target_session_id IN (${marks})`)
    .all(...ids) as Array<{ id: string }>

  db.prepare(
    `DELETE FROM user_deliveries WHERE owner_session_id IN (${marks})
     ${ticketMarks ? `OR ticket_id IN (${ticketMarks})` : ''}`,
  ).run(...ids, ...tickets)
  if (ticketMarks) {
    db.prepare(`DELETE FROM work_events WHERE ticket_id IN (${ticketMarks})`).run(...tickets)
    db.prepare(`DELETE FROM work_notices WHERE owner_session_id IN (${marks}) OR ticket_id IN (${ticketMarks})`).run(
      ...ids,
      ...tickets,
    )
    db.prepare(`DELETE FROM work_inputs WHERE ticket_id IN (${ticketMarks})`).run(...tickets)
    db.prepare(`DELETE FROM work_attempts WHERE ticket_id IN (${ticketMarks}) OR child_session_id IN (${marks})`).run(
      ...tickets,
      ...ids,
    )
  } else {
    db.prepare(`DELETE FROM work_notices WHERE owner_session_id IN (${marks})`).run(...ids)
    db.prepare(`DELETE FROM work_attempts WHERE child_session_id IN (${marks})`).run(...ids)
  }
  db.prepare(`DELETE FROM work_tickets WHERE owner_session_id IN (${marks})`).run(...ids)

  db.prepare(
    `DELETE FROM schedule_fires WHERE schedule_id IN (SELECT id FROM schedules WHERE session_id IN (${marks}))`,
  ).run(...ids)
  db.prepare(`DELETE FROM schedules WHERE session_id IN (${marks})`).run(...ids)
  db.prepare(
    `DELETE FROM webhook_receipts WHERE hook_id IN (SELECT id FROM webhook_hooks WHERE target_session_id IN (${marks}))`,
  ).run(...ids)
  db.prepare(`DELETE FROM webhook_hooks WHERE target_session_id IN (${marks})`).run(...ids)
  db.prepare(`DELETE FROM deliveries WHERE target_session_id IN (${marks}) OR sender_session_id IN (${marks})`).run(
    ...ids,
    ...ids,
  )
  db.prepare(`DELETE FROM delivery_acl WHERE target_session_id IN (${marks}) OR sender_session_id IN (${marks})`).run(
    ...ids,
    ...ids,
  )
  db.prepare(`DELETE FROM delivery_block WHERE target_session_id IN (${marks}) OR sender_session_id IN (${marks})`).run(
    ...ids,
    ...ids,
  )

  db.prepare(
    `DELETE FROM export_outbox WHERE session_id IN (${marks})
     OR mutation_id IN (SELECT id FROM mutations WHERE scope IN (${marks}))`,
  ).run(...ids, ...ids)
  db.prepare(`DELETE FROM mutations WHERE scope IN (${marks})`).run(...ids)
  db.prepare(`DELETE FROM view_revisions WHERE session_id IN (${marks})`).run(...ids)
  db.prepare(`DELETE FROM skill_bindings WHERE session_id IN (${marks})`).run(...ids)
  db.prepare(`DELETE FROM working_state WHERE session_id IN (${marks})`).run(...ids)
  db.prepare(
    `UPDATE facts SET supersedes = NULL WHERE supersedes IN (SELECT id FROM facts WHERE session_id IN (${marks}))`,
  ).run(...ids)
  db.prepare(`DELETE FROM facts WHERE session_id IN (${marks})`).run(...ids)
  rebuildFts(
    db,
    'facts_fts',
    'content',
    db.prepare('SELECT id, content FROM facts').all() as Array<{ id: number; content: string }>,
  )
  db.prepare(
    `UPDATE memories SET supersedes = NULL WHERE supersedes IN (SELECT id FROM memories WHERE session_id IN (${marks}))`,
  ).run(...ids)
  db.prepare(`DELETE FROM memories WHERE session_id IN (${marks})`).run(...ids)
  rebuildMemoryFts(db)
  db.prepare(`DELETE FROM session_bindings WHERE session_id IN (${marks})`).run(...ids)
  db.prepare(
    `DELETE FROM persona_versions WHERE id NOT IN (
       SELECT persona_version_id FROM session_bindings WHERE persona_version_id IS NOT NULL
       UNION
       SELECT persona_version_id FROM view_revisions WHERE persona_version_id IS NOT NULL
     )`,
  ).run()
  return hookRows.map(row => row.id)
}

function rebuildFts(db: SqlDatabase, table: string, column: string, rows: Array<{ id: number; content: string }>) {
  db.exec(`INSERT INTO ${table}(${table}) VALUES('delete-all')`)
  const insert = db.prepare(`INSERT INTO ${table}(rowid, ${column}) VALUES (?, ?)`)
  for (const row of rows) insert.run(row.id, row.content)
}

function rebuildMemoryFts(db: SqlDatabase) {
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('delete-all')`)
  const insert = db.prepare('INSERT INTO memories_fts(rowid, title, content) VALUES (?, ?, ?)')
  const rows = db.prepare('SELECT id, title, content FROM memories').all() as Array<{
    id: number
    title: string | null
    content: string
  }>
  for (const row of rows) insert.run(row.id, row.title ?? '', row.content)
}

function removeOwnedFiles(store: Store, sessionIds: string[], hookIds: string[]) {
  const root = store.root
  for (const sessionId of sessionIds) {
    if (!STORED_ID.test(sessionId)) continue
    removeTree(join(root, 'export', sessionId))
    removeTree(join(root, 'src', 'skills', 'private', sessionId))
  }
  for (const hookId of hookIds) {
    if (!/^[A-Za-z0-9-]+$/.test(hookId)) continue
    removeFile(join(root, 'secrets', 'webhooks', `${hookId}.key`))
  }
  const personaHashes = hashSet(store.db, 'SELECT content_hash AS hash FROM persona_versions')
  sweepDirectory(join(root, 'blobs', 'persona'), file => file.endsWith('.md') && !personaHashes.has(file.slice(0, -3)))
  const skillHashes = hashSet(store.db, 'SELECT content_hash AS hash FROM skill_bindings')
  sweepDirectory(join(root, 'blobs', 'skills'), name => !skillHashes.has(name), true)
  const workHashes = hashSet(
    store.db,
    `SELECT briefing_hash AS hash FROM work_tickets
     UNION SELECT payload_hash AS hash FROM work_inputs
     UNION SELECT payload_hash AS hash FROM work_events`,
  )
  sweepDirectory(join(root, 'blobs', 'work'), file => file.endsWith('.txt') && !workHashes.has(file.slice(0, -4)))
}

function hashSet(db: SqlDatabase, sql: string) {
  const rows = db.prepare(sql).all() as Array<{ hash?: string | null }>
  const hashes = new Set<string>()
  for (const row of rows) if (typeof row.hash === 'string' && row.hash !== '') hashes.add(row.hash)
  return hashes
}

function sweepDirectory(dir: string, unused: (name: string) => boolean, directory = false) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === '.' || name === '..' || !unused(name)) continue
    const target = join(dir, name)
    if (lstatSync(target).isSymbolicLink()) continue
    if (directory) rmSync(target, { recursive: true, force: true })
    else removeFile(target)
  }
}

function removeTree(dir: string) {
  if (!existsSync(dir)) return
  if (lstatSync(dir).isSymbolicLink()) return
  rmSync(dir, { recursive: true, force: true })
}

function removeFile(file: string) {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return
  rmSync(file, { force: true })
}

function unique(sessionIds: readonly string[]) {
  return [...new Set(sessionIds.filter(id => id !== ''))]
}
