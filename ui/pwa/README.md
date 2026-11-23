# PWA shell

Build-time and runtime pieces that make `/dsh-bot/` installable and give a warm
second start a local shell before the network answers. The design, the security
rules, and what is still missing are in the repository-level
[`docs/pwa-instant-start.md`](../../../docs/pwa-instant-start.md).

## What the build writes into `public/`

`npm run build` runs `pwaShellPlugin()` after Vite. The plugin writes:

| File                         | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `manifest.webmanifest`       | `start_url` / `scope` = `/dsh-bot/`, `standalone`, icons                |
| `sw.js`                      | generated worker: `sw.template.js` + inlined `routes.js` + release list |
| `release.json`               | release id, hashed precache entries                                     |
| `icons/*.png`, `favicon.svg` | generated deterministically by `icons.mjs`                              |
| `index.html`                 | gains manifest / favicon / Apple touch links at build time              |

The precache list is the built `index.html` plus exactly the assets it references,
plus the icons. Lazy chunks, Monaco, API responses, canvas and workspace files are
never precached. `release.json` and `sw.js` are deliberately not in the list.

The release id is a hash of the entry list, so two builds with identical bytes
produce the same id and the same worker.

## Runtime rules

`routes.js` classifies every request in the worker's scope:

- `shell` — `/dsh-bot/` and `/dsh-bot/index.html`; served cache-first.
- `asset` — `/dsh-bot/assets/*`, `/dsh-bot/icons/*`, `/dsh-bot/favicon.svg`; served
  from the current bucket, then the previous one, then the network.
- `bypass` — API, SSE, canvas capability URLs, `/api/*`, `sw.js`, manifest,
  `release.json`; left to the network and never stored.
- `network` — anything else, including workspace images; network only.

No network response is written to Cache Storage. A release becomes active only
after every entry installs and hashes match. The new worker waits; the page shows
an update offer and calls `skipWaiting()` only after the reader agrees.

## Kill-switch

- Server: `DSH_BOT_PWA=0` makes `sw.js`, `manifest.webmanifest`, and `release.json`
  return 404. Hashed assets and the page still load.
- Client: `?pwa=0` unregisters the `/dsh-bot/` worker and deletes the shell buckets.
- A 404 from `sw.js` during registration also tears the worker down; transient
  network failures leave an installed worker alone.

## Tests

```bash
npm test                      # includes routes, release generation, and headers
npm --prefix plugins/dsh-bot-plugin/ui run type-check
```

`test/pwa-shell.test.mjs` builds a fixture shell and checks release ids, hashes,
icons, and injected metadata. `ui/src/pwa/routes.test.ts` runs the exact
`routes.js` source that the worker inlines.
