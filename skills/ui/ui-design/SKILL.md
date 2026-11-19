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
- Change an existing HTML or CSS file with `canvas_edit`. Do not paste the whole file into a tool argument
- `canvas_write` `source` is a workspace-relative path. The host reads the file. `text` is only for a short new HTML or CSS file. `body` base64 is only for images and fonts
- Call `canvas_publish` once, after every file for this task is staged. A second call on the same ticket is rejected
- The first publish is a full snapshot. A later ticket publishes a delta of the staged set
- Do not use bash. This worker has no command tool. Do not write a browser probe

## Forbidden

- `<script>`, event handlers, `javascript:`, `data:`
- `<svg>`, `<base>`, `<iframe>`, `<object>`, `<embed>`, `<meta>`
- CSS `@import` and any `http`, `https`, or protocol-relative URL
- Fonts or images that are not staged files

## How to work

1. Load this skill first.
2. Load at most two catalog skills that match the request. Do not load the whole catalog.
3. Read existing files with `canvas_read`. Change them with `canvas_edit`. Put a new image, font, or long file in the workspace and stage it with `canvas_write` `source`.
4. Call `canvas_publish` once at the end. Do not publish after each file.
   If the briefing contains `[canvas-target]` blocks, change only those nodes and the CSS rules that style them. Leave every other element as it is.
5. A budget pause is not a failed preview. Wait for the grant. Do not invent a failure revision.

The sandbox iframe has no scripts. Design with HTML and CSS only. Skill text does not grant tools.
