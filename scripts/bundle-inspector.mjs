import { mkdirSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../dist/canvas-inspector.js', import.meta.url))
mkdirSync(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true })
buildSync({
  absWorkingDir: fileURLToPath(new URL('../ui/', import.meta.url)),
  entryPoints: [fileURLToPath(new URL('../ui/src/canvas-inspector.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: out,
  minify: false,
  logLevel: 'silent',
})
