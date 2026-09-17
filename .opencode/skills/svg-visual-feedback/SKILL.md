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

If you are placing, aligning, or fitting an element and do not already know the coordinates, run `svg_inspect` `list` and/or `bounds` first. Do not guess coordinates from `d` path strings unless no better option exists.

- `{ "operation": "list" }` — every element with an id (tag, parent, transform)
- `{ "operation": "bounds", "element": "saddle" }` — an element's geometric box in SVG coordinates (x, y, width, height, center); transforms resolved, clip/mask may still hide part of it
- `{ "operation": "validate" }` — parse check with line/column before you waste render cycles
- `{ "operation": "clip-escape", "element": "blanket" }` — does the element's bounds poke outside the bounds of the clip applied to it? Omit `element` to check every clipped element in the file. An escape is proven; "no bounding-box escape" is not proof of containment within a non-rectangular clip.
- `{ "operation": "containment-check", "element": "artwork", "against_element": "silhouette" }` — is one element's bounding box fully inside another's? Bounding-box check only — it does not prove geometric containment within a concave shape.
- `{ "operation": "compare-path", "element": "outline", "against_file": "ref.svg" }` — are two `<path>`s identical? Exact and normalized `d` compare plus each side's bounds.

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

## Comparing two files: `svg_compare`

"Did my edit match the reference?" is a comparison question — don't eyeball two separate renders. `svg_compare` renders both files into one image:

- `"mode": "side-by-side"` — left and right next to each other at equal display height (the default); panel size does not reflect coordinate-unit size
- `"mode": "overlay"` — right drawn on top of left as a magenta ghost (onion skin); where they agree the ghost disappears into the artwork, where they diverge you see doubled edges
- `"mode": "difference"` — pixel diff including alpha, so transparency-only changes count: identical renders report 0 differing pixels, changed regions light up magenta and the differing area is reported in SVG coordinates

Overlay and difference fit `right` into `left`'s coordinate space, so files that share a viewBox align exactly.

## Stop conditions and honesty

- If the render looks right, stop. There is no hard cap on passes — avoid wasteful re-renders after tiny speculative edits, but keep rendering while each pass resolves a real visual uncertainty or verifies a meaningful revision.
- If a render times out or errors, follow the error's suggestions (usually: smaller region, no overlay).
- If your model cannot process image attachments, say so — do not claim to have inspected the PNG. It is still written to `.opencode/renders/` for the user.
