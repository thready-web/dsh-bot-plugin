import { resolvePath, type RawNode } from './canvas-path.ts'

export interface CanvasMention {
  path: string
  tag: string
  classes: string[]
  text: string
  breadcrumb: { path: string; tag: string; classes: string[] }[]
  label: string
}

/** Build a mention from source HTML. A path the tree cannot walk returns null. */
export function mentionFrom(body: RawNode, path: string): CanvasMention | null {
  const found = resolvePath(body, path)
  if (!found) return null
  const text = found.node.text.slice(0, 80)
  const shown = text.length > 42 ? `${text.slice(0, 42)}…` : text
  return {
    path,
    tag: found.node.tag,
    classes: found.node.classes,
    text,
    breadcrumb: found.breadcrumb,
    label: shown ? `${found.node.tag} · ${shown}` : found.node.tag,
  }
}
