import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { parseCanvasLink, preserveCanvasUrl, splitCanvasRoute } from './canvas-link.ts'

test('a canvas link can name the canvas, its revision, a page, and an anchor', () => {
  const link = parseCanvasLink('canvas:cnv_abcdefghijklmnop@2/tea.html#menu')
  assert.deepEqual(link, {
    canvasId: 'cnv_abcdefghijklmnop',
    revision: 2,
    page: 'tea.html',
    anchor: 'menu',
  })
  assert.deepEqual(parseCanvasLink('canvas:cnv_abcdefghijklmnop'), {
    canvasId: 'cnv_abcdefghijklmnop',
    revision: null,
    page: null,
    anchor: null,
  })
  assert.equal(parseCanvasLink('canvas:cnv_abcdefghijklmnop@2#intro')?.anchor, 'intro')
  assert.equal(parseCanvasLink('canvas:cnv_abcdefghijklmnop/pages/tea.html')?.page, 'pages/tea.html')
})

test('markdown keeps a canvas target and still drops other protocols', () => {
  const href = 'canvas:cnv_abcdefghijklmnop@1/coffee.html#beans'
  assert.equal(defaultUrlTransform(href), '')
  assert.equal(preserveCanvasUrl(href, defaultUrlTransform), href)
  assert.equal(preserveCanvasUrl('javascript:alert(1)', defaultUrlTransform), '')
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      urlTransform: (value: string) => preserveCanvasUrl(value, defaultUrlTransform),
      children: '[豆子](canvas:cnv_abcdefghijklmnop@1/coffee.html#beans)',
    }),
  )
  assert.match(html, /href="canvas:cnv_abcdefghijklmnop@1\/coffee\.html#beans"/)
})

test('a canvas link rejects another canvas, a traversal, or a loose anchor', () => {
  assert.equal(parseCanvasLink('https://example.com/cnv_abcdefghijklmnop'), null)
  assert.equal(parseCanvasLink('canvas:cnv_short'), null)
  assert.equal(parseCanvasLink('canvas:cnv_abcdefghijklmnop/../tea.html'), null)
  assert.equal(parseCanvasLink('canvas:cnv_abcdefghijklmnop/tea.html#1menu'), null)
  assert.equal(splitCanvasRoute('tea.html#section-2')?.anchor, 'section-2')
  assert.equal(splitCanvasRoute('../tea.html'), null)
})
