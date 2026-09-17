---
name: svg-visual-feedback
description: Visually inspect and iteratively improve SVG artwork. Use when creating, editing, reviewing, or debugging SVG graphics, illustrations, icons, stickers, logos, or other vector artwork.
license: MIT
compatibility: opencode
---

# SVG visual feedback

Never judge SVG quality from source alone — SVG that parses correctly can still look wrong. The core loop:

1. Batch-edit the SVG (don't render after every tiny edit).
2. `svg_render` the file and look at the returned image, not just the text output.
3. Fix concrete visual defects, then render again.
4. After the final edit, do one clean render without diagnostic overlays.

Compare the `Source`/`PNG` hashes between renders: unchanged `Source` = your edit never reached the file; unchanged `PNG` = nothing visible changed.

## Defects to look for

Proportions off, misaligned/off-center elements, clipped or missing content, gaps/overlaps, awkward spacing, inconsistent strokes.

## Finding where things are: `svg_inspect`

Don't guess coordinates by reading raw path data. `svg_inspect` answers structural questions:

- `{ "operation": "list" }` — every element with an id (tag, parent, transform)
- `{ "operation": "bounds", "element": "saddle" }` — an element's geometric box in SVG coordinates (x, y, width, height, center); transforms resolved, clip/mask may still hide part of it
- `{ "operation": "validate" }` — parse check with line/column before you waste render cycles

## Zooming in: `region`

Small features are easy to misjudge in a full render. Instead of raising `width`, render a `region` in **SVG/viewBox coordinates** — the same numbers you edit the file with. Get them from `svg_inspect` bounds or one `grid` render.

```json
{ "path": "sticker.svg", "region": { "x": 220, "y": 80, "width": 70, "height": 70 } }
```

## Coordinate grid: `overlay: "grid"`

Use only when placement is uncertain — the labeled grid lets you say "the nose is at x=245, y=115" instead of guessing. Works inside `region` too.

## Clip debugging: `overlay: "clip"`

Use when an element disappears or sits near a silhouette boundary. Clip paths are outlined in dashed magenta — the outline shows the region that survives. `"grid+clip"` draws both.

Overlays are diagnostic only and never modify the source file.

## Background

The default `checker` background keeps dark and white art visible while making transparency explicit. Use `"neutral"` (flat #f2f2f2) or `"transparent"` (real alpha) when you need them.

## Stop conditions and honesty

- If the render looks right, stop — ~2–3 render/inspect passes is the usual budget.
- If a render times out or errors, follow the error's suggestions (usually: smaller region, no overlay).
- If your model cannot process image attachments, say so — do not claim to have inspected the PNG. It is still written to `.opencode/renders/` for the user.
