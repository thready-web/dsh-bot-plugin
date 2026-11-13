import { strict as assert } from 'node:assert'
import test from 'node:test'
import { english, translate, type Copy } from './i18n/index.ts'
import { presetDisplayName, presetLabel } from './permission-label.ts'

const zh: Copy = (key, vars) => translate('zh', key, vars)

test('presetLabel maps official ids to the composer chip copy', () => {
  assert.equal(presetLabel('workspace-write', english), 'Workspace Write')
  assert.equal(presetLabel('read-only', english), 'Read Only')
  assert.equal(presetLabel('readonly', english), 'Read Only')
  assert.equal(presetLabel('danger-full-access', english), 'Full access')
  assert.equal(presetLabel('auto', english), 'Auto review')
  assert.equal(presetLabel('custom', english), 'custom')
  assert.equal(presetLabel('workspace-write', zh), '工作区可写')
  assert.equal(presetLabel('read-only', zh), '只读')
  assert.equal(presetLabel('danger-full-access', zh), '完全访问')
  assert.equal(presetLabel('auto', zh), '自动审阅')
})

test('presetDisplayName prefers i18n labels over raw official names', () => {
  assert.equal(presetDisplayName('read-only', 'read-only', english), 'Read Only')
  assert.equal(presetDisplayName('workspace-write', 'workspace-write', english), 'Workspace Write')
  assert.equal(presetDisplayName('unknown-preset', 'Friendly official', english), 'Friendly official')
  assert.equal(presetDisplayName('unknown-preset', '', english), 'unknown-preset')
})
