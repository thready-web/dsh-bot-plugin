import { strict as assert } from 'node:assert'
import test from 'node:test'
import { permissionView, setPermission } from '../src/permissions.ts'

test('permissionView hides the control when the official service is absent', () => {
  const view = permissionView({ get: () => undefined }, 'sess-bot')
  assert.equal(view.available, false)
  assert.equal(view.autoAvailable, false)
  assert.deepEqual(view.options, [])
})

test('permissionView exposes catalog options and only reports Auto when the catalog includes it', () => {
  const sessions = new Map([['sess-bot', { id: 'sess-bot' }]])
  const service = {
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only', description: 'Read files.' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
        { value: 'auto', name: 'Auto' },
      ],
      defaultOptions: [{ value: 'workspace-write', name: 'Workspace write' }],
      defaultPreset: 'workspace-write',
    }),
    current: () => 'workspace-write',
    set(session: { id: string }, name: string) {
      this.current = () => name
      this.session = session
    },
    session: null as { id: string } | null,
  }
  const ctx = {
    get: (name: string) =>
      name === 'permissionPresets'
        ? service
        : name === 'sessions'
          ? { get: (id: string) => sessions.get(id) }
          : undefined,
    agents: { get: (id: string) => (id === 'sess-bot' ? { session: sessions.get(id) } : undefined) },
  }
  const view = permissionView(ctx, 'sess-bot')
  assert.equal(view.available, true)
  assert.equal(view.autoAvailable, true)
  assert.equal(view.currentValue, 'workspace-write')
  const result = setPermission(ctx, 'sess-bot', 'danger-full-access')
  assert.equal(result.ok, true)
  assert.equal(result.currentValue, 'danger-full-access')
  const missing = setPermission(ctx, 'sess-bot', 'custom')
  assert.equal(missing.ok, false)
})
