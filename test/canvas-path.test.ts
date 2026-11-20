import { strict as assert } from 'node:assert'
import { parseHTML } from 'linkedom'
import test from 'node:test'
import { mentionFrom } from '../ui/src/canvas-mention.ts'
import {
  adoptElement,
  pathTo,
  resolvePath,
  visibleChildren,
  type DomLike,
  type RawNode,
} from '../ui/src/canvas-path.ts'

const html = `<!doctype html><html><head><title>Quiet reading</title></head><body>
  <header class="top"><p>eyebrow</p><h1 class="title">Quiet reading</h1></header>
  <main>
    <article><p>one</p><p>two</p><p><button>Keep this</button></p></article>
    <section><h2>Hours</h2><table><tbody><tr><th>Day</th><th>Count</th></tr><tr><td>Mon</td><td class="cell">8</td></tr></tbody></table></section>
  </main>
</body></html>`

function bodyOf(source: string): RawNode {
  const { document } = parseHTML(source)
  return adoptElement(document.body as unknown as DomLike)
}

test('element paths round-trip, including a row the parser wraps in tbody', () => {
  const body = bodyOf(html)
  const title = resolvePath(body, '0:header/1:h1')
  assert.equal(title?.node.tag, 'h1')
  assert.equal(title?.node.text, 'Quiet reading')
  assert.deepEqual(title?.node.classes, ['title'])
  const button = resolvePath(body, '1:main/0:article/2:p/0:button')
  assert.equal(button?.node.tag, 'button')
  assert.equal(button?.node.text, 'Keep this')
  const cell = resolvePath(body, '1:main/1:section/1:table/1:tr/1:td')
  assert.equal(cell?.node.text, '8')
  assert.equal(cell?.node.classes[0], 'cell')

  const visit = (node: RawNode) => {
    const path = pathTo(body, node)
    assert.notEqual(path, null)
    assert.equal(resolvePath(body, path ?? '')?.node, node)
    for (const child of visibleChildren(node)) visit(child)
  }
  visit(body)

  const table = resolvePath(body, '1:main/1:section/1:table')?.node
  const tbody = table?.rawChildren.find(child => child.tag === 'tbody')
  assert.ok(tbody)
  assert.equal(pathTo(body, tbody), null)
})

test('a forged path does not become a mention', () => {
  const body = bodyOf(html)
  assert.equal(resolvePath(body, '0:header/1:button'), null)
  assert.equal(resolvePath(body, '00:header'), null)
  assert.equal(resolvePath(body, '../index.html'), null)
  assert.equal(mentionFrom(body, '0:nope'), null)
  const hit = mentionFrom(body, '0:header/1:h1')
  assert.equal(hit?.label, 'h1 · Quiet reading')
  assert.equal(hit?.breadcrumb[0]?.tag, 'body')
  assert.equal(hit?.breadcrumb.at(-1)?.path, '0:header/1:h1')
})
