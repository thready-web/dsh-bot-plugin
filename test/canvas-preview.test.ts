import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { DOMParser, parseHTML } from 'linkedom'

const compiled = await build({
  stdin: {
    contents: `
      import React, { act } from 'react'
      import { createRoot } from 'react-dom/client'
      import { CanvasPreview } from './ui/src/CanvasPreview.tsx'
      export { act }
      export function mount(node) {
        const root = createRoot(node)
        return {
          render: props => act(() => root.render(<CanvasPreview {...props} />)),
          close: () => act(() => root.unmount()),
        }
      }
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'tsx',
  },
  plugins: [
    {
      name: 'node-react',
      setup(builder) {
        const uiRequire = createRequire(new URL('../ui/package.json', import.meta.url))
        builder.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/ }, args => ({
          path: uiRequire.resolve(args.path),
          external: true,
        }))
      },
    },
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
})

function harness() {
  const { window, document } = parseHTML('<html><body><main></main></body></html>')
  window.matchMedia = (query: string) => ({
    matches: /max-width|pointer/.test(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    DOMParser,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const mod = { exports: {} as any }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  )
  const mounted = mod.exports.mount(document.querySelector('main')) as {
    render(props: unknown): Promise<void>
    close(): Promise<void>
  }
  return {
    ...mounted,
    act: mod.exports.act as (fn: () => unknown) => Promise<void>,
    document,
    window,
    async close() {
      await mounted.close()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

const previewFiles = new Map([
  [
    'index.html',
    {
      type: 'text/html',
      bytes: new TextEncoder().encode('<!doctype html><html><body><p>Poster body</p></body></html>'),
    },
  ],
])
const inspectorSource = '/* canvas-inspect */'

const revisions = [
  { revision: 1, kind: 'snapshot', status: 'stable' as const, entry: 'index.html', error: null },
  { revision: 2, kind: 'delta', status: 'preview' as const, entry: 'index.html', error: null },
  { revision: 3, kind: 'failed', status: 'failed' as const, entry: null, error: 'worker stopped' },
]

test('the canvas modal keeps one inspect document and does not reload when selecting', async () => {
  const view = harness()
  const src = '/dsh-bot/canvas-media/token-token-token-token/2/index.html'
  let selected: number | null = null
  let closed = 0
  try {
    await view.render({
      title: 'Poster',
      revisions,
      activeRevision: 2,
      phase: 'ready',
      error: '',
      src,
      files: previewFiles,
      inspectorSource,
      onSelect: (revision: number) => {
        selected = revision
      },
      onRetry: () => {},
      onAdopt: () => {},
      onClose: () => {
        closed += 1
      },
    })
    const frame = view.document.querySelector('iframe')
    assert.ok(frame)
    const address = frame.getAttribute('srcDoc') || frame.getAttribute('srcdoc') || ''
    assert.equal(frame.hasAttribute('src'), false)
    assert.match(address, /Poster body/)
    assert.equal(address.includes('token-token-token-token'), false)
    assert.equal(address.includes('/dsh-bot/canvas-media/'), false)
    assert.match(address, /https:\/\/canvas\.invalid\/preview\//)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts')
    assert.equal((frame.getAttribute('sandbox') ?? '').includes('allow-same-origin'), false)
    const windowLink = view.document.querySelector('a.canvas-new-window')
    assert.ok(windowLink)
    assert.equal(windowLink.getAttribute('href'), '/dsh-bot/canvas-view/token-token-token-token/2/index.html')
    assert.equal(windowLink.getAttribute('target'), '_blank')
    assert.equal(windowLink.getAttribute('rel'), 'noopener noreferrer')
    assert.equal(windowLink.getAttribute('aria-label'), 'Open in new window')
    assert.equal(windowLink.getAttribute('title'), 'Open this revision in its own tab')
    assert.equal(windowLink.parentElement?.classList.contains('canvas-toolbar-title'), true)
    const fitBox = view.document.querySelector('.canvas-fit') as unknown as HTMLElement | null
    assert.ok(fitBox)
    assert.equal(fitBox.getAttribute('data-mode'), 'fit')
    assert.equal(fitBox.style.width, '1280px')
    const frameBox = view.document.querySelector('.canvas-frame') as unknown as HTMLElement | null
    assert.equal(frameBox?.style.width, '1280px')
    assert.equal(frameBox?.style.height, '860px')
    assert.equal(frameBox?.style.transform, 'scale(1)')
    const scaleButton = [...view.document.querySelectorAll('button')].find(
      button => button.textContent === 'Actual size',
    )
    assert.ok(scaleButton)
    assert.equal(scaleButton.getAttribute('aria-pressed'), 'true')
    const stage = view.document.querySelector('.canvas-stage') as unknown as HTMLElement
    Object.defineProperty(stage, 'clientWidth', { value: 366, configurable: true })
    Object.defineProperty(stage, 'clientHeight', { value: 600, configurable: true })
    await view.act(() => {
      view.window.dispatchEvent(new view.window.Event('resize'))
    })
    assert.equal(fitBox.style.width, '350px')
    assert.equal(fitBox.style.height, `${860 * (350 / 1280)}px`)
    assert.equal(frameBox?.style.transform, `scale(${350 / 1280})`)
    await view.act(() => scaleButton?.click())
    assert.equal(view.document.querySelector('.canvas-fit')?.getAttribute('data-mode'), 'actual')
    assert.equal(frameBox?.style.height, '600px')
    assert.equal(frameBox?.style.transform, 'scale(1)')
    assert.equal(
      [...view.document.querySelectorAll('button')].some(button => button.textContent === 'Fit to screen'),
      true,
    )
    const select = [...view.document.querySelectorAll('button')].find(
      button => button.getAttribute('aria-label') === 'Select',
    )
    await view.act(() => select?.click())
    assert.equal(frame.getAttribute('srcDoc') || frame.getAttribute('srcdoc') || '', address)
    await view.act(() => select?.click())
    assert.equal(frame.getAttribute('srcDoc') || frame.getAttribute('srcdoc') || '', address)
    assert.equal(view.document.querySelector('.canvas-dialog')?.getAttribute('role'), 'dialog')
    const labels = [...view.document.querySelectorAll('button')].map(button => button.textContent)
    assert.equal(labels.includes('Back'), false)
    assert.equal(labels.includes('Refresh'), false)
    const reset = [...view.document.querySelectorAll('button')].find(button => button.textContent === 'Reset')
    assert.equal(reset?.hasAttribute('disabled'), false)
    assert.equal(reset?.getAttribute('title'), "Back to this version's first page")
    const failed = [...view.document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Version 3'),
    )
    assert.equal(failed?.hasAttribute('disabled'), true)
    const previous = [...view.document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Version 1'),
    )
    await view.act(() => previous?.click())
    assert.equal(selected, 1)
    const escape = new view.window.Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperty(escape, 'key', { value: 'Escape' })
    view.document.dispatchEvent(escape)
    assert.equal(closed, 1)
    await view.render({
      title: 'Poster',
      revisions,
      activeRevision: 2,
      phase: 'error',
      error: 'This revision could not be shown. The previous one is still open.',
      src,
      files: previewFiles,
      inspectorSource,
      onSelect: () => {},
      onRetry: () => {},
      onAdopt: () => {},
      onClose: () => {},
    })
    const again = view.document.querySelector('iframe')
    assert.equal(again?.getAttribute('srcDoc') || again?.getAttribute('srcdoc') || '', address)
    assert.equal(view.document.querySelector('iframe')?.hasAttribute('src'), false)
    assert.match(view.document.body.textContent ?? '', /previous one is still open/)
  } finally {
    await view.close()
  }
})
