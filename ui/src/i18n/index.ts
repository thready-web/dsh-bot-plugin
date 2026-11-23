/// <reference types="vite/client" />
import { activity } from './activity.ts'
import { bot } from './bot.ts'
import { chrome } from './chrome.ts'
import { composer } from './composer.ts'
import { session } from './session.ts'
import { question } from './question.ts'
import { approval } from './approval.ts'
import { permission } from './permission.ts'
import { authorization } from './authorization.ts'
import { cua } from './cua.ts'
import { work } from './work.ts'
import { image } from './image.ts'
import { memory } from './memory.ts'
import { canvas } from './canvas.ts'
import { snapshot } from './snapshot.ts'
import { pwa } from './pwa.ts'

export type Locale = 'en' | 'zh'

const en = {
  ...session.en,
  ...chrome.en,
  ...composer.en,
  ...bot.en,
  ...work.en,
  ...activity.en,
  ...question.en,
  ...approval.en,
  ...permission.en,
  ...authorization.en,
  ...cua.en,
  ...image.en,
  ...memory.en,
  ...canvas.en,
  ...snapshot.en,
  ...pwa.en,
} as const

const zh: Record<keyof typeof en, string> = {
  ...session.zh,
  ...chrome.zh,
  ...composer.zh,
  ...bot.zh,
  ...work.zh,
  ...activity.zh,
  ...question.zh,
  ...approval.zh,
  ...permission.zh,
  ...authorization.zh,
  ...cua.zh,
  ...image.zh,
  ...memory.zh,
  ...canvas.zh,
  ...snapshot.zh,
  ...pwa.zh,
}

export type MessageKey = keyof typeof en

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, zh }

type CatalogPiece = { en: Record<string, string>; zh: Record<string, string> }
const copyListeners = new Set<() => void>()

function catalogPiece(mod: object): CatalogPiece | null {
  for (const value of Object.values(mod)) {
    if (!value || typeof value !== 'object') continue
    const record = value as { en?: unknown; zh?: unknown }
    if (record.en && typeof record.en === 'object' && record.zh && typeof record.zh === 'object') {
      return { en: record.en as Record<string, string>, zh: record.zh as Record<string, string> }
    }
  }
  return null
}

function applyCatalog(piece: CatalogPiece) {
  Object.assign(catalogs.en, piece.en)
  Object.assign(catalogs.zh, piece.zh)
  for (const listener of copyListeners) listener()
}

/** Re-render after a catalog file is swapped in place. */
export function subscribeCopy(listener: () => void) {
  copyListeners.add(listener)
  return () => {
    copyListeners.delete(listener)
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(
    [
      './activity.ts',
      './approval.ts',
      './authorization.ts',
      './bot.ts',
      './canvas.ts',
      './chrome.ts',
      './composer.ts',
      './cua.ts',
      './image.ts',
      './memory.ts',
      './permission.ts',
      './question.ts',
      './session.ts',
      './work.ts',
      './pwa.ts',
    ],
    modules => {
      for (const mod of modules) {
        const piece = mod ? catalogPiece(mod) : null
        if (piece) applyCatalog(piece)
      }
    },
  )
}

const STORAGE = 'dsh-bot.locale'

export type Copy = (key: MessageKey, vars?: Record<string, string>) => string

export function readLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    /* private mode */
  }
  return 'en'
}

export function writeLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE, locale)
  } catch {
    /* private mode */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string>): string {
  const template = catalogs[locale][key] ?? catalogs.en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}

export function english(key: MessageKey, vars?: Record<string, string>): string {
  return translate('en', key, vars)
}

const CODE_KEYS: Record<string, MessageKey> = {
  loading: 'health.loading',
  no_provider: 'health.noProvider',
  catalog_unreadable: 'health.catalogUnreadable',
  primary_unready: 'health.primaryUnready',
  primary_down: 'health.primaryDown',
  usage_not_installed: 'health.usageMissing',
  usage_unconfigured: 'health.usageUpstream',
  session_unreadable: 'health.sessionUnreadable',
}

/** Known host codes use the active catalog. Anything else stays as the English server text. */
export function explain(code: string, fallback: string, t: Copy = english): string {
  const key = CODE_KEYS[code]
  return key ? t(key) : fallback
}
