/**
 * Build a sandboxed preview document from bytes the parent already verified.
 * The frame has an opaque origin, so it cannot send the app cookie. Every
 * stylesheet, image, and font is inlined. Nothing in the document points at
 * the app origin.
 */

import { normalizeClientPath } from './canvas-access.ts'

const FAKE_BASE = 'https://canvas.invalid/preview/'
const DROP = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'svg', 'foreignobject'])
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const FONT = new Set(['font/woff', 'font/woff2', 'font/ttf', 'font/otf'])

export interface CanvasFrameFile {
  type: string
  bytes: Uint8Array
}

interface MarkupNode {
  tagName: string
  children: ArrayLike<MarkupNode>
  attributes: ArrayLike<{ name: string; value: string }>
  textContent: string | null
  innerHTML: string
  parentElement: MarkupNode | null
  contains(node: MarkupNode): boolean
  remove(): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  querySelectorAll(selector: string): ArrayLike<MarkupNode>
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeStyle(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

function escapeScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function dataUrl(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${bytesToBase64(bytes)}`
}

function isLocalRef(value: string): boolean {
  if (value === '' || value.length > 200) return false
  if (/[\s\\?#]/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('/')) return false
  return true
}

function resolveAgainst(fromFile: string, relative: string): string | null {
  if (!isLocalRef(relative)) return null
  const stack = fromFile.split('/').slice(0, -1)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return normalizeClientPath(stack.join('/'))
}

function embed(path: string | null, files: ReadonlyMap<string, CanvasFrameFile>, kinds: Set<string>): string | null {
  if (!path) return null
  const file = files.get(path)
  if (!file || !kinds.has(file.type)) return null
  return dataUrl(file.type, file.bytes)
}

export function rewriteCss(css: string, fromFile: string, files: ReadonlyMap<string, CanvasFrameFile>): string {
  const withoutImport = css.replace(/@import\b[^;]*;?/gi, '/* import removed */')
  return withoutImport.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_all, _quote: string, raw: string) => {
    const path = resolveAgainst(fromFile, raw.trim())
    const href = embed(path, files, new Set([...IMAGE, ...FONT]))
    return `url("${href ?? 'data:,'}")`
  })
}

function scrub(el: MarkupNode) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase()
    if (DROP.has(tag)) {
      child.remove()
      continue
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()
      if (name.startsWith('on') || name === 'srcdoc') child.removeAttribute(attr.name)
      else if (
        (name === 'href' || name === 'src' || name === 'action' || name === 'formaction') &&
        /^(javascript:|data:|https?:|\/\/)/i.test(value)
      )
        child.removeAttribute(attr.name)
    }
    scrub(child)
  }
}

function rewriteImages(root: MarkupNode, files: ReadonlyMap<string, CanvasFrameFile>) {
  const visit = (el: MarkupNode) => {
    const style = el.getAttribute('style')
    if (style) el.setAttribute('style', rewriteCss(style, 'index.html', files))
    const tag = el.tagName.toLowerCase()
    if (tag === 'img' || tag === 'source') {
      const src = el.getAttribute('src')
      if (src != null) {
        const href = embed(resolveAgainst('index.html', src.trim()), files, IMAGE)
        if (href) el.setAttribute('src', href)
        else el.removeAttribute('src')
      }
      const srcset = el.getAttribute('srcset')
      if (srcset != null) {
        const next = srcset
          .split(',')
          .map(part => {
            const bits = part.trim().split(/\s+/)
            const href = embed(resolveAgainst('index.html', bits[0] ?? ''), files, IMAGE)
            if (!href) return ''
            return [href, ...bits.slice(1)].join(' ')
          })
          .filter(Boolean)
          .join(', ')
        if (next) el.setAttribute('srcset', next)
        else el.removeAttribute('srcset')
      }
    }
    if (tag === 'video') {
      const poster = el.getAttribute('poster')
      if (poster != null) {
        const href = embed(resolveAgainst('index.html', poster.trim()), files, IMAGE)
        if (href) el.setAttribute('poster', href)
        else el.removeAttribute('poster')
      }
    }
    for (const child of Array.from(el.children)) visit(child)
  }
  visit(root)
}

function isHttpOrigin(value: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(value)
}

/** Returns null when the page is not a verified HTML file. The result never contains a media URL. */
export function buildCanvasSrcdoc(input: {
  files: ReadonlyMap<string, CanvasFrameFile>
  page: string
  nonce: string
  parentOrigin: string
  inspectorSource: string
  scriptNonce: string
}): string | null {
  const page = normalizeClientPath(input.page)
  const pageFile = page ? input.files.get(page) : undefined
  if (!page || !pageFile || pageFile.type !== 'text/html') return null
  if (!isHttpOrigin(input.parentOrigin)) return null
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(input.nonce) || !/^[A-Za-z0-9_-]{16,80}$/.test(input.scriptNonce)) return null
  if (typeof DOMParser === 'undefined') return null
  const document = new DOMParser().parseFromString(
    new TextDecoder().decode(pageFile.bytes),
    'text/html',
  ) as unknown as {
    body: MarkupNode
    querySelectorAll(selector: string): ArrayLike<MarkupNode>
  }
  const sheets: string[] = []
  for (const node of Array.from(document.querySelectorAll('link, style'))) {
    const inBody = document.body.contains(node)
    if (node.tagName === 'STYLE') {
      const css = rewriteCss(node.textContent ?? '', 'index.html', input.files)
      if (inBody) {
        node.textContent = css
        continue
      }
      const media = node.getAttribute('media')
      const mediaAttr = media && media.length <= 200 && !/[\r\n<>]/.test(media) ? ` media="${escapeAttr(media)}"` : ''
      sheets.push(`<style${mediaAttr}>${escapeStyle(css)}</style>`)
      continue
    }
    const rel = (node.getAttribute('rel') ?? '').toLowerCase()
    const href = (node.getAttribute('href') ?? '').trim()
    node.remove()
    if (!rel.split(/\s+/).includes('stylesheet')) continue
    const cssPath = resolveAgainst('index.html', href)
    const cssFile = cssPath ? input.files.get(cssPath) : undefined
    if (!cssPath || !cssFile || cssFile.type !== 'text/css') continue
    sheets.push(
      `<style>${escapeStyle(rewriteCss(new TextDecoder().decode(cssFile.bytes), cssPath, input.files))}</style>`,
    )
  }
  scrub(document.body)
  rewriteImages(document.body, input.files)
  const policy = [
    "default-src 'none'",
    'base-uri https://canvas.invalid',
    "form-action 'none'",
    `script-src 'nonce-${input.scriptNonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
  ].join('; ')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}">
<base href="${FAKE_BASE}">
<meta name="dsh-inspect-nonce" content="${escapeAttr(input.nonce)}">
<meta name="dsh-parent-origin" content="${escapeAttr(input.parentOrigin)}">
<meta name="dsh-inspect-page" content="${escapeAttr(page)}">
${sheets.join('\n')}
</head>
<body>
${document.body.innerHTML}
<script nonce="${escapeAttr(input.scriptNonce)}">${escapeScript(input.inspectorSource)}</script>
</body>
</html>`
}
