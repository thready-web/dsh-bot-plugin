/** Remove one session's on-disk log. DSH has no delete RPC; session/list rescans these directories. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

const SESSION_ID = /^session-[A-Za-z0-9-]+$/
const STORED_ID = /^(?:session|worker)-[A-Za-z0-9-]+$/

/**
 * Same project-directory key as @deepseek-ai/dsh-session-persistence-jsonl.
 * @param {string} cwd
 */
export function projectKey(cwd: string) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * @param {string} sessionsRoot
 * @param {string} cwd
 * @param {string} sessionId
 */
export function sessionDirectory(sessionsRoot: string, cwd: string, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new Error('session id is not a storage name')
  const root = resolve(sessionsRoot)
  const dir = resolve(root, projectKey(cwd), sessionId)
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error('session path escapes the session root')
  return dir
}

/**
 * @param {string} root
 * @param {string} target
 */
function inside(root: string, target: string) {
  const base = resolve(root)
  const file = resolve(target)
  return file === base || file.startsWith(base + sep)
}

/**
 * On-disk mark beside the session log. The plugin's kind column is the behavior gate;
 * this file is the mark you can see in the session directory.
 * @param {{ sessionsRoot: string, cwd: string, sessionId: string, name?: string }} input
 */
export function writeBotMarker(input: { sessionsRoot: string; cwd: string; sessionId: string; name?: string }) {
  const dir = sessionDirectory(input.sessionsRoot, input.cwd, input.sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'bot.json')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  writeFileSync(
    file,
    `${JSON.stringify({ kind: 'bot', sessionId: input.sessionId, ...(name ? { name } : {}) }, null, 2)}\n`,
    { mode: 0o644 },
  )
  return file
}

/**
 * @param {{ sessionsRoot: string, cacheFile: string, workspaceFile: string, sessionId: string, cwd: string }} input
 */
export function purgeSessionFiles(input: {
  sessionsRoot: string
  cacheFile: string
  workspaceFile: string
  sessionId: string
  cwd: string
}) {
  const dir = sessionDirectory(input.sessionsRoot, input.cwd, input.sessionId)
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('refusing to delete a symlink')
    const realRoot = realpathSync(input.sessionsRoot)
    const realDir = realpathSync(dir)
    if (!inside(realRoot, realDir)) throw new Error('session path escapes the session root')
    rmSync(dir, { recursive: true, force: true })
  }
  if (input.cacheFile !== '' && existsSync(input.cacheFile)) {
    if (!lstatSync(input.cacheFile).isSymbolicLink()) rmSync(input.cacheFile, { force: true })
  }
  forgetWorkspaceId(input.workspaceFile, input.sessionId)
}

/**
 * Remove one session's log directory, project cache, and workspace.json id.
 * The directory is found by name under the sessions root, so a worker does not
 * need the owner's cwd. The workspace directory itself stays.
 * @param {{ sessionsRoot: string, stateRoot: string, sessionId: string }} input
 */
export function eraseSessionStorage(input: { sessionsRoot: string; stateRoot: string; sessionId: string }) {
  if (!STORED_ID.test(input.sessionId)) throw new Error('session id is not a storage name')
  if (input.sessionsRoot !== '' && existsSync(input.sessionsRoot)) {
    const realRoot = realpathSync(input.sessionsRoot)
    for (const project of readdirSync(realRoot)) {
      const dir = join(realRoot, project, input.sessionId)
      if (!existsSync(dir)) continue
      if (lstatSync(dir).isSymbolicLink()) throw new Error('refusing to delete a symlink')
      const realDir = realpathSync(dir)
      if (!inside(realRoot, realDir)) throw new Error('session path escapes the session root')
      rmSync(realDir, { recursive: true, force: true })
    }
  }
  const cache =
    input.stateRoot === ''
      ? ''
      : join(input.stateRoot, 'storages', 'session_projcache', 'sessions', `${input.sessionId}.json`)
  if (cache !== '' && existsSync(cache) && !lstatSync(cache).isSymbolicLink()) rmSync(cache, { force: true })
  if (input.stateRoot !== '') forgetWorkspaceId(join(input.stateRoot, 'storages', 'workspace.json'), input.sessionId)
}

/**
 * @param {string} workspaceFile
 * @param {string} sessionId
 */
export function forgetWorkspaceId(workspaceFile: string, sessionId: string) {
  if (!existsSync(workspaceFile)) return
  const data = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  if (data?.global && Array.isArray(data.global.archivedSessionIds)) {
    data.global.archivedSessionIds = data.global.archivedSessionIds.filter((id: string) => id !== sessionId)
  }
  const workspaces = data?.tables?.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const row of Object.values(workspaces)) {
      if (!row || typeof row !== 'object') continue
      const record = row as { sessionIds?: string[] }
      if (!Array.isArray(record.sessionIds)) continue
      record.sessionIds = record.sessionIds.filter(id => id !== sessionId)
    }
  }
  writeFileSync(workspaceFile, `${JSON.stringify(data, null, 2)}\n`)
}
