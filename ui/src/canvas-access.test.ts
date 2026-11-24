import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  CanvasAccessError,
  CanvasMediaError,
  canvasMediaPath,
  isTrustedCanvasUrl,
  readSameOriginBytes,
} from './canvas-access.ts'

const token = 'a'.repeat(24)
const cssUrl = canvasMediaPath(token, 1, 'styles.css')!

function response(init: { status?: number; type?: string; typeHeader?: string; body?: string; ok?: boolean }) {
  const status = init.status ?? 200
  const bytes = new TextEncoder().encode(init.body ?? '')
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    type: init.type ?? 'basic',
    headers: { get: (name: string) => (name === 'content-type' ? (init.typeHeader ?? 'text/css') : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

test('canvas reads stay on trusted same-origin paths and do not follow an access redirect', async () => {
  assert.equal(isTrustedCanvasUrl(cssUrl), true)
  assert.equal(isTrustedCanvasUrl('/dsh-bot/canvas-inspector.js'), true)
  assert.equal(isTrustedCanvasUrl('/dsh-bot/api/canvas'), false)
  assert.equal(isTrustedCanvasUrl('https://evil.example/dsh-bot/canvas-media/x'), false)
  assert.equal(isTrustedCanvasUrl(`//evil.example${cssUrl}`), false)
  assert.equal(canvasMediaPath(token, 1, '../secret.html'), null)
  assert.equal(canvasMediaPath(token, 1, 'https://evil.example/a.png'), null)

  let calls = 0
  await assert.rejects(
    () =>
      readSameOriginBytes('https://evil.example/steal', () => {
        calls += 1
        return Promise.resolve(response({}))
      }),
    CanvasMediaError,
  )
  assert.equal(calls, 0)

  const redirected = await readSameOriginBytes(cssUrl, async (_url, init) => {
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.redirect, 'manual')
    return response({ status: 0, type: 'opaqueredirect', ok: false, body: 'cdn-cgi/access/login' })
  }).then(
    () => null,
    error => error,
  )
  assert.ok(redirected instanceof CanvasAccessError)

  const loginHtml = await readSameOriginBytes(canvasMediaPath(token, 1, 'index.html')!, async () =>
    response({
      typeHeader: 'text/html; charset=utf-8',
      body: '<html>cdn-cgi/access/login</html>',
    }),
  ).then(
    () => null,
    error => error,
  )
  assert.ok(loginHtml instanceof CanvasAccessError)

  const denied = await readSameOriginBytes(cssUrl, async () => response({ status: 401, ok: false, body: '{}' })).then(
    () => null,
    error => error,
  )
  assert.ok(denied instanceof CanvasMediaError)
  assert.equal(denied instanceof CanvasAccessError, false)

  const bytes = await readSameOriginBytes(cssUrl, async () => response({ body: 'body{color:#111}' }))
  assert.equal(new TextDecoder().decode(bytes), 'body{color:#111}')
})
