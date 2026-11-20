import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outside = ['packages', 'dsh-canvas'].join('/')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'public') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) out.push(path)
  }
  return out
}

test('plugin sources do not import the standalone canvas demo', () => {
  const paths = ['package.json', 'build.mjs', 'client.js'].map(name => join(root, name))
  for (const dir of ['src', 'test', 'ui/src', 'scripts']) paths.push(...walk(join(root, dir)))
  const hits = paths.filter(path => readFileSync(path, 'utf8').includes(outside))
  assert.deepEqual(hits, [])
})
