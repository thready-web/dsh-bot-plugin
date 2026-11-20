/**
 * Dev-only Vite server on a Unix socket. The browser stays on DSH;
 * DSH forwards workbench HTTP and the hot-reload upgrade to this file.
 */
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const socketPath = process.env.DSH_BOT_UI_DEV
  ?? resolve(fileURLToPath(new URL('../../../.run/workbench-vite.sock', import.meta.url)))
if (!isAbsolute(socketPath)) {
  console.error('DSH_BOT_UI_DEV must be an absolute Unix socket path')
  process.exit(1)
}
const dshPort = Number(process.env.DSH_PORT)
const clientPort = Number.isInteger(dshPort) && dshPort > 0 ? dshPort : 8787

mkdirSync(dirname(socketPath), { recursive: true })
try {
  unlinkSync(socketPath)
} catch {
  /* no stale socket */
}

const httpServer = createServer()
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    // Vite's default 5173 is only a label here. Middleware mode does not bind it.
    port: clientPort,
    hmr: {
      server: httpServer,
      host: '127.0.0.1',
      clientPort,
    },
  },
})
httpServer.on('request', vite.middlewares)

await new Promise((resolvePromise, reject) => {
  httpServer.once('error', reject)
  httpServer.listen(socketPath, () => {
    httpServer.off('error', reject)
    chmodSync(socketPath, 0o600)
    resolvePromise()
  })
})
console.log(`Workbench Vite socket ${socketPath}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  httpServer.close()
  try {
    unlinkSync(socketPath)
  } catch {
    /* already gone */
  }
  try {
    await vite.close()
  } catch {
    /* watcher already closed */
  }
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
