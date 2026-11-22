import { lstatSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readContained, sha256 } from './fs-safe.ts'

const TEXT_HELPER = new Set(['.md', '.txt', '.json'])
const MANIFEST = 'skills/release-manifest.json'
const REQUIRED = ['skills/ui/ui-design/SKILL.md', 'skills/ui/sources.json']

export interface CanvasSkillFile {
  id: string
  version: string
  summary: string
  bytes: Buffer
  helpers: string[]
}

interface ManifestFile {
  path: string
  sha256: string
}

interface SkillManifest {
  version: number
  files: ManifestFile[]
}

/**
 * Bundled canvas skills are missing or do not match the files in this install.
 * Dispatch uses this to refuse before inserting a canvas row.
 */
export class CanvasSkillsError extends Error {
  readonly code = 'SKILLS_MISSING'
  readonly missing: string[]

  constructor(missing: string[], root: string, detail?: string) {
    const list = missing.length > 0 ? missing.join(', ') : 'skills/ui'
    super(
      detail ??
        `Bundled canvas skills are missing or do not match this install (${list}). Looked in ${root}. foundations_dispatch_canvas will not open a canvas until the release includes them. Install the npm pack (package.json "files" includes skills). Skills load from this install only, not from a monorepo checkout, staging tree, or profile.`,
    )
    this.name = 'CanvasSkillsError'
    this.missing = missing.length > 0 ? missing : ['skills/ui']
  }
}

let cache: { root: string; skills: CanvasSkillFile[] } | null = null

/**
 * Package-relative skills/ui next to dist/ or src/. Not a profile, staging tree, or monorepo path.
 */
export function bundledCanvasSkillsRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ui')
}

/**
 * Bundled canvas skills. `ui-design` is this plugin's contract.
 * The other directories are the vendored catalog snapshots. Text files beside a
 * SKILL.md are appended so foundations_skill_load returns them with the skill.
 */
export function canvasSkillFiles(uiRoot = bundledCanvasSkillsRoot()): CanvasSkillFile[] {
  if (cache?.root === uiRoot) return cache.skills
  const skills = loadCanvasSkillFiles(uiRoot)
  cache = { root: uiRoot, skills }
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
  uiRoot = bundledCanvasSkillsRoot(),
) {
  const bound: string[] = []
  const preregistered: string[] = []
  for (const skill of canvasSkillFiles(uiRoot)) {
    try {
      engine.registerSkill(sessionId, 'public', skill.id, skill.version, skill.summary, skill.bytes)
      bound.push(skill.id)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'FORBIDDEN') {
        preregistered.push(skill.id)
        continue
      }
      throw new CanvasSkillsError(
        [`skills/ui/${skill.id}/SKILL.md`],
        dirname(uiRoot),
        `Bundled skill ${skill.id} is in this install but could not be bound${code ? ` (${code})` : ''}. foundations_dispatch_canvas will not open a canvas.`,
      )
    }
  }
  if (!bound.includes('ui-design') && !preregistered.includes('ui-design')) {
    throw new CanvasSkillsError(['skills/ui/ui-design/SKILL.md'], dirname(uiRoot))
  }
  return { bound, preregistered }
}

function loadCanvasSkillFiles(uiRoot: string) {
  const packageRoot = dirname(dirname(uiRoot))
  const manifest = readManifest(packageRoot)
  const problems: string[] = []
  const listed = new Map<string, string>()
  for (const file of manifest.files) {
    if (!allowedPath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      problems.push(file.path || MANIFEST)
      continue
    }
    listed.set(file.path, file.sha256)
  }
  for (const path of REQUIRED) {
    if (!listed.has(path)) problems.push(path)
  }
  const bytes = new Map<string, Buffer>()
  for (const [path, expected] of listed) {
    try {
      const body = readContained(packageRoot, join(packageRoot, ...path.split('/')))
      if (sha256(body) !== expected) problems.push(path)
      else bytes.set(path, body)
    } catch {
      problems.push(path)
    }
  }
  if (problems.length > 0) throw new CanvasSkillsError([...new Set(problems)], packageRoot)

  const ids = [...listed.keys()]
    .map(path => /^skills\/ui\/([a-z0-9][a-z0-9-]{0,64})\/SKILL\.md$/.exec(path)?.[1] ?? '')
    .filter(id => id !== '')
    .sort()
  if (!ids.includes('ui-design')) throw new CanvasSkillsError(['skills/ui/ui-design/SKILL.md'], packageRoot)

  const skills: CanvasSkillFile[] = []
  for (const id of ids) {
    const skillPath = `skills/ui/${id}/SKILL.md`
    const skillBytes = bytes.get(skillPath)
    if (!skillBytes) throw new CanvasSkillsError([skillPath], packageRoot)
    const helpers = [...listed.keys()].filter(path => path.startsWith(`skills/ui/${id}/`) && path !== skillPath).sort()
    skills.push({
      id,
      version: id === 'ui-design' ? '1' : 'catalog',
      summary: skillSummary(skillBytes.toString('utf8'), id),
      bytes: composeSkill(id, skillBytes, helpers, bytes),
      helpers: helpers.map(path => path.slice(`skills/ui/${id}/`.length)),
    })
  }
  return skills
}

function readManifest(packageRoot: string): SkillManifest {
  const manifestPath = join(packageRoot, 'skills', 'release-manifest.json')
  try {
    const stat = lstatSync(manifestPath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CanvasSkillsError([MANIFEST, ...REQUIRED], packageRoot)
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as SkillManifest
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
      throw new CanvasSkillsError([MANIFEST, ...REQUIRED], packageRoot)
    }
    return parsed
  } catch (error) {
    if (error instanceof CanvasSkillsError) throw error
    throw new CanvasSkillsError([MANIFEST, ...REQUIRED], packageRoot)
  }
}

function composeSkill(id: string, skillBytes: Buffer, helpers: string[], bytes: Map<string, Buffer>) {
  const textHelpers = helpers.filter(path => TEXT_HELPER.has(extname(path)))
  if (textHelpers.length === 0) return skillBytes
  const chunks = [skillBytes]
  for (const path of textHelpers) {
    const name = path.slice(`skills/ui/${id}/`.length)
    const helper = bytes.get(path)
    if (!helper) continue
    chunks.push(Buffer.from(`\n\n# ${name}\n\n`, 'utf8'), helper)
  }
  return Buffer.concat(chunks)
}

function allowedPath(path: string) {
  if (path === '' || path.includes('\\') || path.startsWith('/')) return false
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return path.startsWith('skills/') && path !== MANIFEST
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
