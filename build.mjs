import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = import.meta.dirname
const tsc = spawnSync('tsc', ['-p', 'tsconfig.json', '--pretty', 'false'], {
  cwd: root,
  stdio: 'inherit',
})
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
if (!existsSync(join(root, 'dist/index.js'))) {
  console.error('tsc did not write dist/index.js')
  process.exit(1)
}
const inspector = spawnSync(process.execPath, ['scripts/bundle-inspector.mjs'], {
  cwd: root,
  stdio: 'inherit',
})
if (inspector.status !== 0) process.exit(inspector.status ?? 1)
