---
name: ui-design
description: Build one HTML/CSS canvas preview with canvas_write and canvas_publish. No scripts, SVG, or external URLs.
---

# Canvas UI design

This contract overrides every catalog skill. Catalog skills are taste and critique only. If one of them asks for React, Vue, a Tailwind project, JavaScript, SVG, an interview, or several variants, ignore that part and still produce one static preview.

## Output

- Entry file: `index.html`
- Also allowed: `.css`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.woff`, `.woff2`, `.ttf`, `.otf`
- At most 64 files, 1.5 MiB each, 8 MiB together
- Relative URLs only, such as `styles.css` and `hero.png`
- Read the current preview with `canvas_read`. Do not search the disk for `cnv_` or a canvas store
- New HTML and CSS go through `canvas_write` `text`, up to the 1.5 MiB file cap
- Change an existing HTML or CSS file with `canvas_edit`. Do not paste the whole file into `canvas_edit`
- Images and fonts use `canvas_write` `body` (base64). `source` is only for a file that is already in the workspace
- This worker has no `write`, `edit`, or bash tool. A file on disk is not the preview
- Call `canvas_publish` once, after every file for this task is staged. It files the result report. After it succeeds, stop. Do not keep editing and do not call `foundations_report`
- The first publish is a full snapshot. A later ticket publishes a delta of the staged set
- Do not write a browser probe

## Forbidden

- `<script>`, event handlers, `javascript:`, `data:`
- `<svg>`, `<base>`, `<iframe>`, `<object>`, `<embed>`, `<meta>`
- CSS `@import` and any `http`, `https`, or protocol-relative URL
- Fonts or images that are not staged files

## How to work

1. Load this skill first.
2. Load at most two catalog skills that match the request. Do not load the whole catalog.
3. Read the current preview with `canvas_read`. Read reference files already in the workspace with `read` only. Stage new HTML and CSS with `canvas_write` `text`. Change an existing preview file with `canvas_edit`. Stage images and fonts with `canvas_write` `body`.
4. Call `canvas_publish` once at the end. Do not publish after each file. That call files the result. Stop after it succeeds.
   If the briefing contains `[canvas-target]` blocks, change only those nodes and the CSS rules that style them. Leave every other element as it is.
5. A budget pause is not a failed preview. Wait for the grant. Do not invent a failure revision.

The sandbox iframe has no scripts. Design with HTML and CSS only. Skill text does not grant tools.
