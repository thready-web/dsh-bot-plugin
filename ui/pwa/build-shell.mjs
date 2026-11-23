/**
 * Build-time generator for the DSH Bot PWA shell.
 *
 * Runs after `vite build` and writes, into the Vite output (`plugins/dsh-bot-plugin/public`):
 *
 *   manifest.webmanifest  install metadata
 *   sw.js                 versioned service worker, built from sw.template.js + routes.js
 *   release.json          release id + hashed shell entry list
 *   icons/*.png           generated install icons
 *   favicon.svg           generated tab icon
 *
 * The precache list is the built `index.html` plus exactly the assets it references.
 * Nothing user-specific, no API, no lazy chunks: those stay network-only (P0 of
 * docs/pwa-instant-start.md). A release is atomic because install verifies every
 * entry's hash before the worker activates.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { faviconSvg, shellIcons } from './icons.mjs'

const BASE = '/dsh-bot/'
const SHELL_INDEX = '/dsh-bot/index.html'
const HASH_LENGTH = 16
/** Linked from the document but never precached; the worker fetches these from the network. */
const SHELL_METADATA = new Set(['/dsh-bot/manifest.webmanifest', '/dsh-bot/sw.js', '/dsh-bot/release.json'])

/**
 * Install metadata is injected here, not kept in `ui/index.html`: the Vite dev server
 * and the production build disagree about how to prefix root-relative `href` values,
 * and only the built document needs these URLs at all.
 */
const INSTALL_LINKS = [
  '    <link rel="manifest" href="/dsh-bot/manifest.webmanifest" />',
  '    <link rel="icon" href="/dsh-bot/favicon.svg" type="image/svg+xml" />',
  '    <link rel="apple-touch-icon" href="/dsh-bot/icons/apple-touch-icon-180.png" />',
].join('\n')

export function pwaShellPlugin() {
  let outDir = ''
  return {
    name: 'dsh-bot-pwa-shell',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const plan = await buildShell(outDir)
      console.log(`[pwa] shell ${plan.releaseId} · ${plan.entries.length} files precached`)
    },
  }
}

/** Absolute `/dsh-bot/` URLs referenced by the built document, in source order. */
export function shellEntryUrls(html) {
  const urls = new Set()
  const pattern = /<(?:script|link)\b[^>]*?(?:src|href)\s*=\s*"([^"]+)"/g
  for (const match of html.matchAll(pattern)) {
    const url = normalizeShellUrl(match[1])
    if (url) urls.add(url)
  }
  return [...urls]
}

function normalizeShellUrl(value) {
  let path
  try {
    path = new URL(value, 'http://shell.invalid/dsh-bot/').pathname
  } catch {
    return ''
  }
  if (!path.startsWith(BASE) || SHELL_METADATA.has(path)) return ''
  const rel = path.slice(BASE.length)
  if (rel === '' || rel.includes('..') || rel.includes('\0')) return ''
  return path
}

function fileForUrl(outDir, url) {
  const rel = url === BASE ? 'index.html' : url.slice(BASE.length)
  return join(outDir, ...rel.split('/'))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function releaseIdFor(entries) {
  const lines = entries
    .map(entry => `${entry.url} ${entry.hash}`)
    .sort()
    .join('\n')
  return sha256(Buffer.from(lines, 'utf8')).slice(0, HASH_LENGTH)
}

function manifestFor(entries) {
  const assets = new Set(entries.map(entry => entry.url))
  const icon = (path, size, purpose) => ({
    src: BASE + path,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  })
  const icons = [
    ...(assets.has('/dsh-bot/icons/icon-192.png') ? [icon('icons/icon-192.png', 192, 'any')] : []),
    ...(assets.has('/dsh-bot/icons/icon-512.png') ? [icon('icons/icon-512.png', 512, 'any')] : []),
    ...(assets.has('/dsh-bot/icons/icon-maskable-512.png')
      ? [icon('icons/icon-maskable-512.png', 512, 'maskable')]
      : []),
  ]
  return {
    id: BASE,
    name: 'DSH Bot',
    short_name: 'DSH Bot',
    description: 'The DSH Bot workbench: sessions, approvals, memory, and canvas.',
    lang: 'en',
    start_url: BASE,
    scope: BASE,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#e23d8a',
    categories: ['productivity', 'developer'],
    prefer_related_applications: false,
    icons,
  }
}

/**
 * Generate the shell into `outDir`. Exported for the build-check unit test.
 * @param {string} outDir Vite output directory
 * @param {{ builtAt?: string }} [options]
 */
/** Add the manifest and icon links once; the built document is what gets precached. */
export function injectInstallLinks(html) {
  if (html.includes('rel="manifest"')) return html
  return html.replace(/([ \t]*)<\/head>/, (_, indent) => `${INSTALL_LINKS}\n${indent}</head>`)
}

export async function buildShell(outDir, options = {}) {
  const indexPath = join(outDir, 'index.html')
  if (!existsSync(indexPath)) throw new Error(`[pwa] no built index.html at ${indexPath}`)
  const source = await readFile(indexPath, 'utf8')
  const html = injectInstallLinks(source)
  if (html !== source) await writeFile(indexPath, html)

  const icons = shellIcons()
  for (const icon of icons) {
    const target = join(outDir, ...icon.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, icon.png)
  }
  await writeFile(join(outDir, 'favicon.svg'), faviconSvg())

  const urls = [SHELL_INDEX, ...shellEntryUrls(html)]
  for (const icon of icons) urls.push(BASE + icon.path)
  urls.push(`${BASE}favicon.svg`)
  const unique = [...new Set(urls)]

  const entries = []
  for (const url of unique) {
    const file = fileForUrl(outDir, url)
    if (!existsSync(file)) throw new Error(`[pwa] precache entry missing: ${url} (${file})`)
    const bytes = await readFile(file)
    entries.push({ url, hash: sha256(bytes).slice(0, HASH_LENGTH), bytes: bytes.length })
  }

  const releaseId = releaseIdFor(entries)
  const manifest = manifestFor(entries)
  await writeFile(join(outDir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(outDir, 'release.json'),
    `${JSON.stringify(
      {
        releaseId,
        scope: BASE,
        startUrl: BASE,
        shell: SHELL_INDEX,
        builtAt: options.builtAt ?? new Date().toISOString(),
        entries,
      },
      null,
      2,
    )}\n`,
  )

  const [template, routes] = await Promise.all([
    readFile(join(import.meta.dirname, 'sw.template.js'), 'utf8'),
    readFile(join(import.meta.dirname, 'routes.js'), 'utf8'),
  ])
  const serviceWorker = template
    .split('__ROUTES__')
    .join(routes.trim())
    .split('__RELEASE_ID__')
    .join(releaseId)
    .split('__PRECACHE__')
    .join(
      JSON.stringify(
        entries.map(({ url, hash }) => ({ url, hash })),
        null,
        2,
      ),
    )
  await writeFile(join(outDir, 'sw.js'), serviceWorker)

  return { releaseId, entries, manifest }
}
