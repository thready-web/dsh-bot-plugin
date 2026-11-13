import { useEffect, useState } from 'react'
import { explain, type Copy } from './i18n/index.ts'
import { useI18n } from './locale'
import type { HealthBody, ThreadState, UsageBody } from './types'

export function hostText(code: string, fallback: string, t: Copy): string {
  return explain(code, fallback, t)
}

export function HistoryLoading({
  active,
  progress,
}: {
  active: boolean
  progress: { loaded: number; total: number } | null
}) {
  const { t } = useI18n()
  const [mounted, setMounted] = useState(active)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (active) {
      setMounted(true)
      return
    }
    setVisible(false)
  }, [active])
  useEffect(() => {
    if (!mounted || !active) return
    const frame = window.requestAnimationFrame(() => setVisible(true))
    return () => window.cancelAnimationFrame(frame)
  }, [mounted, active])
  useEffect(() => {
    if (active || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), 280)
    return () => window.clearTimeout(timer)
  }, [active, mounted])
  if (!mounted) return null
  const known = progress != null && progress.total > 0
  const pct = known ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0
  return (
    <div className={visible ? 'chunk-loading visible' : 'chunk-loading'} role="status">
      <div className="chunk-loading-card">
        <p>
          <span className="shimmer">{known ? t('load.messagesPct', { pct: String(pct) }) : t('load.messages')}</span>
        </p>
        <div
          className="chunk-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={known ? progress.total : 1}
          aria-valuenow={known ? progress.loaded : 0}
          aria-label={t('load.aria')}
        >
          <div
            className={known ? 'chunk-progress-fill' : 'chunk-progress-fill indeterminate'}
            style={known ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>
    </div>
  )
}

export function BotDot({ signal }: { signal: 'run' | 'wait' | null }) {
  const { t } = useI18n()
  if (!signal) return null
  const waiting = signal === 'wait'
  return (
    <span
      className={waiting ? 'bot-dot wait' : 'bot-dot'}
      role="img"
      aria-label={waiting ? t('bot.waiting') : t('bot.running')}
    />
  )
}

export function statsLine(thread: ThreadState): string {
  const parts: string[] = []
  if (thread.turns != null) parts.push(`${thread.turns} turns`)
  if (thread.steps != null) parts.push(`${thread.steps} steps`)
  return parts.join(' · ')
}

export function Status({
  health,
  usage,
  execution,
  model,
}: {
  health: HealthBody | null
  usage: UsageBody | null
  execution: { ready: boolean; reason: string }
  model: string
}) {
  const { t } = useI18n()
  const up = health?.primary?.reachable === true
  const usageCode = usage && 'code' in usage && typeof usage.code === 'string' ? usage.code : ''
  return (
    <div className="status">
      <p>{up ? t('health.up') : t('health.down')}</p>
      {model ? <p className="muted">{model}</p> : null}
      <p className={execution.ready ? '' : 'muted'}>
        {execution.ready ? t('health.modelReady') : hostText(execution.reason, execution.reason, t)}
      </p>
      <p className={usage?.connected ? '' : 'muted'}>
        {usage?.connected ? t('health.usageReady') : hostText(usageCode, usage?.error || t('health.usageOff'), t)}
      </p>
      <p className="muted">{t('health.sameSession')}</p>
    </div>
  )
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16.5L20 20.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function PermissionIcon({ preset }: { preset: string }) {
  if (preset === 'read-only' || preset === 'readonly' || preset === 'danger-full-access' || preset === 'auto') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M6.6 2.15C7.5 1.81 8.5 1.81 9.4 2.15L13.92 3.84V7.12C13.92 11.61 10.56 13.6 8 14.58C5.44 13.6 2.08 11.61 2.08 7.12V3.84L6.6 2.15Z"
          fill="none"
          stroke="currentColor"
          strokeLinejoin="round"
        />
        {preset === 'danger-full-access' ? <path d="M8 4.4V9.9M8 10.8V11.8" fill="none" stroke="currentColor" /> : null}
        {preset === 'read-only' || preset === 'readonly' ? (
          <path
            d="M5.09 8.14L7.18 10.24C7.27 10.32 7.4 10.31 7.48 10.23L11.51 5.61"
            fill="none"
            stroke="currentColor"
          />
        ) : null}
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.42 1.68C7.44 1.3 8.56 1.3 9.58 1.68L14.1 3.38C14.29 3.45 14.42 3.63 14.42 3.84V6.49L9.23 2.62C8.44 2.32 7.56 2.32 6.77 2.62L2.58 4.19V7.12C2.58 11.18 5.52 13.06 8 14.04C8.28 13.93 8.56 13.81 8.84 13.67C9.07 13.95 9.33 14.19 9.62 14.41C9.12 14.66 8.64 14.87 8.18 15.04C8.06 15.09 7.94 15.09 7.82 15.04C5.22 14.05 1.58 11.94 1.58 7.12V3.84C1.58 3.63 1.7 3.45 1.9 3.38L6.42 1.68Z"
        fill="currentColor"
      />
      <path d="M5.26 6.6H10.74M5.26 9.87H8.33" fill="none" stroke="currentColor" />
      <path
        d="M10.03 13.22C12.15 11.95 14.58 8.9 14.78 8.64C14.41 8.37 13.68 7.83 13.5 8.1C12.4 9.72 11.31 11.34 10.21 12.95C10.15 13.04 10.09 13.13 10.03 13.22Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 17V7M7 11.5L12 6.5l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
