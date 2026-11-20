/**
 * Install the packed plugin with devDependencies omitted, then import the host entries.
 * A monorepo test run still sees devDependencies, so it does not catch this failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const entries = ['dist/index.js', 'dist/http-plugin.js', 'dist/router-plugin.js', 'dist/engine.js', 'dist/cli.js']

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0] ?? specifier
}

function bareSpecifiers(dir) {
  const specs = new Set()
  const from = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.js') || entry.name === 'canvas-inspector.js') continue
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const match of text.matchAll(from)) collect(match[1])
      for (const match of text.matchAll(dynamic)) collect(match[1])
    }
  }
  const collect = specifier => {
    if (
      specifier == null ||
      specifier.startsWith('.') ||
      specifier.startsWith('node:') ||
      specifier.startsWith('file:')
    )
      return
    specs.add(specifier)
  }
  walk(dir)
  return [...specs].sort()
}

function assertRuntimeImports(publishDir, dependencies) {
  const specs = bareSpecifiers(join(publishDir, 'dist'))
  if (specs.some(specifier => packageName(specifier) === 'esbuild')) {
    throw new Error('dist still imports esbuild; the inspector must be prebundled')
  }
  const missing = specs.filter(specifier => dependencies[packageName(specifier)] == null)
  if (missing.length > 0) {
    throw new Error(`dist imports packages that are not dependencies: ${missing.join(', ')}`)
  }
}

if (!existsSync(join(root, 'dist/index.js')) || !existsSync(join(root, 'dist/canvas-inspector.js'))) {
  console.error('run npm run build before verify:publish')
  process.exit(1)
}

const packDir = mkdtempSync(join(tmpdir(), 'dsh-bot-pack-'))
const stage = mkdtempSync(join(tmpdir(), 'dsh-bot-publish-'))
try {
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], root)
  const start = packed.stdout.indexOf('[')
  if (start < 0) throw new Error('npm pack did not return JSON')
  const filename = JSON.parse(packed.stdout.slice(start))[0]?.filename
  if (typeof filename !== 'string' || filename === '') throw new Error('npm pack did not return a filename')
  run('tar', ['-xzf', join(packDir, filename), '-C', stage], root)
  const publishDir = join(stage, 'package')
  const dependencies = JSON.parse(readFileSync(join(publishDir, 'package.json'), 'utf8')).dependencies ?? {}
  assertRuntimeImports(publishDir, dependencies)
  const inspector = readFileSync(join(publishDir, 'dist/canvas-inspector.js'), 'utf8')
  if (!inspector.includes('canvas-inspect'))
    throw new Error('packed inspector bundle is missing the canvas-inspect runtime')
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], publishDir)
  if (existsSync(join(publishDir, 'node_modules/esbuild'))) {
    throw new Error('esbuild was installed in the publish directory')
  }
  const hrefs = entries.map(entry => pathToFileURL(join(publishDir, entry)).href)
  const loader = `
const entries = ${JSON.stringify(hrefs)}
for (const entry of entries) {
  const loaded = await import(entry)
  if (typeof loaded.apply !== 'function' && !entry.endsWith('/engine.js') && !entry.endsWith('/cli.js')) {
    throw new Error(entry + ' did not export apply')
  }
  if (entry.endsWith('/cli.js') && typeof loaded.usage !== 'function') throw new Error(entry + ' did not export usage')
  if (entry.endsWith('/engine.js') && typeof loaded.createEngine !== 'function') {
    throw new Error(entry + ' did not export createEngine')
  }
}
console.log('publish directory activated ' + entries.length + ' entries')
`
  const env = { ...process.env }
  delete env.NODE_PATH
  const started = spawnSync(process.execPath, ['--input-type=module', '-e', loader], {
    cwd: publishDir,
    encoding: 'utf8',
    env,
  })
  if (started.stdout) process.stdout.write(started.stdout)
  if (started.status !== 0) {
    if (started.stderr) process.stderr.write(started.stderr)
    throw new Error('publish directory failed to activate')
  }
} finally {
  rmSync(packDir, { recursive: true, force: true })
  rmSync(stage, { recursive: true, force: true })
}
