# Default permission for new main sessions

The workbench permissions drawer has two controls. The list at the top changes the open session. The list under **Default for new sessions** / **新会话的默认权限** changes the instance default used the next time a bot main session is created.

Fully allow is `danger-full-access`. On the stock host preset table that bundle is sandbox `danger-full-access` and approval `never`: file access is not limited to the workspace, and approval prompts are not raised. That is a broad permission. It is the product default when no default has been saved.

## What is stored

The file is `<dataDir>/permission-default.json`. `dataDir` is the session-foundations directory (`<profile>/session-foundations` unless the plugin `dataDir` config overrides it). Writes are atomic renames. The file is read again after a process restart; nothing about this default is kept only in memory.

```json
{
  "defaultPreset": "danger-full-access",
  "pending": ["session-0123456789abcdef"]
}
```

| Field | Meaning |
| --- | --- |
| `defaultPreset` | Preset id applied to a main session created after the save. Absent means the product default below. |
| `pending` | Internal. Main session ids created by the workbench whose first live permission write has not happened yet. Not a client setting. |

`defaultPreset` accepts a preset from the live catalog `defaultOptions` (the configured table). The stock table is `workspace-write` and `danger-full-access`. `read-only` is accepted when that deployment's table includes it. `auto` and `custom` are rejected: Auto is current-session only, and `custom` is derived state, not a mode you can select. Any other string is rejected and the file is left unchanged.

When the field is missing, the JSON is an older object without it, or the file is absent, the effective value is `danger-full-access` if the catalog lists it. A stored value the catalog does not list is ignored the same way and is not rewritten until a valid save. A non-string, empty, `auto`, or `custom` value is also ignored.

## How a new main session gets it

`POST /session-foundations/api/sessions` (the same route as `/dsh-bot/api/sessions`) is the workbench create path. A response that is not an idempotency replay and not a reused blank session appends that id to `pending`.

The host pins its own composition default when the Agent is created. For a fresh session that default is usually `workspace-write`. This plugin then calls `permissionPresets.set(session, defaultPreset)` if the id is still pending. That is the official write path: it appends `permission/preset` and updates sandbox mode and approval policy through their own setters. The chip reads the same projection, so the label matches the policy that tools actually run under.

The same apply runs from `agent/created` once the session is marked as a bot, which covers a turn that starts after the create request returned. If the session object is not live yet, the id stays pending and the later event applies it. A second event does not apply again.

These creates do not arm a pending id:

- The same idempotency key returning the session already created.
- A blank idle session reused for the same workspace.
- `POST /sessions/mark` on a session that already existed.
- A worker (`worker-…`) created for a ticket. A worker does not use this default. It inherits its parent main session, below.

## Precedence

1. A successful `POST /permissions` for that session removes it from `pending`. The preset just written is kept. A later global change does not call `set` on it.
2. The global default is applied at most once, and only while the id is pending.
3. Changing the global default affects main sessions created after the change. It does not walk existing sessions.
4. A session that was never pending is never rewritten, including one restored after a restart.

## Workers inherit the parent main session

A worker created from a main session copies that main session's **current effective preset** at dispatch time. The copy is both knobs in the preset bundle: sandbox mode and approval policy. It is not the instance default, and it is not a hardcoded `workspace-write`.

| Parent at dispatch | Worker |
| --- | --- |
| `danger-full-access` (sandbox `danger-full-access`, approval `never`) | The same bundle |
| `workspace-write` (sandbox `workspace-write`, approval `ask`) | The same bundle |
| Another selectable catalog preset, including `read-only` and `auto` when that deployment lists it | That preset |

`foundations_dispatch` is the production path. It creates `worker-<ticket>` through `agents.create` with the `foundations-files` tool preset (or `foundations-canvas` for a canvas briefing). The tool preset only mounts tools. The permission preset is separate.

The host still pins its composition default on `agent/created` with `prepend: true`, before ordinary listeners. For a fresh agent that pin is the `permission` settings default, which this plugin leaves unset, so the pin is usually `workspace-write`. This plugin's own `agent/created` listener does not use `prepend`. It runs after that pin and calls `permissionPresets.set(worker, parentPreset)`. Listeners are serial and are awaited before `agents.create` resolves, so the worker is already on the parent bundle before its first turn. If that event could not see the session yet, the create path calls `set` once more after `agents.create` returns. A second successful write is not done: the intent is dropped after the first success.

The parent preset is read when dispatch starts, before `agents.create`. Changing the main session later does **not** update a worker that already exists. A worker created after the change inherits the new preset. `resume`, `clear`, and `compact` do not apply the snapshot again. The snapshot is process memory. If the process dies after the agent exists and before `set`, the worker keeps the host pin, and a restart does not rewrite it.

These do not inherit:

- An unrelated agent, a blank-session reuse, or an idempotent replay of a main-session create.
- A worker that is already running, including one restored after a restart.
- A replay of the same dispatch idempotency key. That returns the existing ticket and does not create another worker.

If the parent policy cannot be copied, the worker **keeps the host pin**. The instance default is not substituted, so a missing parent does not become Fully allow.

| Situation | Result |
| --- | --- |
| Parent session is not live, or its current preset is empty | Host pin. Reason `missing`. |
| `permissionPresets` is not composed | Host pin. Reason `unavailable`. |
| Current preset is `custom` (knobs match no selectable preset; `set` rejects `custom`) | Host pin. Reason `custom`. |
| Current preset is not in the live catalog | Host pin. Reason `invalid`. |
| `set` throws for another reason | Host pin. The intent is dropped. |
| `set` cannot see the worker yet (`NOT_FOUND` or `UNAVAILABLE`) | Intent stays until the retry after `agents.create`. |

## Host boundary

`@deepseek-ai/dsh-permission-presets@0.2.2-rc.1` already stores a future-session default on the `permission` settings namespace (`defaultPreset`). Agent creation reads it and pins that preset onto every fresh Agent, including workers and unrelated agents. This plugin does not call `settings.update` on that namespace and does not change the host package.

The main-session default is plugin state plus `permissionPresets.set`, scoped to new bot main sessions. Worker inheritance is the same setter, scoped to the worker id recorded for that dispatch. Per-session mode ids, bundles, and enforcement stay in the host services. The file drawer is unchanged.

## HTTP

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/session-foundations/api/permissions/default` | — |
| `POST` | `/session-foundations/api/permissions/default` | `{ "name": "<preset id>" }` |

Both aliases under `/dsh-bot/api/` are the same routes. `GET` returns `defaultPreset` (the effective value), `stored` (the raw field, or `null` when the field is absent), `ignoredStored`, `options`, `productDefault` (`danger-full-access`), `scope` (`new-main-session`), and `hostDefault` (the catalog's composition default, not the one this file applies).

Writes use the same request gate as the other workbench routes: the host connection's `requestRejection` when it returns a status, otherwise only a loopback socket is accepted. The file drawer is unchanged.

## Help copy

The drawer states that Fully allow / 完全允许 is the starting default, that it is broad, and that a saved choice applies only to main sessions created afterward. Existing sessions, including ones with a hand-picked permission, stay as they are. A worker inherits the main session it is created from, and a worker that already exists does not follow a later change on that main session.
