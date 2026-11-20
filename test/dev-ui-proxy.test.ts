import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as connectSocket, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { devUiSocket, proxyDevUi, proxyDevUpgrade } from '../src/http.ts'

function listenSocket(server: NetServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function listenPort(server: NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function close(server: NetServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

test('dev UI socket is an absolute path', () => {
  const previous = process.env.DSH_BOT_UI_DEV
  try {
    delete process.env.DSH_BOT_UI_DEV
    assert.equal(devUiSocket(), null)
    process.env.DSH_BOT_UI_DEV = 'http://127.0.0.1:5173'
    assert.equal(devUiSocket(), null)
    process.env.DSH_BOT_UI_DEV = 'workbench-vite.sock'
    assert.equal(devUiSocket(), null)
    process.env.DSH_BOT_UI_DEV = '/tmp/workbench-vite.sock'
    assert.equal(devUiSocket(), '/tmp/workbench-vite.sock')
  } finally {
    if (previous === undefined) delete process.env.DSH_BOT_UI_DEV
    else process.env.DSH_BOT_UI_DEV = previous
  }
})

test('workbench HTTP and the hot-reload upgrade use the Vite socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ui-'))
  const socketPath = join(dir, 'vite.sock')
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-dev-ui': '1' })
    res.end(`vite ${req.url}`)
  })
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhmr-ok')
    socket.end()
  })
  await listenSocket(upstream, socketPath)
  const gate = createServer(async (req, res) => {
    if (await proxyDevUi(req, res)) return
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-dev-ui': 'disk' })
    res.end('public')
  })
  gate.on('upgrade', (req, socket, head) => proxyDevUpgrade(req, socket, head))
  const port = await listenPort(gate)
  const previous = process.env.DSH_BOT_UI_DEV
  try {
    process.env.DSH_BOT_UI_DEV = socketPath
    const forwarded = await fetch(`http://127.0.0.1:${port}/dsh-bot/src/App.tsx?t=1`)
    assert.equal(forwarded.status, 200)
    assert.equal(forwarded.headers.get('x-dev-ui'), '1')
    assert.equal(await forwarded.text(), 'vite /dsh-bot/src/App.tsx?t=1')

    const upgraded = await new Promise<string>((resolve, reject) => {
      const client = connectSocket(port, '127.0.0.1', () => {
        client.write(
          'GET /dsh-bot/?token=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      })
      const chunks: Buffer[] = []
      client.on('data', chunk => chunks.push(Buffer.from(chunk)))
      client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      client.on('error', reject)
    })
    assert.match(upgraded, /^HTTP\/1\.1 101/)
    assert.match(upgraded, /hmr-ok/)

    process.env.DSH_BOT_UI_DEV = join(dir, 'missing.sock')
    const fallback = await fetch(`http://127.0.0.1:${port}/dsh-bot/`)
    assert.equal(fallback.status, 200)
    assert.equal(fallback.headers.get('x-dev-ui'), 'disk')
    assert.equal(await fallback.text(), 'public')
  } finally {
    if (previous === undefined) delete process.env.DSH_BOT_UI_DEV
    else process.env.DSH_BOT_UI_DEV = previous
    await Promise.all([close(upstream), close(gate)])
    rmSync(dir, { recursive: true, force: true })
  }
})
