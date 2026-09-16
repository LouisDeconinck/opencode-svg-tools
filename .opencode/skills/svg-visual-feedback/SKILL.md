---
name: svg-visual-feedback
description: Visually inspect and iteratively improve SVG artwork. Use when creating, editing, reviewing, or debugging SVG graphics, illustrations, icons, stickers, logos, or other vector artwork.
license: MIT
compatibility: opencode
---

# SVG visual feedback

Never judge SVG quality from source alone. SVG that parses correctly can still look wrong. After creating or materially modifying visual SVG artwork, inspect the actual rendered pixels.

## Workflow

```text
create/edit SVG
      ↓
svg_render
      ↓
inspect actual rendered PNG
      ↓
identify concrete visual defects
      ↓
edit SVG
      ↓
svg_render again
      ↓
final visual verification
```

1. Make your SVG edits. Batch related changes — don't render after every tiny source edit.
2. Call the `svg_render` tool on the file.
3. Look at the returned image attachment, not just the tool's text output.
4. Fix concrete defects found in the render, then render again.
5. After the last visual modification, always do a final `svg_render` to confirm the end state.

## What to look for

- proportions that look off relative to the intent
- misaligned or off-center elements
- clipping or elements extending outside intended boundaries
- unintended gaps, overlaps, or awkward spacing
- poor balance or composition
- missing details
- inconsistent stroke widths or sizes

## Tips

- To inspect a small area closely, pass `region` in SVG viewBox coordinates — the region renders at full output resolution, effectively zooming in. Reuse the coordinates of the element you are editing.
- Renders use a light gray (`#f2f2f2`) background by default so both dark and light details stay visible. Pass `background: "transparent"` only when you need to inspect the alpha channel itself.
- Compare the `Source` and `PNG` hashes between renders: an unchanged `Source` means your edit never reached the file; an unchanged `PNG` means the edit changed nothing visible.

## Stop conditions

- If the render looks satisfactory, stop — do not loop for the sake of looping.
- Limit autonomous refinement to roughly 2–3 render/inspect passes unless additional iterations are clearly useful or the user asks for more.

## Honesty

If your model cannot process image attachments, say so — do not claim to have visually inspected the PNG. The render is still written to `.opencode/renders/` for the user to check.
