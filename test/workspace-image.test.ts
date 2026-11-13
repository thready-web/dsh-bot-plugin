import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHttp } from '../src/http.ts'
import { createEngine } from '../src/engine.ts'
import { openStore } from '../src/store.ts'

// Real HTTP, no models, workers, host process or authentication bypass.
test('workspace image URL returns raster bytes behind the existing auth gate, including HEAD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-workspace-image-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'coffee-page/preview'), { recursive: true })
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
  writeFileSync(join(workspace, 'coffee-page/preview/desktop.jpg'), jpg)
  writeFileSync(join(workspace, 'coffee-page/preview/mobile.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  writeFileSync(join(workspace, 'coffee-page/preview/fake.jpg'), '<html>not an image</html>')
  writeFileSync(join(workspace, 'private.txt'), 'private')
  writeFileSync(join(workspace, 'coffee-page/preview/.secret.jpg'), jpg)
  writeFileSync(join(dir, 'outside.jpg'), jpg)
  writeFileSync(join(workspace, 'unpublished.jpg'), jpg)
  symlinkSync(join(workspace, 'unpublished.jpg'), join(workspace, 'coffee-page/preview/unpublished.jpg'))
  symlinkSync(join(dir, 'outside.jpg'), join(workspace, 'coffee-page/preview/escape.jpg'))
  symlinkSync(dir, join(workspace, 'coffee-page/preview/escape'))
  const store = openStore(join(dir, 'store'))
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    get: () => ({ requestRejection: (req: IncomingMessage) => (req.headers.authorization === 'test-owner' ? 0 : 401) }),
    webServer: {
      register: (route: (typeof routes)[number]) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  registerHttp(ctx as any, createEngine(store))
  const handler = routes.find(route => route.path === '/dsh-bot')!.handler
  const server = createServer((req, res) => void handler(req, res))
  const previous = process.env.THREADY_SESSION_CWD
  process.env.THREADY_SESSION_CWD = workspace
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { authorization: 'test-owner' }
  try {
    const path = '/dsh-bot/coffee-page/preview/desktop.jpg'
    const denied = await fetch(origin + path)
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).code, 'FORBIDDEN')
    const image = await fetch(origin + path, { headers })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/jpeg')
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(image.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpg)
    const head = await fetch(origin + path, { headers, method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(jpg.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const png = await fetch(origin + '/dsh-bot/coffee-page/preview/mobile.png', { headers })
    assert.equal(png.headers.get('content-type'), 'image/png')
    await png.arrayBuffer()
    for (const unsafe of [
      'missing.jpg',
      'unpublished.jpg',
      'coffee-page/preview/unpublished.jpg',
      'coffee-page/preview/fake.jpg',
      'private.txt',
      'coffee-page/preview/.secret.jpg',
      'coffee-page/preview/escape.jpg',
      'coffee-page/preview/escape/outside.jpg',
      '%2e%2e%2foutside.jpg',
      '%252e%252e%252foutside.jpg',
      '%2foutside.jpg',
      'coffee-page%5c..%5c..%5coutside.jpg',
      '%00.jpg',
      '%ZZ.jpg',
      'coffee-page/preview/desktop.svg',
    ]) {
      const response = await fetch(origin + '/dsh-bot/' + unsafe, { headers })
      assert.equal(response.status, 404, unsafe)
      await response.arrayBuffer()
    }
    const post = await fetch(origin + path, { headers, method: 'POST' })
    assert.equal(post.status, 404)
  } finally {
    if (previous == null) delete process.env.THREADY_SESSION_CWD
    else process.env.THREADY_SESSION_CWD = previous
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
