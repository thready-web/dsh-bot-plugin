import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  english,
  readLocale,
  subscribeCopy,
  translate,
  writeLocale,
  type Copy,
  type Locale,
  type MessageKey,
} from './i18n/index.ts'

interface LocaleValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Copy
}

const LocaleContext = createContext<LocaleValue>({
  locale: 'en',
  setLocale: () => {},
  t: english,
})

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readLocale())
  const [copyRev, setCopyRev] = useState(0)
  const setLocale = useCallback((next: Locale) => {
    writeLocale(next)
    setLocaleState(next)
  }, [])
  useEffect(() => subscribeCopy(() => setCopyRev(rev => rev + 1)), [])
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars),
    [locale, copyRev],
  )
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useI18n(): LocaleValue {
  return useContext(LocaleContext)
}
