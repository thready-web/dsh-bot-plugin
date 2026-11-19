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
- Stage files with `canvas_write`, then call `canvas_publish`
- The first publish is a full snapshot. Later publishes are deltas of the staged set
- Do not use bash, write, or edit for the preview

## Forbidden

- `<script>`, event handlers, `javascript:`, `data:`
- `<svg>`, `<base>`, `<iframe>`, `<object>`, `<embed>`, `<meta>`
- CSS `@import` and any `http`, `https`, or protocol-relative URL
- Fonts or images that are not staged files

## How to work

1. Load this skill first.
2. Load at most two catalog skills that match the request. Do not load the whole catalog.
3. Write `index.html` and its stylesheet in one `canvas_write`, then `canvas_publish`.
4. A later change writes the files that changed, then publishes again. The host sends the staged package as a delta.
   If the briefing contains `[canvas-target]` blocks, change only those nodes and the CSS rules that style them. Leave every other element as it is.
5. A budget pause is not a failed preview. Wait for the grant. Do not invent a failure revision.

The sandbox iframe has no scripts. Design with HTML and CSS only. Skill text does not grant tools.
