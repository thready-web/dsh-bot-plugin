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
- A worker (`worker-…`) created for a ticket.

## Precedence

1. A successful `POST /permissions` for that session removes it from `pending`. The preset just written is kept. A later global change does not call `set` on it.
2. The global default is applied at most once, and only while the id is pending.
3. Changing the global default affects main sessions created after the change. It does not walk existing sessions.
4. A session that was never pending is never rewritten, including one restored after a restart.

## Host boundary

`@deepseek-ai/dsh-permission-presets@0.2.2-rc.1` already stores a future-session default on the `permission` settings namespace (`defaultPreset`). Agent creation reads it and pins that preset onto every fresh Agent. That includes workers. This plugin does not call `settings.update` on that namespace and does not change the host package. Doing so would widen the worker sandbox, which this plugin keeps on the host `workspace-write` policy.

The Bot default is therefore plugin state plus the official per-session setter, scoped to new bot main sessions. Per-session mode ids, bundles, and enforcement stay in the host services.

## HTTP

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/session-foundations/api/permissions/default` | — |
| `POST` | `/session-foundations/api/permissions/default` | `{ "name": "<preset id>" }` |

Both aliases under `/dsh-bot/api/` are the same routes. `GET` returns `defaultPreset` (the effective value), `stored` (the raw field, or `null` when the field is absent), `ignoredStored`, `options`, `productDefault` (`danger-full-access`), `scope` (`new-main-session`), and `hostDefault` (the catalog's composition default, not the one this file applies).

Writes use the same request gate as the other workbench routes: the host connection's `requestRejection` when it returns a status, otherwise only a loopback socket is accepted. The file drawer is unchanged.

## Help copy

The drawer states that Fully allow / 完全允许 is the starting default, that it is broad, and that a saved choice applies only to main sessions created afterward. Existing sessions, including ones with a hand-picked permission, stay as they are.
