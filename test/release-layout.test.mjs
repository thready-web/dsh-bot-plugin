import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertReleaseLayout, buildManifest, walkSkillFiles } from '../scripts/release-layout.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function writeRelease(root, files) {
  mkdirSync(join(root, 'skills', 'ui'), { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  const manifest = buildManifest(root)
  writeFileSync(join(root, 'skills', 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', files: ['dist', 'skills'] }))
  return manifest
}

test('the committed manifest matches the skills tree and the package ships skills', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('skills'))
  const committed = JSON.parse(readFileSync(join(packageRoot, 'skills', 'release-manifest.json'), 'utf8'))
  const built = buildManifest(packageRoot)
  assert.deepEqual(committed, built)
  assert.ok(walkSkillFiles(packageRoot).some(file => file.path === 'skills/ui/ui-design/SKILL.md'))
  assert.ok(walkSkillFiles(packageRoot).some(file => file.path === 'skills/ui/sources.json'))
  assertReleaseLayout(packageRoot)
})

test('a release that drops skills or a helper fails before cutover', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  const files = {
    'skills/ui/ui-design/SKILL.md': '---\nname: ui-design\ndescription: Contract.\n---\n# Canvas\n',
    'skills/ui/better-ui/SKILL.md': '---\nname: better-ui\ndescription: Polish.\n---\n# Polish\n',
    'skills/ui/better-ui/surfaces.md': '# surfaces\n',
    'skills/ui/sources.json': '{"skills":[]}\n',
  }
  try {
    writeRelease(root, files)
    assertReleaseLayout(root)
    rmSync(join(root, 'skills', 'ui', 'better-ui', 'surfaces.md'))
    assert.throws(() => assertReleaseLayout(root), /skills\/ui\/better-ui\/surfaces.md/)
    assert.throws(() => assertReleaseLayout(root), /hand-written allowlist/)
    writeFileSync(join(root, 'skills', 'ui', 'better-ui', 'surfaces.md'), '# surfaces\n')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    pkg.files = ['dist']
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    assert.throws(() => assertReleaseLayout(root), /files must include "skills"/)
    pkg.files = ['dist', 'skills']
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    rmSync(join(root, 'skills'), { recursive: true, force: true })
    assert.throws(() => assertReleaseLayout(root), /skills\/ui\/ui-design\/SKILL.md/)
    assert.throws(() => assertReleaseLayout(root), /skills\/release-manifest.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
