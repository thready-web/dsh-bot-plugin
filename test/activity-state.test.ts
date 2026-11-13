import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'
import { createAuthorizationCatalog } from '../ui/src/interaction-sync.ts'

// A real mounted React tree, not SSR: keep the same buttons across streaming,
// durable replacement, new activity and completion, in both transcript modes.
const compiled = await build({
  stdin: {
    contents: `
      import React, { act } from 'react'
      import { createRoot } from 'react-dom/client'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { Transcript } from './ui/src/transcript.tsx'
      import { ActivityGroup } from './ui/src/ProcessRow.tsx'
      import { MarkdownView } from './ui/src/MarkdownView.tsx'
      import { AuthorizationPanel } from './ui/src/SettingsPanels.tsx'
      import { ImageFailureScope } from './ui/src/ImageFailureScope.tsx'
      export { act }
      export function mount(node) {
        const root = createRoot(node)
        return {
          render: props => act(() => root.render(<Transcript {...props} />)),
          group: props => act(() => root.render(<ActivityGroup {...props} />)),
          authPanel: props => act(async () => { root.render(<AuthorizationPanel {...props} />); await Promise.resolve() }),
          image: props => act(() => root.render(<MarkdownView {...props} />)),
          scopedImage: props => act(() => root.render(
            <ImageFailureScope key={props.sessionId || 'session-one'}>
              <MarkdownView key={props.revision || 'initial'} {...props} />
            </ImageFailureScope>
          )),
          close: () => act(() => root.unmount())
        }
      }
      export const markdown = text => renderToStaticMarkup(<MarkdownView text={text} />)
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'tsx',
  },
  // Keep React's Node act scheduler intact instead of bundling its dynamic
  // require into a browser MessageChannel fallback that leaves ports alive.
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
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }
  Object.assign(window, { matchMedia: () => ({ matches: true }) })
  // linkedom has no focus implementation; model browser focus and focusin so
  // the mounted dialog's own trap/restore handlers are exercised, not stubbed.
  let focused: Element | null = null
  const previousFocus = window.HTMLElement.prototype.focus
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused })
  window.HTMLElement.prototype.focus = function () {
    focused = this as unknown as Element
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }))
  }
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const mod = { exports: {} as any }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  )
  const container = document.querySelector('main')!
  const mounted = mod.exports.mount(container) as {
    render(props: unknown): Promise<void>
    group(props: unknown): Promise<void>
    image(props: unknown): Promise<void>
    authPanel(props: unknown): Promise<void>
    scopedImage(props: unknown): Promise<void>
    close(): Promise<void>
  }
  return {
    ...mounted,
    markdown: mod.exports.markdown,
    container,
    act: mod.exports.act,
    async close() {
      await mounted.close()
      window.HTMLElement.prototype.focus = previousFocus
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

const tool = (id: string, status = 'running') => ({
  kind: 'tool',
  id: `tool:${id}`,
  callId: id,
  name: 'bash',
  args: '{}',
  result: '',
  running: status === 'running',
  status,
  error: false,
  seq: 2,
  turn: 1,
})
const base = {
  sessionId: 'session-state',
  completed: {},
  failures: {},
  retries: {},
  turnEnds: {},
  tickets: [],
  now: 0,
  canRetry: false,
  onRetry() {},
  onSupply() {},
  onOpenSession() {},
  onOpenFile() {},
  onOpenInbox() {},
  botLabel: (id: string) => id,
  drafting: true,
  currentTurn: 1,
}

for (const chat of [true, false]) {
  test(`mounted actions preserve user state through streaming and completion (Bot=${chat})`, async () => {
    const h = harness()
    const groups = () => [...h.container.querySelectorAll('.activity-group')]
    const button = () => groups()[0]!.querySelector('button')!
    const expanded = () => button().getAttribute('aria-expanded')
    const click = () => h.act(() => button().click())
    const think = { kind: 'think', id: 'live:think:0', text: 'working', running: true, seq: 1, turn: 1, step: 1 }
    try {
      await h.render({ ...base, chat, segments: [think, tool('one')] })
      assert.equal(expanded(), 'true')
      const original = groups()[0]
      await click()
      assert.equal(expanded(), 'false')
      await h.render({ ...base, chat, segments: [{ ...think, text: 'working more' }, tool('one'), tool('two')] })
      assert.equal(expanded(), 'false', 'streaming and new actions must not reopen')
      await h.render({
        ...base,
        chat,
        drafting: false,
        turnEnds: { 1: 'completed' },
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
        ],
      })
      assert.equal(groups()[0], original, 'durable ids must not remount the action group or turn')
      assert.equal(expanded(), 'false')
      await click()
      assert.equal(expanded(), 'true')
      await h.render({
        ...base,
        chat,
        drafting: false,
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
          { kind: 'assistant', id: 'answer', text: 'between actions', seq: 4, turn: 1 },
          { ...tool('three'), seq: 5 },
        ],
      })
      assert.equal(expanded(), 'true', 'new separate activity must not close the selected group')
      assert.equal(groups().length, 2, 'text must remain between the two activity runs')
      assert.ok(h.container.textContent!.includes('between actions'))
      await h.render({
        ...base,
        chat,
        drafting: false,
        segments: [
          { ...think, id: 'think:durable:0', running: false },
          tool('one', 'succeeded'),
          tool('two', 'succeeded'),
        ],
      })
      assert.equal(expanded(), 'true', 'completion must not close a manually opened group')
    } finally {
      await h.close()
    }
  })
}

test('pending, connection and running status never auto-toggle an actions group', async () => {
  const h = harness()
  const expanded = () => h.container.querySelector('button')!.getAttribute('aria-expanded')
  try {
    await h.group({ segments: [tool('one', 'succeeded')], pending: false })
    assert.equal(expanded(), 'false')
    await h.group({ segments: [tool('one')], pending: true, connectionPhase: 'syncing' })
    assert.equal(expanded(), 'false')
    await h.act(() => h.container.querySelector('button')!.click())
    await h.group({ segments: [tool('one', 'succeeded')], pending: false, connectionPhase: 'live' })
    assert.equal(expanded(), 'true')
  } finally {
    await h.close()
  }
})

test('Markdown images keep absolute URLs and resolve relative images under the authenticated workbench', async () => {
  const h = harness()
  try {
    const html = h.markdown(
      '![Desktop](https://tobs.thready.org/dsh-bot/coffee-page/preview/desktop.jpg)\n\n![Mobile](coffee-page/preview/mobile.png)',
    )
    assert.match(html, /src="https:\/\/tobs\.thready\.org\/dsh-bot\/coffee-page\/preview\/desktop.jpg"/)
    assert.match(html, /src="\/dsh-bot\/coffee-page\/preview\/mobile.png"/)
    assert.doesNotMatch(h.markdown('![unsafe](javascript:alert)'), /src="javascript:/)
  } finally {
    await h.close()
  }
})

test('image preview opens fitted, scrolls at original size, traps focus and restores it on Escape', async () => {
  const h = harness()
  const doc = h.container.ownerDocument
  const key = (value: string, shiftKey = false) => {
    const event = new doc.defaultView!.Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey } })
    doc.dispatchEvent(event)
    return event
  }
  try {
    doc.body.style.overflow = 'auto'
    await h.image({ text: '![Long screenshot](coffee-page/preview/desktop.jpg)' })
    const trigger = h.container.querySelector<HTMLButtonElement>('.image-preview-trigger')!
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger.querySelector('img')!.getAttribute('src'), '/dsh-bot/coffee-page/preview/desktop.jpg')
    trigger.focus()
    await h.act(() => trigger.click())
    const dialog = doc.querySelector<HTMLElement>('[role="dialog"]')!
    assert.ok(dialog)
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-label'), 'Long screenshot')
    assert.equal(doc.body.style.overflow, 'hidden')
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!
    const zoom = dialog.querySelector<HTMLButtonElement>('[aria-pressed]')!
    const stage = dialog.querySelector<HTMLElement>('.image-lightbox-stage')!
    assert.equal(doc.activeElement, close)
    assert.equal(zoom.textContent, 'Original size')
    assert.ok(!stage.classList.contains('original'))
    await h.act(() => zoom.click())
    assert.equal(zoom.getAttribute('aria-pressed'), 'true')
    assert.equal(zoom.textContent, 'Fit to screen')
    assert.ok(stage.classList.contains('original'))
    stage.scrollTop = 4000
    stage.scrollLeft = 200
    await h.act(() => zoom.click())
    assert.equal(stage.scrollTop, 0)
    assert.equal(stage.scrollLeft, 0)
    assert.ok(!stage.classList.contains('original'))
    stage.focus()
    const tab = key('Tab')
    assert.equal(tab.defaultPrevented, true)
    assert.equal(doc.activeElement, zoom, 'Tab wraps from scroll region to first control')
    key('Tab', true)
    assert.equal(doc.activeElement, stage, 'Shift+Tab wraps to the last focus target')
    await h.act(() => key('Escape'))
    assert.equal(doc.querySelector('[role="dialog"]'), null)
    assert.equal(doc.body.style.overflow, 'auto')
    assert.equal(doc.activeElement, trigger)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  } finally {
    await h.close()
  }
})

test('linked Markdown thumbnails avoid nested interactive elements and close by backdrop or button', async () => {
  const h = harness()
  const doc = h.container.ownerDocument
  try {
    await h.image({ text: '[![Desktop](coffee-page/preview/desktop.jpg)](https://example.com/original)' })
    const trigger = h.container.querySelector<HTMLButtonElement>('.image-preview-trigger')!
    const link = h.container.querySelector('a')!
    assert.equal(link.getAttribute('href'), 'https://example.com/original')
    assert.equal(link.textContent, 'Open image link')
    assert.equal(trigger.closest('a'), null)
    assert.equal(link.querySelector('button'), null)
    trigger.focus()
    await h.act(() => trigger.click())
    await h.act(() => doc.querySelector<HTMLElement>('.image-lightbox')!.click())
    assert.equal(doc.querySelector('[role="dialog"]'), null)
    await h.act(() => trigger.click())
    await h.act(() => doc.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click())
    assert.equal(doc.querySelector('[role="dialog"]'), null)
    await h.act(() => trigger.click())
    await h.image({ text: 'image removed during replay' })
    assert.equal(doc.querySelector('[role="dialog"]'), null)
    assert.notEqual(doc.body.style.overflow, 'hidden', 'unmount must release scroll lock')
  } finally {
    await h.close()
  }
})

test('image thumbnail bounds both axes and viewer supports fit, original-size scrolling and mobile', () => {
  const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
  const thumbnail = css.slice(css.indexOf('.markdown .image-preview-thumbnail {'))
  assert.match(thumbnail, /max-width: 100%/)
  assert.match(thumbnail, /max-height: min\(20rem, 40vh\)/)
  assert.match(thumbnail, /object-fit: contain/)
  assert.match(css, /\.image-preview-trigger \{[^}]*max-width: min\(100%, 32rem\)/s)
  assert.match(css, /\.image-lightbox-stage \{[^}]*overflow: auto/s)
  assert.match(css, /\.image-lightbox-stage\.original img \{[^}]*max-width: none;[^}]*max-height: none/s)
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.image-lightbox/)
})

test('polling callback changes keep image nodes mounted; failures survive rerender and replay remount until manual retry', async () => {
  const h = harness()
  const doc = h.container.ownerDocument
  const text = '![Desktop](coffee-page/preview/desktop.jpg)\n\n![Mobile](coffee-page/preview/mobile.jpg)'
  const error = (img: Element) => h.act(() => img.dispatchEvent(new doc.defaultView!.Event('error')))
  try {
    await h.scopedImage({ text, onOpenFile() {} })
    const initial = [...h.container.querySelectorAll('img')]
    assert.equal(initial.length, 2)
    // App creates a new onOpenFile on each interactions/status poll. This used
    // to recreate the component map, remount <img>, and reissue its request.
    for (let i = 0; i < 5; i++) {
      await h.scopedImage({ text, streaming: i % 2 === 0, onOpenFile() {} })
      assert.deepEqual([...h.container.querySelectorAll('img')], initial)
    }
    for (const img of initial) await error(img)
    assert.equal(h.container.querySelectorAll('img').length, 0, 'failed elements and src must be removed')
    assert.match(h.container.textContent!, /Image unavailable; the file may have been removed/)
    assert.match(h.container.textContent!, /Desktop/)
    for (let i = 0; i < 6; i++) {
      await h.scopedImage({ text, revision: `replay-${i}`, streaming: i % 2 === 0, onOpenFile() {} })
      assert.equal(h.container.querySelectorAll('img').length, 0, 'polling or replay must not retry failed src')
      assert.equal(doc.querySelector('[role="dialog"]'), null)
    }
    let retry = h.container.querySelector<HTMLButtonElement>('.image-unavailable button')!
    await h.act(() => retry.click())
    assert.equal(h.container.querySelectorAll('img').length, 1, 'one manual retry adds just that thumbnail')
    await error(h.container.querySelector('img')!)
    assert.equal(h.container.querySelectorAll('img').length, 0)
    retry = h.container.querySelector<HTMLButtonElement>('.image-unavailable button')!
    await h.act(() => retry.click())
    const recovered = h.container.querySelector('img')!
    await h.act(() => recovered.dispatchEvent(new doc.defaultView!.Event('load')))
    await h.scopedImage({ text, onOpenFile() {}, revision: 'replay-5' })
    assert.equal(h.container.querySelector('img'), recovered, 'recovery does not remount on next poll')
    await h.scopedImage({ text: '![New image](coffee-page/preview/new.jpg)', revision: 'new' })
    assert.match(h.container.querySelector('img')!.getAttribute('src')!, /new.jpg$/)
    await h.scopedImage({ text, sessionId: 'session-two' })
    assert.equal(h.container.querySelectorAll('img').length, 2, 'a new session view does not inherit failures')
  } finally {
    await h.close()
  }
})

test('viewer error releases modal state, shows neutral unavailable message and never retries on polling', async () => {
  const h = harness()
  const doc = h.container.ownerDocument
  const text = '![Long screenshot](coffee-page/preview/desktop.jpg)'
  try {
    await h.scopedImage({ text })
    await h.act(() => h.container.querySelector<HTMLButtonElement>('.image-preview-trigger')!.click())
    const viewer = doc.querySelector('.image-lightbox img')!
    await h.act(() => viewer.dispatchEvent(new doc.defaultView!.Event('error')))
    assert.equal(doc.querySelector('[role="dialog"]'), null)
    assert.equal(doc.querySelector('img'), null)
    assert.notEqual(doc.body.style.overflow, 'hidden')
    assert.match(h.container.textContent!, /may have been removed/)
    for (let i = 0; i < 3; i++) await h.scopedImage({ text, revision: String(i), onOpenFile() {} })
    assert.equal(doc.querySelector('img'), null)
    assert.equal(doc.querySelector('[role="dialog"]'), null)
  } finally {
    await h.close()
  }
})

test('authorization catalog loads only for an open drawer and dynamic prompts do not reload it', async () => {
  const h = harness()
  let reads = 0
  const catalog = createAuthorizationCatalog(async () => {
    reads++
    return {
      available: true,
      entries: [
        {
          key: 'sample',
          label: 'Sample provider',
          methods: [{ id: 'browser', label: 'Browser login' }],
          inFlight: false,
        },
      ],
    }
  })
  const authorization = { available: true, catalogRevision: 1, inFlight: [], prompts: [], notices: [] }
  try {
    await h.image({ text: 'idle conversation' })
    assert.equal(reads, 0)
    await h.authPanel({ onClose() {}, catalog, authorization })
    assert.equal(reads, 1)
    for (let i = 0; i < 5; i++) {
      await h.authPanel({
        onClose() {},
        catalog,
        authorization: {
          ...authorization,
          prompts: [{ promptId: 'official-prompt', kind: 'text', message: `Pending prompt ${i}` }],
          notices: [{ message: 'Continue browser login' }],
          inFlight: ['sample'],
        },
      })
    }
    assert.equal(reads, 1, 'SSE prompt/notice changes must not refetch static provider entries')
    assert.match(h.container.ownerDocument.body.textContent!, /Pending prompt 4/)
    const cancel = [...h.container.ownerDocument.querySelectorAll('button')].find(
      button => button.textContent === 'Cancel',
    )
    assert.ok(cancel && !cancel.disabled, 'the live authorization flow must remain cancellable')
    catalog.invalidate()
    await h.authPanel({ onClose() {}, catalog, authorization: { ...authorization, catalogRevision: 2 } })
    assert.equal(reads, 2)
    await h.image({ text: 'drawer closed' })
    await h.authPanel({ onClose() {}, catalog, authorization: { ...authorization, catalogRevision: 2 } })
    assert.equal(reads, 2, 'reopening within TTL shares the per-App cache')
  } finally {
    await h.close()
  }
})
