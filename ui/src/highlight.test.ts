import assert from 'node:assert/strict'
import test from 'node:test'
import { isMarkdownName, monacoLanguage } from './highlight.ts'

test('monaco language ids follow the file extension', () => {
  assert.equal(monacoLanguage('serve-preview.mjs'), 'javascript')
  assert.equal(monacoLanguage('App.tsx'), 'typescript')
  assert.equal(monacoLanguage('README.md'), 'markdown')
  assert.equal(monacoLanguage('styles.css'), 'css')
  assert.equal(monacoLanguage('Makefile'), 'plaintext')
  assert.equal(isMarkdownName('README.md'), true)
  assert.equal(isMarkdownName('serve-preview.mjs'), false)
})
