import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  MAX_TEXT_BYTES,
  listDirectory,
  openDownload,
  readFileText,
  resolveFileRoots,
  saveUploadFile,
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
