import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])

function matchesImage(header: Buffer, type: string) {
  if (type === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  if (type === 'image/png') return header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (type === 'image/gif') return /^GIF8[79]a$/.test(header.toString('ascii', 0, 6))
  return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
}

function artifactPath(path: string) {
  const parts = path.split('/')
  return (
    parts.length >= 3 &&
    (parts[1] === 'preview' || parts[1] === 'artifacts') &&
    parts.every(part => part !== '' && !part.startsWith('.'))
  )
}

/**
 * Called only AFTER the workbench authentication gate and bundled UI lookup.
 * Generated raster images live in the configured session workspace, not public/.
 * Only <project>/preview/ and <project>/artifacts/ are deliberate artifact scopes.
 * Never fall back to process cwd, never serve arbitrary files or active HTML/SVG.
 */
export function serveWorkspaceImage(req: IncomingMessage, res: ServerResponse, pathname: string, workspace: string) {
  if (!workspace || (req.method !== 'GET' && req.method !== 'HEAD') || !pathname.startsWith('/dsh-bot/')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.slice('/dsh-bot/'.length))
  } catch {
    return false
  }
  if (!artifactPath(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return false
  const type = TYPES.get(extname(decoded).toLowerCase())
  if (!type) return false
  let fd: number | undefined
  try {
    const root = realpathSync(workspace)
    const file = realpathSync(resolve(root, decoded))
    if (!file.startsWith(root + sep) || !artifactPath(relative(root, file).split(sep).join('/'))) return false
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    // On Linux, verify the opened descriptor as well, closing symlink-swap races.
    if (process.platform === 'linux') {
      const opened = realpathSync(`/proc/self/fd/${fd}`)
      if (!opened.startsWith(root + sep) || !artifactPath(relative(root, opened).split(sep).join('/'))) return false
    }
    const stat = fstatSync(fd)
    if (!stat.isFile()) return false
    const header = Buffer.alloc(12)
    readSync(fd, header, 0, header.length, 0)
    if (!matchesImage(header, type)) return false
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') res.end()
    else {
      const stream = createReadStream(file, { fd, autoClose: true, start: 0 })
      fd = undefined
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    }
    return true
  } catch {
    return false
  } finally {
    if (fd != null) closeSync(fd)
  }
}
