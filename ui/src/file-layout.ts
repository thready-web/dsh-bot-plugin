export const SHELL_MAX = 1120
export const SIDEBAR_PREF = 268
export const SIDEBAR_MIN = 220
export const CHAT_MIN = 400
export const DRAWER_MIN = 320
export const DRAWER_MAX = 960
export const DRAWER_PREF = 640

export function clampDrawerWidth(value: number) {
  if (!Number.isFinite(value)) return DRAWER_PREF
  return Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, Math.round(value)))
}

export type FilePush = {
  drawer: number
  reserve: number
  sidebar: number
  inset: number
  insetRight: number
  overlap: boolean
}

function marginOf(viewport: number) {
  return Math.max(0, (viewport - Math.min(SHELL_MAX, viewport)) / 2)
}

/** Closed shell, expressed as a full-width frame with the same side blanks. */
export function closedPush(viewport: number): FilePush {
  const margin = marginOf(viewport)
  return {
    drawer: 0,
    reserve: 0,
    sidebar: SIDEBAR_PREF,
    inset: margin,
    insetRight: margin,
    overlap: false,
  }
}

/**
 * Room for the drawer is taken from the side blanks first, then from the
 * session list and chat down to their minimums. Past that, the drawer overlaps.
 */
export function filePush(viewport: number, desired: number): FilePush {
  const drawer = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, desired))
  const preferred = Math.min(SHELL_MAX, viewport)
  const margin = marginOf(viewport)
  const minContent = SIDEBAR_MIN + CHAT_MIN
  if (drawer <= margin) {
    return { drawer, reserve: 0, sidebar: SIDEBAR_PREF, inset: margin, insetRight: margin, overlap: false }
  }

  const inset = Math.max(0, margin - (drawer - margin))
  const content = viewport - inset - drawer
  if (content < minContent) {
    return {
      drawer,
      reserve: Math.max(0, viewport - minContent),
      sidebar: SIDEBAR_MIN,
      inset: 0,
      insetRight: 0,
      overlap: true,
    }
  }

  const squeeze = Math.max(0, preferred - content)
  const chatSlack = Math.max(0, preferred - SIDEBAR_PREF - CHAT_MIN)
  const sidebarSlack = Math.max(0, SIDEBAR_PREF - SIDEBAR_MIN)
  const total = chatSlack + sidebarSlack
  const chatShrink = total === 0 ? 0 : Math.min(chatSlack, (squeeze * chatSlack) / total)
  const sidebarShrink = Math.min(sidebarSlack, Math.max(0, squeeze - chatShrink))
  return {
    drawer,
    reserve: drawer,
    sidebar: SIDEBAR_PREF - sidebarShrink,
    inset,
    insetRight: 0,
    overlap: false,
  }
}

/**
 * Which directory the drawer shows first. A closed home is never selected.
 * Workspace wins when both roots are open, so Home is not the landing view.
 */
export function initialFileLocation(roots: {
  workspace: string | null
  home: string | null
  workspaceReason: string
}):
  | { kind: 'path'; root: 'workspace' | 'home'; path: string }
  | { kind: 'unavailable'; notice: 'files.overlap' | 'files.denied' | 'files.missing' } {
  if (roots.workspace) return { kind: 'path', root: 'workspace', path: roots.workspace }
  if (roots.home) return { kind: 'path', root: 'home', path: roots.home }
  if (roots.workspaceReason === 'overlap') return { kind: 'unavailable', notice: 'files.overlap' }
  if (roots.workspaceReason === 'forbidden') return { kind: 'unavailable', notice: 'files.denied' }
  return { kind: 'unavailable', notice: 'files.missing' }
}
