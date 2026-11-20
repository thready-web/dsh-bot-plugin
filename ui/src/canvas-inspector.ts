import { mentionFrom } from './canvas-mention.ts'
import { parsePath, pathTo, resolvePath, adoptElement, type RawNode } from './canvas-path.ts'

const CHANNEL = 'canvas-inspect'

function meta(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? ''
}

function box(id: string, outline: string, fill: string): HTMLDivElement {
  const el = document.createElement('div')
  el.id = id
  el.setAttribute('aria-hidden', 'true')
  el.style.setProperty('all', 'initial')
  el.style.position = 'fixed'
  el.style.pointerEvents = 'none'
  el.style.zIndex = '2147483646'
  el.style.boxSizing = 'border-box'
  el.style.display = 'none'
  el.style.outline = outline
  el.style.outlineOffset = '-2px'
  el.style.background = fill
  document.documentElement.append(el)
  return el
}

function place(el: HTMLElement, target: Element) {
  const rect = target.getBoundingClientRect()
  el.style.display = 'block'
  el.style.left = `${rect.left}px`
  el.style.top = `${rect.top}px`
  el.style.width = `${Math.max(rect.width, 0)}px`
  el.style.height = `${Math.max(rect.height, 0)}px`
}

const nonce = meta('dsh-inspect-nonce')
const parentOrigin = meta('dsh-parent-origin')
const pageName = meta('dsh-inspect-page')

function anchorPage(target: Element): { path: string; hash: string } | null {
  const anchor = target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  const href = anchor.getAttribute('href')?.trim() ?? ''
  if (href === '' || href.startsWith('#')) return null
  let url: URL
  try {
    url = new URL(href, document.baseURI)
  } catch {
    return null
  }
  const base = new URL(document.baseURI)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null
  let rel = url.pathname.slice(base.pathname.length)
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.html$/.test(rel)) return null
  return { path: rel, hash: url.hash }
}

if (nonce && parentOrigin && document.body) {
  const hoverBox = box('dsh-hover', '2px solid #2563eb', 'rgba(37, 99, 235, 0.12)')
  const pinBox = box('dsh-pin', '2px solid #b45309', 'rgba(180, 83, 9, 0.1)')
  const tip = document.createElement('div')
  tip.id = 'dsh-tip'
  tip.setAttribute('aria-hidden', 'true')
  tip.style.setProperty('all', 'initial')
  tip.style.position = 'fixed'
  tip.style.pointerEvents = 'none'
  tip.style.zIndex = '2147483647'
  tip.style.display = 'none'
  tip.style.font = '12px/1.3 ui-sans-serif, system-ui, sans-serif'
  tip.style.color = '#fff'
  tip.style.background = '#1c1917'
  tip.style.padding = '4px 8px'
  tip.style.borderRadius = '6px'
  tip.style.whiteSpace = 'nowrap'
  tip.style.maxWidth = '70vw'
  tip.style.overflow = 'hidden'
  tip.style.textOverflow = 'ellipsis'
  document.documentElement.append(tip)

  const body = adoptElement(document.body)
  const elements = new Map<RawNode, Element>()
  const nodes = new WeakMap<Element, RawNode>()

  const index = (el: Element, node: RawNode) => {
    nodes.set(el, node)
    elements.set(node, el)
    for (let i = 0; i < el.children.length; i++) index(el.children[i]!, node.rawChildren[i]!)
  }
  index(document.body, body)

  let armed = false
  let hoverEl: Element | null = null
  let pinnedEl: Element | null = null
  let hoverPath = ''
  let queued: Element | null = null
  let scheduled = false

  const post = (type: string, path: string, target: Element | null) => {
    const rect = target?.getBoundingClientRect()
    const node = target ? nodes.get(target) : null
    window.parent.postMessage(
      {
        dsh: CHANNEL,
        nonce,
        type,
        path,
        tag: node?.tag ?? '',
        classes: node?.classes ?? [],
        text: node?.text ?? '',
        rect: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
      },
      parentOrigin,
    )
  }

  const nodeFor = (el: Element): RawNode | null => {
    let current: Element | null = el
    while (current && current !== document.documentElement) {
      if (current.id.startsWith('dsh-') || current.tagName === 'SCRIPT') {
        current = current.parentElement
        continue
      }
      const found = nodes.get(current)
      if (found) return found
      current = current.parentElement
    }
    return null
  }

  const hideHover = () => {
    hoverEl = null
    hoverPath = ''
    hoverBox.style.display = 'none'
    tip.style.display = 'none'
    post('leave', '', null)
  }

  const showTip = (el: Element, node: RawNode, path: string) => {
    const rect = el.getBoundingClientRect()
    const mention = mentionFrom(body, path)
    const trail = mention
      ? mention.breadcrumb.map(item => (item.classes[0] ? `${item.tag}.${item.classes[0]}` : item.tag)).join(' / ')
      : node.tag
    tip.textContent = `${trail}  ${Math.round(rect.width)}×${Math.round(rect.height)}`
    tip.style.display = 'block'
    const top = rect.top < 28 ? rect.bottom + 6 : rect.top - 26
    tip.style.left = `${Math.max(rect.left, 4)}px`
    tip.style.top = `${top}px`
  }

  const hover = (el: Element | null) => {
    if (!el) {
      hideHover()
      return
    }
    const node = nodeFor(el)
    if (!node) {
      hideHover()
      return
    }
    const path = pathTo(body, node)
    const target = path == null ? null : elements.get(resolvePath(body, path)?.node ?? node)
    if (path == null || !target) {
      hideHover()
      return
    }
    if (path === hoverPath) return
    hoverPath = path
    hoverEl = target
    place(hoverBox, target)
    showTip(target, nodes.get(target) ?? node, path)
    post('hover', path, target)
  }

  const pin = (el: Element) => {
    const node = nodeFor(el)
    if (!node) return
    const path = pathTo(body, node)
    if (path == null) return
    const target = elements.get(resolvePath(body, path)?.node ?? node)
    if (!target) return
    pinnedEl = target
    place(pinBox, target)
    post('select', path, target)
  }

  document.addEventListener('pointermove', event => {
    if (!armed) return
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    queued = hit instanceof Element ? hit : null
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      hover(queued)
    })
  })

  document.documentElement.addEventListener('pointerleave', () => {
    if (armed) hideHover()
  })

  document.addEventListener(
    'click',
    event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (armed) {
        event.preventDefault()
        event.stopPropagation()
        pin(target)
        return
      }
      const link = anchorPage(target)
      if (!link) return
      if (link.path === pageName) {
        if (!link.hash) event.preventDefault()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      post('open', link.hash ? `${link.path}${link.hash}` : link.path, null)
    },
    true,
  )

  document.addEventListener(
    'scroll',
    () => {
      if (!armed) return
      if (pinnedEl) place(pinBox, pinnedEl)
      if (hoverEl) {
        place(hoverBox, hoverEl)
        const node = nodes.get(hoverEl)
        if (node) showTip(hoverEl, node, hoverPath)
      }
    },
    true,
  )

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return
    const data = event.data as {
      dsh?: unknown
      nonce?: unknown
      type?: unknown
      path?: unknown
      anchor?: unknown
    } | null
    if (!data || data.dsh !== CHANNEL || data.nonce !== nonce) return
    if (data.type === 'hello') {
      post('ready', '', document.body)
      return
    }
    if (data.type === 'focus' && typeof data.anchor === 'string' && /^[A-Za-z][\w-]{0,64}$/.test(data.anchor)) {
      document.getElementById(data.anchor)?.scrollIntoView({ block: 'start' })
      return
    }
    if (data.type === 'arm') {
      armed = true
      if (pinnedEl) place(pinBox, pinnedEl)
      return
    }
    if (data.type === 'disarm') {
      armed = false
      hideHover()
      pinBox.style.display = 'none'
      return
    }
    if (data.type !== 'pin') return
    if (typeof data.path !== 'string' || !parsePath(data.path)) return
    const found = resolvePath(body, data.path)
    const el = found ? elements.get(found.node) : null
    if (!el) return
    pinnedEl = el
    if (!armed) return
    place(pinBox, el)
    el.scrollIntoView({ block: 'nearest' })
  })

  post('ready', '', document.body)
}
