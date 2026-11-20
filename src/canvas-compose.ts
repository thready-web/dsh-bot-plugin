import { parseHTML } from 'linkedom'

const DROP = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'svg', 'foreignobject'])

interface InspectNode {
  tagName: string
  children: ArrayLike<InspectNode>
  attributes: ArrayLike<{ name: string; value: string }>
  textContent: string | null
  innerHTML: string
  contains(node: InspectNode): boolean
  remove(): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
}

interface InspectDocument {
  body: InspectNode
  querySelectorAll(selector: string): ArrayLike<InspectNode>
}

function isRelativeAsset(href: string): boolean {
  if (href === '' || href.length > 200) return false
  if (/[\s\\]/.test(href) || href.includes('..')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) return false
  return true
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Keep a head <style> from closing itself and becoming markup. */
function escapeStyle(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

function scrub(el: InspectNode) {
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

/** Scriptless design plus the host inspector. CSP stays with the caller. */
export function composeInspect(
  html: string,
  options: { baseHref: string; nonce: string; parentOrigin: string; inspectorSrc: string; page?: string },
): string {
  const { document } = parseHTML(html) as unknown as { document: InspectDocument }
  const sheets: string[] = []
  for (const node of Array.from(document.querySelectorAll('link, style'))) {
    if (document.body.contains(node)) continue
    if (node.tagName === 'STYLE') {
      const media = node.getAttribute('media')
      const mediaAttr = media && media.length <= 200 && !/[\r\n<>]/.test(media) ? ` media="${escapeAttr(media)}"` : ''
      sheets.push(`<style${mediaAttr}>${escapeStyle(node.textContent ?? '')}</style>`)
      continue
    }
    const rel = (node.getAttribute('rel') ?? '').toLowerCase()
    const href = (node.getAttribute('href') ?? '').trim()
    if (!rel.split(/\s+/).includes('stylesheet') || !isRelativeAsset(href)) continue
    sheets.push(`<link rel="stylesheet" href="${escapeAttr(href)}">`)
  }
  scrub(document.body)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base href="${escapeAttr(options.baseHref)}">
<meta name="dsh-inspect-nonce" content="${escapeAttr(options.nonce)}">
<meta name="dsh-parent-origin" content="${escapeAttr(options.parentOrigin)}">
${options.page ? `<meta name="dsh-inspect-page" content="${escapeAttr(options.page)}">` : ''}
${sheets.join('\n')}
</head>
<body>
${document.body.innerHTML}
<script src="${escapeAttr(options.inspectorSrc)}"></script>
</body>
</html>`
}
