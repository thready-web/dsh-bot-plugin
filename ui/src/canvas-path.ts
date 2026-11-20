export interface RawNode {
  tag: string
  classes: string[]
  text: string
  rawChildren: RawNode[]
  parent: RawNode | null
}

export interface Crumb {
  path: string
  tag: string
  classes: string[]
}

export interface DomLike {
  tagName: string
  classList?: Iterable<string>
  textContent: string | null
  children: ArrayLike<DomLike>
}

const TABLE_SECTION = new Set(['tbody', 'thead', 'tfoot'])
const SEGMENT = /^(\d+):([a-z][a-z0-9-]*)$/

export function collapseText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function adoptElement(el: DomLike, parent: RawNode | null = null): RawNode {
  const node: RawNode = {
    tag: el.tagName.toLowerCase(),
    classes: el.classList ? [...el.classList] : [],
    text: collapseText(el.textContent),
    rawChildren: [],
    parent,
  }
  for (let i = 0; i < el.children.length; i++) node.rawChildren.push(adoptElement(el.children[i]!, node))
  return node
}

/** Table sections inserted by the parser are not path steps. Rows stay under the table. */
export function visibleChildren(node: RawNode): RawNode[] {
  const out: RawNode[] = []
  for (const child of node.rawChildren) {
    if (node.tag === 'table' && TABLE_SECTION.has(child.tag)) out.push(...child.rawChildren)
    else out.push(child)
  }
  return out
}

export function parsePath(path: string): { index: number; tag: string }[] | null {
  if (path === '') return []
  if (path.length > 500 || path.includes('//')) return null
  const parts = path.split('/')
  const segs: { index: number; tag: string }[] = []
  for (const part of parts) {
    const match = SEGMENT.exec(part)
    if (!match) return null
    const index = Number(match[1])
    if (!Number.isInteger(index) || index > 10000 || String(index) !== match[1]) return null
    segs.push({ index, tag: match[2]! })
  }
  return segs
}

export function formatPath(segs: readonly { index: number; tag: string }[]): string {
  return segs.map(seg => `${seg.index}:${seg.tag}`).join('/')
}

export function resolvePath(body: RawNode, path: string): { node: RawNode; breadcrumb: Crumb[] } | null {
  const segs = parsePath(path)
  if (!segs) return null
  const breadcrumb: Crumb[] = [{ path: '', tag: body.tag, classes: body.classes }]
  const acc: { index: number; tag: string }[] = []
  let current = body
  for (const seg of segs) {
    const child = visibleChildren(current)[seg.index]
    if (!child || child.tag !== seg.tag) return null
    acc.push(seg)
    current = child
    breadcrumb.push({ path: formatPath(acc), tag: child.tag, classes: child.classes })
  }
  return { node: current, breadcrumb }
}

export function pathTo(body: RawNode, node: RawNode): string | null {
  if (node === body) return ''
  const parts: string[] = []
  let current: RawNode | null = node
  while (current && current !== body) {
    let parent: RawNode | null = current.parent
    if (!parent) return null
    if (TABLE_SECTION.has(parent.tag) && parent.parent?.tag === 'table') parent = parent.parent
    const index = visibleChildren(parent).indexOf(current)
    if (index < 0) return null
    parts.push(`${index}:${current.tag}`)
    current = parent
  }
  if (current !== body) return null
  return parts.reverse().join('/')
}
