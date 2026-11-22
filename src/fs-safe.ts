import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

/**
 * @param {Buffer | string} bytes
 */
export function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {string} root
 */
export function ensureDir(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return realpathSync(root)
}

/**
 * Reject `..`, absolute segments, and symlink escapes. The returned descriptor
 * is the file that was opened; callers hash those bytes.
 * A same-user process can still win a race. This is not an OS sandbox.
 * @param {string} root
 * @param {string} file
 */
export function openContained(root: string, file: string) {
  const rootReal = realpathSync(root)
  // Compare the paths the caller passed. realpath(root) can be /private/var while
  // the file is still under /var, and that false escape would hide a real skill file.
  const rel = relative(root, file)
  if (rel.startsWith('..') || rel === '' || isAbsolute(rel) || file.includes('\0')) {
    throw Object.assign(new Error('path escapes the skill root'), { code: 'FORBIDDEN' })
  }
  const segments = rel.split(sep).filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw Object.assign(new Error('path segment rejected'), { code: 'FORBIDDEN' })
  }
  let cursor = rootReal
  for (const segment of segments) {
    cursor = join(cursor, segment)
    let stat
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      throw Object.assign(new Error(`path missing: ${segment}`), { code: 'NOT_FOUND', cause: error })
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error('symlink rejected'), { code: 'FORBIDDEN' })
    }
  }
  const parentReal = realpathSync(dirname(cursor))
  const parentRel = relative(rootReal, parentReal)
  if (parentRel.startsWith('..') || parentRel.split(sep).includes('..')) {
    throw Object.assign(new Error('resolved parent escapes the skill root'), { code: 'FORBIDDEN' })
  }
  const fd = openSync(join(parentReal, basename(cursor)), OPEN_FLAGS)
  return { fd, path: join(parentReal, basename(cursor)) }
}

/**
 * @param {string} root
 * @param {string} file
 */
export function readContained(root: string, file: string) {
  const opened = openContained(root, file)
  try {
    const chunks = []
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (true) {
      const read = readSync(opened.fd, buffer, 0, buffer.length, offset)
      if (read === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, read)))
      offset += read
    }
    return Buffer.concat(chunks)
  } finally {
    closeSync(opened.fd)
  }
}

/**
 * Write bytes to a temp file, fsync, then rename into place.
 * @param {string} file
 * @param {Buffer | string} bytes
 */
export function writeAtomic(file: string, bytes: Buffer | string) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  return data
}
