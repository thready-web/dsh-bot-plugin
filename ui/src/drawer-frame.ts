import { useEffect, useLayoutEffect, useRef } from 'react'
import { closedPush, filePush } from './file-layout'

let owner: symbol | null = null

function applyPush(layout: { inset: number; insetRight: number; reserve: number; sidebar: number }) {
  const root = document.documentElement
  root.style.setProperty('--files-inset', `${layout.inset}px`)
  root.style.setProperty('--files-inset-right', `${layout.insetRight}px`)
  root.style.setProperty('--files-reserve', `${layout.reserve}px`)
  root.style.setProperty('--files-sidebar', `${layout.sidebar}px`)
}

function release(token: symbol) {
  if (owner !== token) return
  owner = null
  const root = document.documentElement
  root.classList.remove('files-push', 'files-closing', 'files-resizing')
  applyPush(closedPush(0))
}

/** Push the chat shell for whichever drawer is open. A closing drawer yields to the one opening. */
export function useDrawerFrame(options: {
  present: boolean
  narrow: boolean
  motion: 'in' | 'out'
  width: number
  resizing: boolean
  viewport: number
}) {
  const { present, narrow, motion, width, resizing, viewport } = options
  const token = useRef(Symbol('drawer'))
  const pushed = useRef(false)
  const presentRef = useRef(present)
  const motionRef = useRef(motion)
  presentRef.current = present
  motionRef.current = motion

  useLayoutEffect(() => {
    const root = document.documentElement
    const mine = token.current
    if (!present || narrow) {
      pushed.current = false
      release(mine)
      return
    }
    if (motion === 'out' && owner !== null && owner !== mine) {
      pushed.current = false
      return
    }
    owner = mine
    const target = motion === 'out' ? closedPush(viewport) : filePush(viewport, width)
    root.classList.add('files-push')
    root.classList.toggle('files-closing', motion === 'out')
    root.classList.toggle('files-resizing', resizing)
    if (!pushed.current && motion !== 'out') {
      pushed.current = true
      root.classList.add('files-resizing')
      applyPush(closedPush(viewport))
      let fired = false
      const frame = requestAnimationFrame(() => {
        fired = true
        if (owner !== mine) return
        root.classList.remove('files-resizing')
        if (!presentRef.current) return
        const next = motionRef.current === 'out' ? closedPush(window.innerWidth) : filePush(window.innerWidth, width)
        applyPush(next)
      })
      return () => {
        cancelAnimationFrame(frame)
        if (!fired) pushed.current = false
      }
    }
    pushed.current = true
    applyPush(target)
  }, [present, narrow, motion, width, resizing, viewport])

  useEffect(
    () => () => {
      pushed.current = false
      release(token.current)
    },
    [],
  )
}
