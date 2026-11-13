# Activity display — phase 1

This is a UI/reducer change, not a process monitor or a new DSH protocol.

- The transcript follows original segment/event order: reasoning → tool → text → reasoning → tool → text. Only **contiguous** process segments share an Activity group; no activity is hoisted across text, even within one turn. Normal and Bot mode use the same renderer. Each tool row and its independent Full arguments fold use the existing shared `Collapse` component and native keyboard-accessible buttons with `aria-expanded`/`aria-controls`. Both start closed, including current calls; only an explicit user toggle expands details, and incoming results do not force them open. The existing grid-height transition and reduced-motion path are reused, not replaced by native `details` or a new animation library. Its closed summary contains the description-first operation title and, when necessary, a failure/cancellation/unknown warning. Success badges/counts and command/todo previews are omitted. Activity groups still preserve contiguous timeline boundaries. Reasoning is an individual row, never an umbrella name for tools.
- One compact status line above the composer summarizes observed current tools or worker tickets, independently of timeline placement. A parameter draft is only “Preparing call”; a dispatched call is only “Waiting for tool result”. Model narration is never used as a task or execution report. Parallel tickets are counted once each, with awaiting-review/user states separate. Settled activity hides the line. A background acknowledgement is **last known**, not pending or running: it may appear only for the current drafting turn, without shimmer or a “pending” count, and never after the turn has settled. If a later result for the same call includes an exit, stop, or signal marker, that evidence leaves the last-known state. Silence still does not invent failure or completion.
- The single-line summary and tooltip are redacted, truncate on small screens, and use a small CSS-only sweep. Reduced-motion disables it; page visibility pauses it, and disconnected/syncing states do not shimmer. There is no generic second Thinking panel.
- A streaming tool-call block is **preparing**. A durable `tool/call` is **waiting for a result**, not proof of a spawned process. A result can settle a call even with empty content. Failure, cancellation, and unknown outcomes are separate. A completed/aborted turn without a tool result cannot certify successful execution or child-process termination.
- `running` is reserved in the view model for confirmed execution evidence; phase 1 does not produce that status from prose, arguments or elapsed time. There is no new timeout that turns a silent tool into a failure.
- The original command, description, raw JSON arguments and requested/default/recorded working directory are separate fields. Multi-line commands remain intact in the expanded view. Commands, parameters, output, directories and activity-only diffs wrap naturally (`pre-wrap` and `overflow-wrap: anywhere`) with no fixed-height or nested scroll container; the sanitized copy payload retains its original newlines. The animated folds use intrinsic height rather than fixed-height measurement, so incremental output remains complete. Global Markdown code/table layout is unchanged. Missing shell descriptions use a short “Run command” title, never the raw command. A call/result timestamp difference is labelled **call wait**, not process runtime. No invented exit code 0.
- The rc.1 bash adapter recognizes its own result markers for nonzero exit, signal, sandbox, and background promotion. These are text-format adapters, not a structured terminal stream or a heartbeat. A background job id remains **last known background state** unless a later result for that same call carries an explicit terminal marker. Phase 1 does not poll jobs or infer completion from elapsed time. User output imitating a host marker cannot be disambiguated without better upstream evidence.
- `todo_write` displays real `todos[].content/status` and marks counts as plan records, not proof of executed work.
- Dispatch calls link to existing tickets and child sessions. `ready` is not `delivered`. The latest report comes only from the current ticket revision and non-stale events. Multiple workers remain independent, using existing ticket cards and navigation; phase 1 does not silently subscribe to all worker logs to invent a global process monitor.
- A call id is scoped by its subscription/session. Durable call/result metadata survives stream projection. Explicit `resultReceived` plus result seq fences empty results, late calls and old results. Stream revision/index/attempt guards and baseline replacement prevent replay duplication. The existing follow + range/CDC/official-page catch-up path remains unchanged.
- Connection uncertainty is displayed separately from the last known activity state. Full refresh reconstructs from durable events; stale streams cannot reopen completed turns.

## Data safety

Activity arguments, commands, output, diffs, reasoning, reports and Copy buttons share the same redaction path. It masks sensitive JSON keys, common secret assignments/flags, auth headers, URL userinfo, known token prefixes and private-key blocks, including incomplete streaming JSON. This is a best-effort presentation filter, not a claim that arbitrary unlabelled secrets can be detected. It neither sanitizes/deletes the canonical log nor adds a raw-reveal option. Existing host/session authorization still controls data access.

## Reproducible checks

```sh
npm ci
npm ci --prefix ui
npm test
npm run type-check
npm run type-check --prefix ui
npm run format:check
npm run build
npm run build --prefix ui
DSH_BIN=/path/to/@deepseek-ai/dsh@0.2.2-rc.1/lib/bin.js npm run test:host
```

Unit coverage includes the reducer, redaction projections and server-side React rendering (no browser), with position assertions across text boundaries, multiple steps/turns, empty/consecutive text, stream-to-durable commits, late results and replay. The ordering regression test was first run against the unchanged previous head and failed because its second tool appeared before the first text. A second regression caught provisional tool seq values surviving a held stream commit; canonical message content now establishes their committed order without replacing results. `test/activity-host.test.ts` creates a disposable loopback rc.1 host with a mock model, but executes **real bash** via HTTP APIs: successful output, no-output success, exit 7, background acknowledgement and real todo records, then replays the event log. It runs as part of `test:host`.

A prerequisite lockfile repair is intentionally separate: the former CI failed at `npm ci`, before tests. Reconstructing the missing rc.1 dependency graph also exposed a redundant `sessionPersistence` augmentation, now removed in favor of the official type. The ten former UI tsc diagnostics are fixed with unused-import cleanup, an explicit test array type and an accurate manifest-result union (no runtime CDC change). DSH stays pinned to rc.1 and the compatibility range is unchanged.

Real-browser layout, clipboard interaction and mobile/sleep lifecycle acceptance remain manual. The production build is generated under ignored `public/`, not committed. No deployment or release is performed by this change.


## Animation follow-up

Activity groups and reasoning already used `Collapse`; the tool and Full arguments disclosures introduced by the compact-row change bypassed it with native `details`. Those two folds now share a controlled activity-disclosure view backed by the real `Collapse`, with independent state and click handlers that stop propagation. Copy controls remain inside their respective body, never inside a toggle button. Nested chevron styles target only their own header.

SSR checks cover default-closed production rows and explicitly expanded controlled views (including nested arguments), preserving the same ordering and redaction assertions. Callback-level tests verify independent toggles, propagation isolation and the actual imported Collapse component identity. CSS checks retain reduced-motion transitions and unconstrained wrapping. These checks are not a real-browser animation, keyboard-interaction or visual acceptance test.
