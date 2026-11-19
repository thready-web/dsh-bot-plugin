import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,64}$/
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ui')

export interface CanvasSkillFile {
  id: string
  version: string
  summary: string
  bytes: Buffer
}

/**
 * Bundled canvas skills. `ui-design` is this plugin's contract.
 * The other directories are a starter catalog from ui-skills.com.
 */
export function canvasSkillFiles(): CanvasSkillFile[] {
  const entries = readdirSync(ROOT, { withFileTypes: true })
  const skills: CanvasSkillFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue
    const bytes = readFileSync(join(ROOT, entry.name, 'SKILL.md'))
    const summary = skillSummary(bytes.toString('utf8'), entry.name)
    skills.push({
      id: entry.name,
      version: entry.name === 'ui-design' ? '1' : 'catalog',
      summary,
      bytes,
    })
  }
  skills.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return skills
}

export function bindCanvasSkills(
  engine: {
    registerSkill: (
      sessionId: string,
      scope: 'private' | 'public',
      skillId: string,
      version: string,
      summary: string,
      bytes: Buffer,
    ) => unknown
  },
  sessionId: string,
) {
  const bound: string[] = []
  const skipped: string[] = []
  for (const skill of canvasSkillFiles()) {
    try {
      engine.registerSkill(sessionId, 'public', skill.id, skill.version, skill.summary, skill.bytes)
      bound.push(skill.id)
    } catch {
      skipped.push(skill.id)
    }
  }
  return { bound, skipped }
}

function skillSummary(text: string, fallback: string) {
  const fence = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fence?.[1] ?? ''
  const line = block.match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? ''
  const description = unquote(line).replace(/\s+/g, ' ').trim()
  const summary = description || fallback
  return summary.slice(0, fallback === 'ui-design' ? 180 : 100)
}

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1)
  }
  return value
}
