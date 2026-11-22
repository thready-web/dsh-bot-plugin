/**
 * The installed plugin must contain every file under skills/.
 * Deploy the npm pack (package.json "files"), not a hand-written allowlist.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = 'skills/release-manifest.json'
const PURPOSE =
  'Required skill files for an installed @thready-web/dsh-bot-plugin. Deploy the npm pack. Do not drop skills/ from a copy allowlist.'

export const SKILL_FLOOR = ['skills/ui/ui-design/SKILL.md', 'skills/ui/sources.json']

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fail(message) {
  const error = new Error(message)
  error.code = 'SKILLS_MISSING'
  return error
}

function allowedPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.startsWith('/')) return false
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return path.startsWith('skills/') && path !== MANIFEST_PATH
}

export function walkSkillFiles(packageRoot) {
  const skillsRoot = join(packageRoot, 'skills')
  if (!existsSync(skillsRoot)) {
    throw fail(
      `Release is missing skills/. Copy the npm pack contents. package.json "files" includes skills/. Do not assemble the release from a hand-written allowlist that omits skills/ or helper files beside SKILL.md.`,
    )
  }
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(packageRoot, full).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        throw fail(`Release skills path is a symlink and is not shipped: ${rel}`)
      }
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (rel === MANIFEST_PATH) continue
      files.push({ path: rel, sha256: sha256(readFileSync(full)) })
    }
  }
  walk(skillsRoot)
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return files
}

export function buildManifest(packageRoot) {
  return {
    version: 1,
    purpose: PURPOSE,
    files: walkSkillFiles(packageRoot),
  }
}

function readManifest(releaseRoot) {
  const manifestPath = join(releaseRoot, 'skills', 'release-manifest.json')
  if (!existsSync(manifestPath)) {
    throw fail(
      [
        'This release is missing bundled skill resources, so a bot installed from it cannot load them.',
        `Missing: ${MANIFEST_PATH}, ${SKILL_FLOOR.join(', ')}`,
        'Copy the npm pack contents. package.json "files" includes skills/. Do not assemble the release from a hand-written allowlist that omits skills/ or helper files beside SKILL.md.',
      ].join('\n'),
    )
  }
  const stat = lstatSync(manifestPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail(`Release skills manifest is not a regular file: ${MANIFEST_PATH}`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw fail(`Release skills manifest is not valid JSON: ${MANIFEST_PATH}`)
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
    throw fail(`Release skills manifest is not version 1: ${MANIFEST_PATH}`)
  }
  return manifest
}

export function assertReleaseLayout(releaseRoot) {
  const packagePath = join(releaseRoot, 'package.json')
  if (!existsSync(packagePath)) {
    throw fail(
      'This release has no package.json. Deploy the extracted npm pack, which carries package.json "files" and skills/.',
    )
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (!Array.isArray(pkg.files) || !pkg.files.includes('skills')) {
    throw fail(
      'package.json files must include "skills" so the published package ships bundled skills. Deploy the npm pack instead of a hand-written allowlist.',
    )
  }
  const manifest = readManifest(releaseRoot)
  const listed = new Map()
  for (const file of manifest.files) {
    if (!file || !allowedPath(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw fail(`Release skills manifest has a path that is not allowed: ${file?.path ?? ''}`)
    }
    listed.set(file.path, file.sha256)
  }
  const missing = []
  const mismatched = []
  for (const path of SKILL_FLOOR) {
    if (!listed.has(path)) missing.push(path)
  }
  for (const [path, expected] of listed) {
    const full = join(releaseRoot, ...path.split('/'))
    if (!existsSync(full)) {
      missing.push(path)
      continue
    }
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      missing.push(path)
      continue
    }
    if (sha256(readFileSync(full)) !== expected) mismatched.push(path)
  }
  if (missing.length === 0 && mismatched.length === 0) return
  throw fail(
    [
      'This release is missing bundled skill resources, so a bot installed from it cannot load them.',
      missing.length > 0 ? `Missing: ${missing.join(', ')}` : '',
      mismatched.length > 0 ? `Hash mismatch: ${mismatched.join(', ')}` : '',
      'Copy the npm pack contents. package.json "files" includes skills/. Do not assemble the release from a hand-written allowlist that omits skills/ or helper files beside SKILL.md.',
    ]
      .filter(line => line !== '')
      .join('\n'),
  )
}

function writeManifest(packageRoot) {
  const manifest = buildManifest(packageRoot)
  for (const path of SKILL_FLOOR) {
    if (!manifest.files.some(file => file.path === path)) {
      throw fail(`Source skills tree is missing ${path}`)
    }
  }
  const target = join(packageRoot, 'skills', 'release-manifest.json')
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
  return target
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--write') {
    const target = writeManifest(PACKAGE_ROOT)
    console.log(`wrote ${target}`)
    return
  }
  const checkAt = args[0] === '--check' ? resolve(args[1] ?? '.') : PACKAGE_ROOT
  assertReleaseLayout(checkAt)
  const manifest = JSON.parse(readFileSync(join(checkAt, 'skills', 'release-manifest.json'), 'utf8'))
  if (resolve(checkAt) === resolve(PACKAGE_ROOT)) {
    const built = buildManifest(PACKAGE_ROOT)
    if (JSON.stringify(manifest) !== JSON.stringify(built)) {
      throw fail(
        'skills/release-manifest.json does not match the skills tree. Run node scripts/release-layout.mjs --write',
      )
    }
  }
  console.log(`release layout includes ${manifest.files.length} skill files in ${checkAt}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
