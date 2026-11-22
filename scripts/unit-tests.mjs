import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function collect(dir) {
  const files = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collect(rel))
      continue
    }
    if ((entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs')) && !entry.name.includes('host')) {
      files.push(rel)
    }
  }
  return files
}

const files = [...collect('test'), ...collect('ui/src')].sort()
if (files.length === 0) {
  console.error('no unit tests found')
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
