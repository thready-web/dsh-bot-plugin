import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  FILES_HOME_ENV,
  MAX_TEXT_BYTES,
  listDirectory,
  openDownload,
  readFileText,
  resolveFileRoots,
  saveUploadFile,
  selectBrowserHome,
} from '../src/workspace-files.ts'

function layout() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-bot-files-'))
  const home = join(base, 'home')
  const dshHome = join(home, '.dsh-bot')
  const workspace = join(dshHome, 'workspace')
  const evil = join(base, 'home-evil')
  mkdirSync(join(workspace, 'sub'), { recursive: true })
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(home, 'note.txt'), 'hello home')
  writeFileSync(join(home, '.bashrc'), 'alias ll=ls')
  writeFileSync(join(dshHome, 'token'), 'secret')
  writeFileSync(join(workspace, 'readme.md'), '# work')
  writeFileSync(join(evil, 'secret.txt'), 'nope')
  symlinkSync(join(dshHome, 'token'), join(home, 'leak'))
  symlinkSync(join(home, 'note.txt'), join(workspace, 'jump'))
  symlinkSync(join(dshHome, 'token'), join(workspace, 'trap'))
  writeFileSync(join(home, '.upload-abc.tmp'), 'temp')
  const access = resolveFileRoots({ workspace, home, dshHome })
  return { base, home, dshHome, workspace, evil, access }
}

test('roots allow the workspace inside DSH_HOME and reject a workspace that contains it', () => {
  const dirs = layout()
  try {
    assert.equal(dirs.access.roots.workspaceReason, '')
    assert.equal(dirs.access.roots.workspace?.endsWith(`${join('.dsh-bot', 'workspace')}`), true)
    assert.equal(dirs.access.roots.home?.endsWith(`${join('home')}`) || dirs.access.roots.home?.endsWith('/home'), true)
    const overlap = resolveFileRoots({ workspace: dirs.home, home: dirs.home, dshHome: dirs.dshHome })
    assert.equal(overlap.roots.workspace, null)
    assert.equal(overlap.roots.workspaceReason, 'overlap')
    const same = resolveFileRoots({ workspace: dirs.dshHome, home: dirs.home, dshHome: dirs.dshHome })
    assert.equal(same.roots.workspace, null)
    assert.equal(same.roots.workspaceReason, 'overlap')
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('listing hides the runtime directory, symlink escapes, and upload temps', () => {
  const dirs = layout()
  try {
    const home = listDirectory(dirs.home, dirs.access)
    assert.equal(home.ok, true)
    if (!home.ok) return
    assert.deepEqual(
      home.value.items.map(item => item.name),
      ['.bashrc', 'note.txt'].sort((a, b) => a.localeCompare(b)),
    )
    const work = listDirectory(dirs.workspace, dirs.access)
    assert.equal(work.ok, true)
    if (!work.ok) return
    assert.equal(work.value.root, 'workspace')
    assert.deepEqual(
      work.value.items.map(item => item.name),
      ['sub', 'jump', 'readme.md'],
    )
    assert.equal(work.value.items[0]?.kind, 'dir')
    assert.equal(work.value.items.find(item => item.name === 'jump')?.kind, 'link')
    const outside = listDirectory(dirs.evil, dirs.access)
    assert.equal(outside.ok, false)
    if (outside.ok) return
    assert.equal(outside.error, 'denied')
    const token = listDirectory(dirs.dshHome, dirs.access)
    assert.equal(token.ok, false)
    if (token.ok) return
    assert.equal(token.error, 'denied')
    const sibling = readFileText(join(dirs.evil, 'secret.txt'), dirs.access)
    assert.equal(sibling.ok, false)
    const climbed = readFileText(join(dirs.workspace, '..', 'token'), dirs.access)
    assert.equal(climbed.ok, false)
    if (climbed.ok) return
    assert.equal(climbed.error, 'denied')
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('text preview, binary rejection, and download stay inside the allowed roots', async () => {
  const dirs = layout()
  try {
    const note = readFileText(join(dirs.home, 'note.txt'), dirs.access)
    assert.equal(note.ok, true)
    if (!note.ok) return
    assert.equal(note.value.text, 'hello home')
    assert.equal(note.value.eof, true)
    const jumped = readFileText(join(dirs.workspace, 'jump'), dirs.access)
    assert.equal(jumped.ok, true)
    if (!jumped.ok) return
    assert.equal(jumped.value.text, 'hello home')
    writeFileSync(join(dirs.workspace, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]))
    const binary = readFileText(join(dirs.workspace, 'bin.dat'), dirs.access)
    assert.equal(binary.ok, false)
    if (binary.ok) return
    assert.equal(binary.error, 'binary')
    const folder = readFileText(join(dirs.workspace, 'sub'), dirs.access)
    assert.equal(folder.ok, false)
    if (folder.ok) return
    assert.equal(folder.error, 'not_file')
    const downloaded = openDownload(join(dirs.workspace, 'readme.md'), dirs.access)
    assert.equal(downloaded.ok, true)
    if (!downloaded.ok) return
    const chunks: Buffer[] = []
    for await (const chunk of downloaded.value.stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString('utf8'), '# work')
    const blocked = openDownload(join(dirs.dshHome, 'token'), dirs.access)
    assert.equal(blocked.ok, false)
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('upload writes into the open directory and refuses escapes, links, and oversize bodies', async () => {
  const dirs = layout()
  try {
    const saved = await saveUploadFile(dirs.workspace, 'added.txt', Readable.from([Buffer.from('new')]), dirs.access, {
      overwrite: false,
      maxBytes: 8,
    })
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    assert.equal(readFileSync(saved.value.path, 'utf8'), 'new')
    const clash = await saveUploadFile(dirs.workspace, 'added.txt', Readable.from([Buffer.from('next')]), dirs.access, {
      overwrite: false,
      maxBytes: 8,
    })
    assert.equal(clash.ok, false)
    if (clash.ok) return
    assert.equal(clash.error, 'exists')
    const replaced = await saveUploadFile(
      dirs.workspace,
      'added.txt',
      Readable.from([Buffer.from('next')]),
      dirs.access,
      { overwrite: true, maxBytes: 8 },
    )
    assert.equal(replaced.ok, true)
    assert.equal(readFileSync(join(dirs.workspace, 'added.txt'), 'utf8'), 'next')
    const named = await saveUploadFile(dirs.workspace, '../token', Readable.from([Buffer.from('x')]), dirs.access, {
      overwrite: true,
      maxBytes: 8,
    })
    assert.equal(named.ok, false)
    if (named.ok) return
    assert.equal(named.error, 'bad_name')
    const runtime = await saveUploadFile(dirs.dshHome, 'token', Readable.from([Buffer.from('x')]), dirs.access, {
      overwrite: true,
      maxBytes: 8,
    })
    assert.equal(runtime.ok, false)
    if (runtime.ok) return
    assert.equal(runtime.error, 'denied')
    assert.equal(readFileSync(join(dirs.dshHome, 'token'), 'utf8'), 'secret')
    const linked = await saveUploadFile(dirs.workspace, 'trap', Readable.from([Buffer.from('x')]), dirs.access, {
      overwrite: true,
      maxBytes: 8,
    })
    assert.equal(linked.ok, false)
    if (linked.ok) return
    assert.equal(linked.error, 'denied')
    const bulky = await saveUploadFile(dirs.workspace, 'big.txt', Readable.from([Buffer.from('abcdef')]), dirs.access, {
      overwrite: false,
      maxBytes: 4,
    })
    assert.equal(bulky.ok, false)
    if (bulky.ok) return
    assert.equal(bulky.error, 'too_large')
    const listed = listDirectory(dirs.workspace, dirs.access)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.equal(
      listed.value.items.some(item => item.name.includes('.upload-')),
      false,
    )
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

function serviceLayout() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-bot-files-vps-'))
  const dshHome = join(base, 'data')
  const workspace = join(dshHome, 'workspace')
  const filesHome = join(base, 'files')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(filesHome, { recursive: true })
  writeFileSync(join(dshHome, 'token'), 'secret')
  writeFileSync(join(dshHome, 'persona.sqlite'), 'db')
  writeFileSync(join(workspace, 'readme.md'), '# work')
  writeFileSync(join(filesHome, 'note.txt'), 'hello files')
  symlinkSync(join(dshHome, 'token'), join(filesHome, 'leak'))
  symlinkSync('/etc/passwd', join(filesHome, 'passwd'))
  symlinkSync(dshHome, join(base, 'home-link'))
  symlinkSync(filesHome, join(base, 'files-link'))
  symlinkSync('/etc', join(base, 'etc-link'))
  return { base, dshHome, workspace, filesHome }
}

test('HOME equal to DSH_HOME is not browsable, and a workspace descendant stays open', () => {
  const dirs = serviceLayout()
  const saved = {
    HOME: process.env.HOME,
    DSH_HOME: process.env.DSH_HOME,
    [FILES_HOME_ENV]: process.env[FILES_HOME_ENV],
  }
  try {
    const selected = selectBrowserHome({ HOME: dirs.dshHome, DSH_HOME: dirs.dshHome }, undefined)
    assert.equal(selected, dirs.dshHome)
    const access = resolveFileRoots({ workspace: dirs.workspace, home: selected, dshHome: dirs.dshHome })
    assert.equal(access.roots.home, null)
    assert.equal(access.roots.homeReason, 'forbidden')
    assert.equal(access.roots.workspace, realpathSync(dirs.workspace))
    assert.equal(access.roots.workspaceReason, '')
    const work = listDirectory(dirs.workspace, access)
    assert.equal(work.ok, true)
    if (!work.ok) return
    assert.deepEqual(
      work.value.items.map(item => item.name),
      ['readme.md'],
    )
    assert.equal(listDirectory(dirs.dshHome, access).ok, false)
    assert.equal(readFileText(join(dirs.dshHome, 'token'), access).ok, false)
    assert.equal(readFileText(join(dirs.workspace, '..', 'token'), access).ok, false)
    assert.equal(listDirectory('/', access).ok, false)
    assert.equal(listDirectory('/etc', access).ok, false)
    assert.equal(process.env.HOME, saved.HOME)
    assert.equal(process.env.DSH_HOME, saved.DSH_HOME)
    assert.equal(process.env[FILES_HOME_ENV], saved[FILES_HOME_ENV])
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('an explicit home is used when HOME is DSH_HOME, and invalid config does not fall through', () => {
  const dirs = serviceLayout()
  try {
    const selected = selectBrowserHome(
      { HOME: dirs.dshHome, DSH_HOME: dirs.dshHome, [FILES_HOME_ENV]: dirs.filesHome },
      undefined,
    )
    assert.equal(selected, dirs.filesHome)
    const configured = selectBrowserHome(
      { HOME: dirs.dshHome, [FILES_HOME_ENV]: join(dirs.base, 'other') },
      ` ${dirs.filesHome} `,
    )
    assert.equal(configured, dirs.filesHome)
    assert.equal(selectBrowserHome({ HOME: dirs.dshHome, [FILES_HOME_ENV]: dirs.filesHome }, '  '), dirs.filesHome)
    const invalid = selectBrowserHome({ HOME: dirs.dshHome, [FILES_HOME_ENV]: dirs.filesHome }, '/etc')
    assert.equal(invalid, '/etc')
    const typed = selectBrowserHome({ HOME: dirs.dshHome, [FILES_HOME_ENV]: dirs.filesHome }, 12)
    assert.equal(typed, '')
    const access = resolveFileRoots({ workspace: dirs.workspace, home: dirs.filesHome, dshHome: dirs.dshHome })
    assert.equal(access.roots.home, realpathSync(dirs.filesHome))
    assert.equal(access.roots.homeReason, '')
    const listed = listDirectory(dirs.filesHome, access)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.deepEqual(
      listed.value.items.map(item => item.name),
      ['note.txt'],
    )
    assert.equal(readFileText(join(dirs.filesHome, 'leak'), access).ok, false)
    assert.equal(readFileText(join(dirs.filesHome, 'passwd'), access).ok, false)
    const forbidden = resolveFileRoots({ workspace: dirs.workspace, home: invalid, dshHome: dirs.dshHome })
    assert.equal(forbidden.roots.home, null)
    assert.equal(forbidden.roots.homeReason, 'forbidden')
    const missing = resolveFileRoots({ workspace: dirs.workspace, home: typed, dshHome: dirs.dshHome })
    assert.equal(missing.roots.home, null)
    assert.equal(missing.roots.homeReason, 'missing')
    const nested = join(dirs.dshHome, 'files')
    mkdirSync(nested)
    const insideHome = resolveFileRoots({ workspace: dirs.workspace, home: nested, dshHome: dirs.dshHome })
    assert.equal(insideHome.roots.home, null)
    assert.equal(insideHome.roots.homeReason, 'forbidden')
    writeFileSync(join(dirs.base, 'not-a-dir'), 'x')
    const fileHome = resolveFileRoots({
      workspace: dirs.workspace,
      home: join(dirs.base, 'not-a-dir'),
      dshHome: dirs.dshHome,
    })
    assert.equal(fileHome.roots.home, null)
    assert.equal(fileHome.roots.homeReason, 'invalid')
    const linked = resolveFileRoots({
      workspace: dirs.workspace,
      home: join(dirs.base, 'files-link'),
      dshHome: dirs.dshHome,
    })
    assert.equal(linked.roots.home, realpathSync(dirs.filesHome))
    const runtimeLink = resolveFileRoots({
      workspace: dirs.workspace,
      home: join(dirs.base, 'home-link'),
      dshHome: dirs.dshHome,
    })
    assert.equal(runtimeLink.roots.home, null)
    assert.equal(runtimeLink.roots.homeReason, 'forbidden')
    const etcLink = resolveFileRoots({
      workspace: dirs.workspace,
      home: join(dirs.base, 'etc-link'),
      dshHome: dirs.dshHome,
    })
    assert.equal(etcLink.roots.home, null)
    assert.equal(etcLink.roots.homeReason, 'forbidden')
    const root = resolveFileRoots({ workspace: dirs.workspace, home: '/', dshHome: dirs.dshHome })
    assert.equal(root.roots.home, null)
    assert.equal(root.roots.homeReason, 'forbidden')
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('a legacy cwd of exactly DSH_HOME uses the safe workspace and other overlaps stay closed', () => {
  const dirs = serviceLayout()
  try {
    symlinkSync('/etc', join(dirs.base, 'legacy-etc'))
    symlinkSync(dirs.dshHome, join(dirs.base, 'legacy-runtime'))
    const legacy = resolveFileRoots({
      workspace: dirs.dshHome,
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.workspace,
    })
    assert.equal(legacy.roots.workspace, realpathSync(dirs.workspace))
    assert.equal(legacy.roots.workspaceReason, '')
    assert.equal(readFileText(join(dirs.workspace, 'readme.md'), legacy).ok, true)
    assert.equal(readFileText(join(dirs.dshHome, 'token'), legacy).ok, false)
    const viaLink = resolveFileRoots({
      workspace: join(dirs.base, 'legacy-runtime'),
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.workspace,
    })
    assert.equal(viaLink.roots.workspace, realpathSync(dirs.workspace))
    const parent = resolveFileRoots({
      workspace: dirs.base,
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.workspace,
    })
    assert.equal(parent.roots.workspace, null)
    assert.equal(parent.roots.workspaceReason, 'overlap')
    const filesystem = resolveFileRoots({
      workspace: '/',
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.workspace,
    })
    assert.equal(filesystem.roots.workspace, null)
    assert.equal(filesystem.roots.workspaceReason, 'forbidden')
    const etc = resolveFileRoots({
      workspace: '/etc',
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.workspace,
    })
    assert.equal(etc.roots.workspace, null)
    assert.equal(etc.roots.workspaceReason, 'forbidden')
    const badFallback = resolveFileRoots({
      workspace: dirs.dshHome,
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: join(dirs.base, 'legacy-etc'),
    })
    assert.equal(badFallback.roots.workspace, null)
    assert.equal(badFallback.roots.workspaceReason, 'overlap')
    const sameFallback = resolveFileRoots({
      workspace: dirs.dshHome,
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.dshHome,
    })
    assert.equal(sameFallback.roots.workspace, null)
    assert.equal(sameFallback.roots.workspaceReason, 'overlap')
    const kept = resolveFileRoots({
      workspace: dirs.workspace,
      home: dirs.filesHome,
      dshHome: dirs.dshHome,
      legacyWorkspace: dirs.filesHome,
    })
    assert.equal(kept.roots.workspace, realpathSync(dirs.workspace))
    assert.notEqual(kept.roots.workspace, realpathSync(dirs.filesHome))
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})

test('a text file past the preview cap reports eof', () => {
  const dirs = layout()
  try {
    writeFileSync(join(dirs.workspace, 'long.txt'), `${'a'.repeat(MAX_TEXT_BYTES)}tail`)
    const text = readFileText(join(dirs.workspace, 'long.txt'), dirs.access)
    assert.equal(text.ok, true)
    if (!text.ok) return
    assert.equal(text.value.eof, false)
    assert.equal(text.value.text.length, MAX_TEXT_BYTES)
    assert.equal(text.value.text.endsWith('tail'), false)
  } finally {
    rmSync(dirs.base, { recursive: true, force: true })
  }
})
