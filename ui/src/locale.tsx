import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { english, readLocale, translate, writeLocale, type Copy, type Locale, type MessageKey } from './i18n/index.ts'

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
  const setLocale = useCallback((next: Locale) => {
    writeLocale(next)
    setLocaleState(next)
  }, [])
  const t = useCallback((key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars), [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useI18n(): LocaleValue {
  return useContext(LocaleContext)
}
