export interface CanvasChip {
  canvasId: string
  revision: number
  path: string
  tag: string
  label: string
}

const BLOCK =
  /\[canvas-target canvas=(cnv_[A-Za-z0-9_-]{16}) rev=([1-9]\d{0,8}) path=(\.|[0-9]+:[a-z][a-z0-9-]*(?:\/[0-9]+:[a-z][a-z0-9-]*)*) tag=([a-z][a-z0-9-]*)\]([^[\]]*)\[\/canvas-target\]/g

/** Name the canvas card, then the revision inside that canvas, then the element. */
export function mentionLabel(canvasName: string, version: string, tag: string, text: string): string {
  const name = canvasName.replace(/\s+/g, ' ').trim()
  const shown = name.length > 18 ? `${name.slice(0, 18)}…` : name
  const flat = text.replace(/\s+/g, ' ').trim()
  const excerpt = flat.length > 12 ? `${flat.slice(0, 12)}…` : flat
  const body = excerpt ? `${tag} · ${excerpt}` : tag
  return shown ? `${shown} · ${version} · ${body}` : `${version} · ${body}`
}

export function formatCanvasTarget(chip: CanvasChip): string {
  const label = chip.label.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  const path = chip.path === '' ? '.' : chip.path
  return `[canvas-target canvas=${chip.canvasId} rev=${chip.revision} path=${path} tag=${chip.tag}]${label}[/canvas-target]`
}

/** Pull mention chips out of a user message. The remaining text is what they typed. */
export function splitCanvasMessage(text: string): { text: string; chips: CanvasChip[] } {
  const chips: CanvasChip[] = []
  const stripped = text
    .replace(BLOCK, (_all, canvasId: string, revision: string, path: string, tag: string, label: string) => {
      chips.push({
        canvasId,
        revision: Number(revision),
        path: path === '.' ? '' : path,
        tag,
        label: label.trim(),
      })
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: stripped, chips }
}
