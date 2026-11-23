import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OverlayHistoryController,
  isOverlayEntry,
  readOverlayDepth,
  readOverlayTag,
  stripOverlaySegment,
  withOverlaySegment,
} from './overlay-history.ts'

function splitUrl(raw: string) {
  const url = new URL(raw, 'https://bot.example/dsh-bot/')
  return { pathname: url.pathname, search: url.search, hash: url.hash }
}

function joinUrl({ pathname, search, hash }: { pathname: string; search: string; hash: string }) {
  return pathname + search + hash
}

/** One fake window with a history entry stack and popstate / hashchange events. */
function createWindow(initial: string) {
  const entries: Array<{ url: string; state: unknown }> = [{ url: initial, state: null }]
  let index = 0
  const listeners = new Map<string, Set<() => void>>()
  const location = splitUrl(initial)

  const current = () => entries[index]!

  const show = (url: string) => {
    const next = splitUrl(url)
    location.pathname = next.pathname
    location.search = next.search
    location.hash = next.hash
  }

  const write = (state: unknown, raw: string, mode: 'push' | 'replace') => {
    const next = splitUrl(raw)
    show(joinUrl(next))
    const entry = { url: joinUrl(next), state: state === undefined ? null : state }
    if (mode === 'push') {
      entries.length = index + 1
      entries.push(entry)
      index = entries.length - 1
    } else entries[index] = entry
  }

  const dispatch = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener()
  }

  const go = (delta: number) => {
    const target = index + delta
    assert.ok(target >= 0 && target < entries.length, 'history bound reached')
    index = target
    show(current().url)
    dispatch('popstate')
    dispatch('hashchange')
  }

  const window = {
    location,
    history: {
      get state() {
        return current().state
      },
      pushState(state: unknown, _title: string, raw: string) {
        write(state, raw, 'push')
      },
      replaceState(state: unknown, _title: string, raw: string) {
        write(state, raw, 'replace')
      },
      back() {
        go(-1)
      },
    },
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
  }

  return {
    window,
    url: () => joinUrl(location),
    entries: () => entries.map(entry => entry.url),
    states: () => entries.map(entry => entry.state),
    position: () => index,
    back: () => go(-1),
    /** A pasted URL: changes the current entry without a history traversal. */
    externalNavigate(raw: string) {
      show(raw)
      dispatch('popstate')
      dispatch('hashchange')
    },
  }
}

const tick = async (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async () => {
  await tick(0)
  await tick(120)
}

function boot(initial: string, ids: string[]) {
  const browser = createWindow(initial)
  let open = [...ids]
  const closed: string[] = []
  let clock = 1_000_000
  const controller = new OverlayHistoryController({
    history: browser.window.history,
    location: browser.window.location,
    addEventListener: (type, listener) => browser.window.addEventListener(type, listener),
    removeEventListener: (type, listener) => browser.window.removeEventListener(type, listener),
    stack: () => open,
    close: id => {
      closed.push(id)
      open = open.filter(item => item !== id)
    },
    now: () => clock,
  })
  controller.start()
  return {
    ...browser,
    controller,
    open: () => open,
    closed: () => closed,
    set(next: string[]) {
      open = [...next]
    },
    dispose: () => controller.dispose(),
  }
}

test('the overlay depth sits next to the Session segment and survives a strip', () => {
  assert.equal(withOverlaySegment('#/s/A', 1), '#/s/A/o/1')
  assert.equal(withOverlaySegment('#/s/A/o/1', 2), '#/s/A/o/2')
  assert.equal(withOverlaySegment('#/', 1), '#/o/1')
  assert.equal(withOverlaySegment('#/s/A/o/1', 0), '#/s/A')
  assert.equal(stripOverlaySegment('#/s/A/o/2'), '#/s/A')
  assert.equal(stripOverlaySegment('#/o/1'), '#/')
  assert.equal(stripOverlaySegment('#/'), '#/')
  assert.equal(readOverlayDepth('#/s/A/o/1'), 1)
  assert.equal(readOverlayDepth('#/o/2'), 2)
  assert.equal(readOverlayDepth('#/s/A'), 0)
  assert.equal(readOverlayDepth(''), 0)
  assert.equal(readOverlayTag({ __dshBotUiOverlay: { kind: 'overlay', depth: 3 } })?.depth, 3)
  assert.equal(readOverlayTag({ __dshBotUiOverlay: { kind: 'route' } }), undefined)
  assert.equal(readOverlayTag(null), undefined)
  assert.equal(isOverlayEntry({ __dshBotUiOverlay: { kind: 'overlay', depth: 1 } }), true)
  assert.equal(isOverlayEntry({ __dshBotUiOverlay: { kind: 'route', depth: 0 } }), false)
  assert.equal(isOverlayEntry({ kind: 'worker', owner: 'A' }), false)
})

test('opening an overlay pushes one entry and closing it with the app control rewinds it', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A'])

  env.set(['files'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A', '/dsh-bot/#/s/A/o/1'])
  assert.equal(env.position(), 1)

  // The app's own close button already removed the drawer from React state.
  env.set([])
  env.controller.sync()
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A')
  assert.equal(env.position(), 0)
  // No corrective entry is appended.
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A', '/dsh-bot/#/s/A/o/1'])
  assert.deepEqual(env.closed(), [])
  env.dispose()
})

test('Back peels exactly the top overlay off a stacked drawer + modal', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  env.set(['files'])
  env.controller.sync()
  env.set(['files', 'settings:permission'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/2')
  assert.equal(env.position(), 2)

  env.back()
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')
  assert.equal(env.position(), 1)
  assert.deepEqual(env.open(), ['files'])
  assert.deepEqual(env.closed(), ['settings:permission'])
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A', '/dsh-bot/#/s/A/o/1', '/dsh-bot/#/s/A/o/2'])
  env.dispose()
})

test('Back from depth 2 to 0 closes both overlays without appending entries', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  env.set(['files'])
  env.controller.sync()
  env.set(['files', 'delete'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/2')

  // A single browser Back lands on the depth-1 entry; the router must not
  // invent a third entry while closing.
  env.back()
  await settle()
  env.back()
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A')
  assert.equal(env.position(), 0)
  assert.deepEqual(env.open(), [])
  assert.deepEqual(env.closed(), ['delete', 'files'])
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A', '/dsh-bot/#/s/A/o/1', '/dsh-bot/#/s/A/o/2'])
  env.dispose()
})

test('an overlay segment on a deep link is dropped when nothing is open', async () => {
  const env = boot('/dsh-bot/#/s/A/o/1', [])
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A')
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A'])
  env.dispose()
})

test('a pasted hash without the overlay segment closes the open overlay', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  env.set(['files'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')

  env.externalNavigate('#/s/A')
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A')
  assert.deepEqual(env.open(), [])
  assert.deepEqual(env.closed(), ['files'])
  env.dispose()
})

test('closing an entry that no longer carries our marker rewrites it in place', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  env.set(['files'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')

  // Session selection replaces the current entry and wipes our state marker.
  env.window.history.replaceState(null, '', '/dsh-bot/#/s/B')
  env.set([])
  env.controller.sync()
  await settle()
  assert.equal(env.position(), 1)
  assert.equal(env.url(), '/dsh-bot/#/s/B')
  env.dispose()
})

test('swapping one overlay for another at the same depth still rewinds on the app close', async () => {
  const env = boot('/dsh-bot/#/s/A', [])
  await settle()
  env.set(['files'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')

  // Opening memory closes the file drawer in the same React update, so the
  // depth does not change.
  env.set(['settings:memory'])
  env.controller.sync()
  assert.equal(env.url(), '/dsh-bot/#/s/A/o/1')
  assert.equal(env.position(), 1)

  env.set([])
  env.controller.sync()
  await settle()
  assert.equal(env.url(), '/dsh-bot/#/s/A')
  assert.equal(env.position(), 0)
  assert.deepEqual(env.entries(), ['/dsh-bot/#/s/A', '/dsh-bot/#/s/A/o/1'])
  env.dispose()
})
