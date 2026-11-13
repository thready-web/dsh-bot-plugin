/** Present official ask_user_question calls as a transcript card, not a generic tool row. */
import { argsOf } from './activity.ts'
import type { ToolSegment } from './types.ts'

export const USER_QUESTION_TOOL = 'ask_user_question'

export function isUserQuestionTool(name: string) {
  return name.replace(/-/g, '_').toLowerCase() === USER_QUESTION_TOOL
}

export type UserQuestionOption = {
  label: string
  description: string
  recommended: boolean
}

export type PlanReviewIntent = {
  kind: 'plan-review'
  approve: string
  callId?: string
}

export type ApprovalIntent = {
  kind: 'approval'
  approve: string
  reject: string
  always?: string
  subject?: { name: string; icon?: string }
  display?: {
    question: { en: string; [locale: string]: string }
    detail?: { en: string; [locale: string]: string }
    approve?: { en: string; [locale: string]: string }
  }
}

export type UserQuestionIntent = PlanReviewIntent | ApprovalIntent

export type UserQuestionItem = {
  id: string
  question: string
  detail: string
  header: string
  options: UserQuestionOption[]
  multiSelect: boolean
  selected: string[]
  custom: string
  skipped: boolean
  intent?: UserQuestionIntent
}

export type UserQuestionState = 'open' | 'continued' | 'answered' | 'aborted' | 'failed'

export type UserQuestionWait = 'none' | 'counting' | 'waiting' | 'continued'

export type UserQuestionView = {
  callId: string
  state: UserQuestionState
  wait: UserQuestionWait
  timeoutMs?: number
  title: string
  questions: UserQuestionItem[]
  presentation: 'question' | 'plan-review' | 'approval'
}

export function optionPresentation(label: string, recommended = false) {
  const match = label.match(/^(.*?)\s*[\(（]\s*(Recommended|推荐|建議)\s*[\)）]\s*$/i)
  return {
    label,
    displayLabel: match?.[1]?.trim() ? match[1].trim() : label,
    recommended: recommended || Boolean(match),
  }
}

export function localizedText(
  value: { en: string; [locale: string]: string } | undefined,
  locale: string,
  fallback = '',
) {
  if (!value) return fallback
  if (locale.startsWith('zh') && typeof value.zh === 'string' && value.zh !== '') return value.zh
  if (typeof value[locale] === 'string' && value[locale] !== '') return value[locale]
  return value.en || fallback
}

function parseIntent(value: unknown): UserQuestionIntent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (row.kind === 'plan-review' && typeof row.approve === 'string') {
    const intent: PlanReviewIntent = { kind: 'plan-review', approve: row.approve }
    if (typeof row.callId === 'string' && row.callId !== '') intent.callId = row.callId
    return intent
  }
  if (row.kind === 'approval' && typeof row.approve === 'string' && typeof row.reject === 'string') {
    const intent: ApprovalIntent = { kind: 'approval', approve: row.approve, reject: row.reject }
    if (typeof row.always === 'string' && row.always !== '') intent.always = row.always
    if (row.subject && typeof row.subject === 'object') {
      const subject = row.subject as Record<string, unknown>
      if (typeof subject.name === 'string' && subject.name !== '') {
        intent.subject = { name: subject.name }
        if (typeof subject.icon === 'string' && subject.icon !== '') intent.subject.icon = subject.icon
      }
    }
    if (row.display && typeof row.display === 'object') {
      const display = row.display as Record<string, unknown>
      const question = localizedMap(display.question)
      if (question) {
        intent.display = { question }
        const detail = localizedMap(display.detail)
        if (detail) intent.display.detail = detail
        const approve = localizedMap(display.approve)
        if (approve) intent.display.approve = approve
      }
    }
    return intent
  }
  return undefined
}

function localizedMap(value: unknown): { en: string; [locale: string]: string } | undefined {
  if (!value || typeof value !== 'object' || typeof (value as { en?: unknown }).en !== 'string') return undefined
  const result: { en: string; [locale: string]: string } = { en: (value as { en: string }).en }
  for (const [locale, message] of Object.entries(value)) {
    if (typeof message === 'string') result[locale] = message
  }
  return result
}

export function planReviewOf(questions: readonly UserQuestionItem[]) {
  const item = questions[0]
  if (!item || questions.length !== 1 || item.multiSelect || item.intent?.kind !== 'plan-review') return undefined
  const approve = item.options.find(option => option.label === item.intent?.approve)
  if (!approve) return undefined
  const decline = item.options.find(option => option.label !== approve.label)
  if (item.options.length > 2) return undefined
  return { item, approve, decline, plan: item.detail }
}

export function approvalIntentOf(questions: readonly UserQuestionItem[]) {
  const item = questions[0]
  if (!item || questions.length !== 1 || item.multiSelect || item.intent?.kind !== 'approval') return undefined
  const intent = item.intent
  const approve = item.options.find(option => option.label === intent.approve)
  const reject = item.options.find(option => option.label === intent.reject)
  if (!approve || !reject) return undefined
  const always = intent.always ? item.options.find(option => option.label === intent.always) : undefined
  return { item, intent, approve, reject, always }
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseOptions(value: unknown): UserQuestionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.label !== 'string') return []
    return [
      {
        label: row.label,
        description: rawString(row.description),
        recommended: row.recommended === true,
      },
    ]
  })
}

function parseQuestions(value: unknown): Array<Omit<UserQuestionItem, 'selected' | 'custom' | 'skipped'>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const question = rawString(row.question)
    if (!question) return []
    const id = rawString(row.id)
    return [
      {
        id: id === '' ? `question-${index + 1}` : id,
        question,
        detail: rawString(row.detail),
        header: rawString(row.header),
        options: parseOptions(row.options),
        multiSelect: row.multi_select === true || row.multiSelect === true,
        intent: parseIntent(row.intent),
      },
    ]
  })
}

function parseAnswers(raw: string): Map<string, { selected: string[]; custom: string }> {
  const map = new Map<string, { selected: string[]; custom: string }>()
  const parsed = argsOf(raw)
  const answers = Array.isArray(parsed.answers) ? parsed.answers : Array.isArray(parsed) ? parsed : []
  for (const item of answers) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = rawString(row.id)
    if (!id) continue
    const selected = Array.isArray(row.selected)
      ? row.selected.flatMap(value => (typeof value === 'string' ? [value] : []))
      : []
    map.set(id, { selected, custom: rawString(row.custom) })
  }
  return map
}

function isAborted(tool: ToolSegment) {
  const code = tool.errorCode ?? ''
  return /ASK_ABORTED|ABORT|CANCEL/i.test(code) || /aborted before the user answered/i.test(tool.result)
}

function isPendingResult(raw: string) {
  if (!raw) return false
  const parsed = argsOf(raw)
  return Boolean(parsed && parsed.pending === true)
}

function isSettled(tool: ToolSegment) {
  if (isPendingResult(tool.result)) return false
  return Boolean(tool.resultReceived || tool.result !== '' || tool.error || tool.errorCode)
}

function timeoutMsOf(args: Record<string, unknown>) {
  const timeout = args.timeout
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return undefined
  return timeout > 1000 ? timeout : timeout * 1000
}

export function userQuestionView(tool: ToolSegment): UserQuestionView | null {
  if (!isUserQuestionTool(tool.name)) return null
  const args = argsOf(tool.args)
  const questions = parseQuestions(args.questions)
  const answers = parseAnswers(tool.result)
  const aborted = isAborted(tool)
  const pending = isPendingResult(tool.result)
  const settled = isSettled(tool)
  const failed = settled && tool.error && !aborted
  const state: UserQuestionState = pending
    ? 'continued'
    : !settled
      ? 'open'
      : aborted
        ? 'aborted'
        : failed
          ? 'failed'
          : 'answered'
  const timeoutMs = timeoutMsOf(args)
  const wait: UserQuestionWait = pending ? 'continued' : state === 'open' && timeoutMs ? 'counting' : 'none'
  const items = questions.map(question => {
    const answer = answers.get(question.id)
    const selected = answer?.selected ?? []
    const custom = answer?.custom ?? ''
    return {
      ...question,
      selected,
      custom,
      skipped: state === 'answered' && selected.length === 0 && !custom,
    }
  })
  const title = items.find(item => item.header)?.header || items[0]?.question || tool.name
  const presentation = planReviewOf(items) ? 'plan-review' : approvalIntentOf(items) ? 'approval' : 'question'
  return { callId: tool.callId, state, wait, timeoutMs, title, questions: items, presentation }
}

export function isAnswerableQuestion(state: UserQuestionState) {
  return state === 'open' || state === 'continued'
}
