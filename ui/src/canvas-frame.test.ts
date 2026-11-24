import { strict as assert } from 'node:assert'
import test from 'node:test'
import { DOMParser } from 'linkedom'
import { buildCanvasSrcdoc } from './canvas-frame.ts'

Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true })

const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

test('the preview document inlines css, images, and fonts and does not point at the app', () => {
  const files = new Map([
    [
      'index.html',
      {
        type: 'text/html',
        bytes: new TextEncoder().encode(
          '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body><h1>Poster</h1><img src="images/hero.png" alt=""><img src="https://evil.example/a.png" alt=""></body></html>',
        ),
      },
    ],
    [
      'css/app.css',
      {
        type: 'text/css',
        bytes: new TextEncoder().encode(
          '@import "https://evil.example/x.css"; h1{color:#abcdef;background:url("nested/mark.png")} @font-face{font-family:Mark;src:url("../fonts/mark.woff2")}',
        ),
      },
    ],
    ['images/hero.png', { type: 'image/png', bytes: png }],
    ['css/nested/mark.png', { type: 'image/png', bytes: png }],
    ['fonts/mark.woff2', { type: 'font/woff2', bytes: Uint8Array.from([0, 1, 2, 3]) }],
  ])
  const html = buildCanvasSrcdoc({
    files,
    page: 'index.html',
    nonce: 'abc123abc123abc123',
    parentOrigin: 'https://bot.example',
    inspectorSource: '/* canvas-inspect */',
    scriptNonce: 'nonce123nonce123nonce',
  })
  assert.ok(html)
  assert.match(html, /Poster/)
  assert.match(html, /data:image\/png;base64,/)
  assert.match(html, /data:font\/woff2;base64,/)
  assert.match(html, /color:#abcdef/)
  assert.equal(html.includes('@import'), false)
  assert.equal(html.includes('evil.example'), false)
  assert.equal(html.includes('/dsh-bot/'), false)
  assert.equal(html.includes('allow-same-origin'), false)
  assert.match(html, /script-src 'nonce-nonce123nonce123nonce'/)
  assert.match(html, /<base href="https:\/\/canvas\.invalid\/preview\/">/)
  assert.match(html, /<script nonce="nonce123nonce123nonce">/)
  assert.equal((html.match(/<script/g) ?? []).length, 1)
})
