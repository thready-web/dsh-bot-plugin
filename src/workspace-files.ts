/**
 * Workbench file browser. Workspace and a separate home directory are readable.
 * DSH_HOME, the filesystem root, and /etc stay closed.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  type ReadStream,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

/** Explicit file-drawer home. Independent of process HOME. */
export const FILES_HOME_ENV = 'THREADY_FILES_HOME'

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_TEXT_BYTES = 1024 * 1024

export type FileError =
  | 'denied'
  | 'missing'
  | 'not_directory'
  | 'not_file'
  | 'binary'
  | 'too_large'
  | 'exists'
  | 'bad_name'
  | 'bad_path'

export type FileResult<T> = { ok: true; value: T } | { ok: false; error: FileError }

export interface FileRoots {
  workspace: string | null
  workspaceReason: '' | 'overlap' | 'missing' | 'forbidden'
  home: string | null
  homeReason: '' | 'missing' | 'forbidden' | 'invalid'
}

export interface FileAccess {
  roots: FileRoots
  dshHome: string | null
}

export interface FileEntry {
  name: string
  kind: 'dir' | 'file' | 'link'
  size: number
  mtime: string
}

export interface ListedDirectory {
  path: string
  root: 'workspace' | 'home'
  items: FileEntry[]
}

/**
 * Candidate home directory. A non-empty plugin config wins over THREADY_FILES_HOME,
 * which wins over HOME. A non-string config selects nothing, so it is not replaced
 * by HOME or the environment. This does not write the process environment.
 */
export function selectBrowserHome(env: Record<string, string | undefined>, configured?: unknown): string {
  if (configured != null && typeof configured !== 'string') return ''
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = env[FILES_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : ''
  if (home !== '') return home
  return homedir()
}

/**
 * Real paths the browser may use. A workspace that is DSH_HOME, or that contains it, is unusable.
 * The workspace directory itself stays allowed when it lives at <DSH_HOME>/workspace.
 * `legacyWorkspace` is used only when the stored cwd is exactly DSH_HOME. Any other overlap stays closed.
 */
export function resolveFileRoots(input: {
  workspace: string
  home: string
  dshHome: string
  legacyWorkspace?: string
}): FileAccess {
  const dshHome = realDirectory(input.dshHome).path
  const home = resolveHome(input.home, dshHome)
  const workspace = resolveWorkspace(input.workspace, dshHome, input.legacyWorkspace)
  return {
    roots: {
      workspace: workspace.workspace,
      workspaceReason: workspace.workspaceReason,
      home: home.home,
      homeReason: home.homeReason,
    },
    dshHome,
  }
}

export function listDirectory(filePath: string, access: FileAccess): FileResult<ListedDirectory> {
  const located = locate(filePath, access)
  if (!located.ok) return located
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(located.value.path)
  } catch {
    return { ok: false, error: 'missing' }
  }
  if (!stat.isDirectory()) return { ok: false, error: 'not_directory' }
  let names: string[]
  try {
    names = readdirSync(located.value.path)
  } catch {
    return { ok: false, error: 'denied' }
  }
  const items: FileEntry[] = []
  for (const name of names) {
    if (name.startsWith('.upload-') && name.endsWith('.tmp')) continue
    const child = join(located.value.path, name)
    let childStat: ReturnType<typeof lstatSync>
    try {
      childStat = lstatSync(child)
    } catch {
      continue
    }
    let real: string
    try {
      real = realpathSync(child)
    } catch {
      continue
    }
    if (!rootOf(real, access)) continue
    const mtime = new Date(childStat.mtimeMs).toISOString()
    if (childStat.isSymbolicLink()) {
      items.push({ name, kind: 'link', size: 0, mtime })
      continue
    }
    if (childStat.isDirectory()) {
      items.push({ name, kind: 'dir', size: 0, mtime })
      continue
    }
    if (childStat.isFile()) items.push({ name, kind: 'file', size: childStat.size, mtime })
  }
  items.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (a.kind !== 'dir' && b.kind === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return { ok: true, value: { path: located.value.path, root: located.value.root, items } }
}

export function readFileText(filePath: string, access: FileAccess): FileResult<{ text: string; eof: boolean }> {
  const opened = openFile(filePath, access)
  if (!opened.ok) return opened
  try {
    const size = opened.value.size
    if (size === 0) return { ok: true, value: { text: '', eof: true } }
    const bytes = readFd(opened.value.fd, Math.min(size, MAX_TEXT_BYTES))
    if (bytes.includes(0)) return { ok: false, error: 'binary' }
    return { ok: true, value: { text: bytes.toString('utf8'), eof: size <= MAX_TEXT_BYTES } }
  } finally {
    closeSync(opened.value.fd)
  }
}

export function openDownload(
  filePath: string,
  access: FileAccess,
): FileResult<{ name: string; size: number; stream: ReadStream }> {
  const opened = openFile(filePath, access)
  if (!opened.ok) return opened
  const stream = createReadStream('', { fd: opened.value.fd, autoClose: true, start: 0 })
  return {
    ok: true,
    value: { name: basename(opened.value.path), size: opened.value.size, stream },
  }
}

/**
 * Write one file into an allowed directory. `maxBytes` stops the copy without destroying the request socket.
 */
export function saveUploadFile(
  dir: string,
  name: string,
  source: Readable,
  access: FileAccess,
  options: { overwrite: boolean; maxBytes: number },
): Promise<FileResult<{ path: string; size: number }>> {
  const safe = safeFileName(name)
  if (!safe) return Promise.resolve({ ok: false, error: 'bad_name' })
  const located = locate(dir, access)
  if (!located.ok) return Promise.resolve(located)
  let dirStat: ReturnType<typeof lstatSync>
  try {
    dirStat = lstatSync(located.value.path)
  } catch {
    return Promise.resolve({ ok: false, error: 'missing' })
  }
  if (!dirStat.isDirectory()) return Promise.resolve({ ok: false, error: 'not_directory' })
  const dest = join(located.value.path, safe)
  let existing: ReturnType<typeof lstatSync> | null = null
  try {
    existing = lstatSync(dest)
  } catch {
    existing = null
  }
  if (existing?.isSymbolicLink()) return Promise.resolve({ ok: false, error: 'denied' })
  if (existing?.isDirectory()) return Promise.resolve({ ok: false, error: 'exists' })
  if (existing && !options.overwrite) return Promise.resolve({ ok: false, error: 'exists' })
  const tmp = join(located.value.path, `.upload-${randomBytes(8).toString('hex')}.tmp`)
  return writeBounded(source, tmp, options.maxBytes).then(written => {
    if (!written.ok) return written
    try {
      renameSync(tmp, dest)
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        /* the failed temp is hidden from listings */
      }
      return { ok: false, error: 'denied' as const }
    }
    return { ok: true, value: { path: dest, size: written.value } }
  })
}

export function safeFileName(value: string): string | null {
  if (value.length === 0 || value.length > 255) return null
  if (value === '.' || value === '..') return null
  if (/[/\\\u0000]/.test(value)) return null
  if (basename(value) !== value) return null
  return value
}

function resolveHome(
  candidate: string,
  dshHome: string | null,
): { home: string | null; homeReason: FileRoots['homeReason'] } {
  const found = realDirectory(candidate)
  if (!found.path) return { home: null, homeReason: found.reason === 'invalid' ? 'invalid' : 'missing' }
  if (isForbiddenLocation(found.path) || (dshHome != null && inside(dshHome, found.path))) {
    return { home: null, homeReason: 'forbidden' }
  }
  return { home: found.path, homeReason: '' }
}

/**
 * A stored cwd of exactly DSH_HOME can fall back to the configured session workspace.
 * A cwd that merely contains DSH_HOME, or that is `/` or `/etc`, cannot.
 */
function resolveWorkspace(
  candidate: string,
  dshHome: string | null,
  legacy: string | undefined,
): { workspace: string | null; workspaceReason: FileRoots['workspaceReason'] } {
  const found = realDirectory(candidate)
  if (!found.path) return { workspace: null, workspaceReason: 'missing' }
  if (dshHome != null && found.path === dshHome) {
    const fallback = legacy ? realDirectory(legacy).path : null
    if (fallback != null && fallback !== found.path && safeWorkspace(fallback, dshHome)) {
      return { workspace: fallback, workspaceReason: '' }
    }
    return { workspace: null, workspaceReason: 'overlap' }
  }
  if (isForbiddenLocation(found.path)) return { workspace: null, workspaceReason: 'forbidden' }
  if (dshHome != null && inside(found.path, dshHome)) return { workspace: null, workspaceReason: 'overlap' }
  return { workspace: found.path, workspaceReason: '' }
}

function safeWorkspace(root: string, dshHome: string | null): boolean {
  if (isForbiddenLocation(root)) return false
  if (dshHome != null && (root === dshHome || inside(root, dshHome))) return false
  return true
}

function realDirectory(filePath: string): { path: string | null; reason: '' | 'missing' | 'invalid' } {
  if (filePath.trim() === '' || filePath.includes('\0')) return { path: null, reason: 'missing' }
  let real: string
  try {
    real = realpathSync(resolve(filePath))
  } catch {
    return { path: null, reason: 'missing' }
  }
  try {
    if (!lstatSync(real).isDirectory()) return { path: null, reason: 'invalid' }
  } catch {
    return { path: null, reason: 'missing' }
  }
  return { path: real, reason: '' }
}

function isForbiddenLocation(filePath: string): boolean {
  if (filePath === sep) return true
  const etc = `${sep}etc`
  return filePath === etc || filePath.startsWith(`${etc}${sep}`)
}

function inside(root: string, target: string): boolean {
  if (root === sep) return target.startsWith(sep)
  return target === root || target.startsWith(`${root}${sep}`)
}

function rootOf(filePath: string, access: FileAccess): 'workspace' | 'home' | null {
  const inWorkspace = access.roots.workspace != null && inside(access.roots.workspace, filePath)
  const inHome = access.roots.home != null && inside(access.roots.home, filePath)
  if (!inWorkspace && !inHome) return null
  if (access.dshHome && inside(access.dshHome, filePath) && !inWorkspace) return null
  return inWorkspace ? 'workspace' : 'home'
}

function locate(filePath: string, access: FileAccess): FileResult<{ path: string; root: 'workspace' | 'home' }> {
  if (filePath.length === 0 || filePath.length > 4096 || /[\u0000]/.test(filePath) || !filePath.startsWith('/')) {
    return { ok: false, error: 'bad_path' }
  }
  let resolved: string
  try {
    resolved = realpathSync(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, error: code === 'ENOENT' ? 'missing' : 'denied' }
  }
  const root = rootOf(resolved, access)
  if (!root) return { ok: false, error: 'denied' }
  return { ok: true, value: { path: resolved, root } }
}

function openFile(filePath: string, access: FileAccess): FileResult<{ fd: number; path: string; size: number }> {
  const located = locate(filePath, access)
  if (!located.ok) return located
  try {
    if (!lstatSync(located.value.path).isFile()) return { ok: false, error: 'not_file' }
  } catch {
    return { ok: false, error: 'missing' }
  }
  let fd: number
  try {
    fd = openSync(located.value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return { ok: false, error: 'denied' }
  }
  try {
    const opened = process.platform === 'linux' ? realpathSync(`/proc/self/fd/${fd}`) : located.value.path
    const stat = fstatSync(fd)
    if (!stat.isFile() || !rootOf(opened, access)) {
      closeSync(fd)
      return { ok: false, error: stat.isFile() ? 'denied' : 'not_file' }
    }
    return { ok: true, value: { fd, path: opened, size: stat.size } }
  } catch {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
    return { ok: false, error: 'denied' }
  }
}

function readFd(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset)
    if (read === 0) break
    offset += read
  }
  return bytes.subarray(0, offset)
}

function writeBounded(source: Readable, tmp: string, maxBytes: number): Promise<FileResult<number>> {
  return new Promise(resolveWrite => {
    const out = createWriteStream(tmp, { flags: 'wx', mode: 0o644 })
    let size = 0
    let settled = false
    const fail = (error: FileError) => {
      if (settled) return
      settled = true
      source.pause()
      source.removeListener('data', onData)
      const done = () => {
        try {
          unlinkSync(tmp)
        } catch {
          /* hidden temp, or the file was never created */
        }
        resolveWrite({ ok: false, error })
      }
      if (out.closed) done()
      else {
        out.once('close', done)
        out.destroy()
      }
    }
    const onData = (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail('too_large')
        return
      }
      if (!out.write(chunk)) source.pause()
    }
    out.on('drain', () => {
      if (!settled) source.resume()
    })
    out.on('error', () => fail('denied'))
    source.on('data', onData)
    source.on('end', () => {
      if (settled) return
      out.end(() => {
        if (settled) return
        settled = true
        resolveWrite({ ok: true, value: size })
      })
    })
    source.on('error', () => fail('denied'))
    source.resume()
  })
}
