# OpenCode SVG Tools

Give OpenCode eyes for SVGs: render vector artwork to PNG so vision-capable models can inspect and improve what they generate.

> **Requires a vision-capable model for visual inspection.** Text-only models can call the renderer but cannot see the resulting PNG.

LLMs can edit SVG source, but good visual work requires inspecting the rendered result. `svg_render` closes that loop by rasterizing the SVG and returning the PNG directly to the model as an image attachment:

```
edit SVG → svg_render → visually inspect render → edit SVG again
```

## What's included

| Artifact | Kind | Purpose |
| -------- | ---- | ------- |
| `svg_render` | [custom tool](https://opencode.ai/docs/custom-tools/) | Renders a project SVG to PNG and returns it as an `image/png` attachment. |
| `svg-visual-feedback` | [agent skill](https://opencode.ai/docs/skills/) | Optional workflow instructions: when to render, what defects to look for, and when to stop iterating. |

Install both: the tool is the capability, the skill teaches the agent to use it effectively. The tool also works on its own — its description tells the model when to reach for it.

## Installation

### Global (recommended)

Install once, use from every OpenCode project. OpenCode loads tools from `~/.config/opencode/tools/` and skills from `~/.config/opencode/skills/` (honoring `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR`).

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main/install.ps1 | iex
```

Or run `./install.sh` / `.\install.ps1` from a clone of this repository.

The script copies the tool and skill into your OpenCode config directory and ensures `package.json` there declares the required dependencies:

```text
~/.config/opencode/
├── package.json        → { "dependencies": { "@resvg/resvg-js": "^2.6.2", ... } }
├── tools/
│   └── svg_render.ts
└── skills/
    └── svg-visual-feedback/
        └── SKILL.md
```

OpenCode installs config-directory dependencies automatically on startup; the script also runs `bun install`/`npm install` eagerly when a package manager is available.

### Project-local (for shared repositories)

Commit the tool and skill with a project so every contributor's agent gets them:

```text
your-project/
└── .opencode/
    ├── package.json    → { "dependencies": { "@resvg/resvg-js": "^2.6.2" } }
    ├── tools/
    │   └── svg_render.ts
    └── skills/
        └── svg-visual-feedback/
            └── SKILL.md
```

Copy `.opencode/tools/` and `.opencode/skills/` from this repo and merge the dependencies from `.opencode/package.json`.

Restart OpenCode after installing — `svg_render` appears alongside the built-in tools, and `svg-visual-feedback` appears in the `skill` tool's available list.

## Usage

Ask your agent to inspect its own work:

```text
Edit sticker.svg, call svg_render to inspect the result visually, fix any issues you see, then render it again.
```

Tool arguments:

```json
{
  "path": "sticker.svg",
  "width": 1600,
  "region": { "x": 220, "y": 80, "width": 70, "height": 70 },
  "background": "#f2f2f2",
  "overlay": "grid+clip"
}
```

| Argument     | Type   | Required | Description                                                                                          |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `path`       | string | yes      | Project-relative path to the SVG file.                                                               |
| `width`      | number | no       | Target PNG width in pixels, 64–4096 (default `1600`). Height preserves the rendered region's aspect ratio. |
| `region`     | object | no       | Region of the SVG's viewBox to render — `{ "x": 220, "y": 80, "width": 70, "height": 70 }`. Coordinates are **SVG/viewBox coordinates, not PNG pixels**: the same numbers you edit the file with. The region is scaled to fill the output image, so it acts as a zoom. It may extend past the viewBox; empty area renders as background. |
| `background` | string | no       | CSS color drawn behind the artwork, e.g. `"white"`, `"#ffffff"`, `"rgba(255,255,255,1)"`. Defaults to `"#f2f2f2"`, a neutral inspection gray that keeps both black and white details visible — transparent PNGs can otherwise be shown against black by an image viewer and mislead inspection. Pass `"transparent"` when alpha itself matters. |
| `overlay`    | string | no       | `"none"` (default), `"grid"`, `"clip"`, or `"grid+clip"`. Diagnostic only — see below.                 |

### Region: zoom without more pixels

A vision model downsamples large images anyway, so a 4096 px whole-image render costs time and tokens without adding inspectable detail. Render the small region instead — it is scaled to the full output width:

```json
{ "path": "sticker.svg", "region": { "x": 220, "y": 80, "width": 70, "height": 70 } }
```

### Overlays: coordinate grid and clip debugging

`overlay: "grid"` draws labeled grid lines **in SVG coordinates** over the artwork, so the model can reason "the nose is around x=245, y=115" instead of guessing. Spacing adapts automatically (~5–10 major divisions with lighter minor lines). It works together with `region`, so a zoomed crop is labeled with real coordinates.

`overlay: "clip"` draws every active `clipPath` boundary as a dashed magenta outline (with a faint tint) over the normal render. This answers the most confusing sticker failure mode: an element placed outside a clip silently disappears. The outline shows the region that actually survives.

`overlay: "grid+clip"` draws both. Overlays are rendered into an in-memory copy of the SVG — **the source file is never modified**, and a normal render (`overlay: "none"`) is byte-identical to what it was before overlays existed.

Each call writes (or overwrites) `.opencode/renders/<name>.png` inside the current project and returns the image to the model as an `image/png` attachment, plus a short report:

```text
sticker.svg → .opencode/renders/sticker.png
SVG viewBox: 0 0 512 512
Render region: 220 80 70 70
Overlay: grid+clip (clip: 1 outlined)
Output: 1600×1600 px
Background: #f2f2f2
Source: a18d302c91b7
PNG: c209bad3761e
```

`Source` is a SHA-256 prefix of the SVG file as read — if it doesn't change between renders, your edit never reached the file. `PNG` is a SHA-256 prefix of the rendered image — if it doesn't change, neither did the visible output. Together they distinguish "source changed" from "render changed" and remove any doubt about stale renders.

## Example workflow

```text
1. Render normally.                     → see that a small heart is missing
2. Re-render the nose region with grid+clip.
3. Move the heart using the visible SVG coordinates.
4. Render normally again for final verification.
```

## Verify it works

After restarting OpenCode, ask:

```text
Create a simple test.svg containing a red circle, then use svg_render to visually inspect it and tell me what you see.
```

Expected: the tool reports something like `test.svg → .opencode/renders/test.png` with dimensions, and the agent describes the red circle — proof the rendered image actually reached the model.

For a fuller check of the tool itself (rendering, region, overlays, hashes, security, cancellation, and timings), run the verification harness from a clone:

```sh
node test/verify.mjs
```

It generates fixtures under `test/tmp/`, exercises the tool's `execute()` directly, and prints a benchmark table.

## Requirements

- [OpenCode](https://opencode.ai)
- An image/vision-capable model if you want the model itself to inspect the PNG.

## How it works

```text
SVG → in-memory diagnostic copy (region / overlay edits) → resvg → PNG
    → OpenCode image attachment → model visual inspection
```

Rendering uses [`@resvg/resvg-js`](https://github.com/thx/resvg-js) — no browser, Chromium, or external rasterizer involved. Paths are confined to the project directory and renders always land in `.opencode/renders/` (git-ignored).

Region rendering rewrites the root `viewBox`/`width`/`height` on the in-memory copy, so the requested region scales to the output width. Overlays are injected into the same copy: grid lines and labels are generated in user space, and clip outlines are drawn at the document end with the referencing element's full ancestor `transform` chain, so they land exactly on the clip boundary and paint above the artwork. When `overlay` is `"none"` the SVG is passed through untouched apart from a possible region rewrite.

### Clip overlay limitations

Outlines are drawn for `clipPath` elements referenced via `clip-path="url(#id)"` or an inline `style`, which covers the vast majority of Cricut/Inkscape/Illustrator exports. These cases are intentionally not outlined (and reported in the tool output when relevant):

- `clipPathUnits="objectBoundingBox"` — clip geometry is relative to the clipped element's bounding box, which would need a geometry engine to resolve. Skipped with a note.
- Clip usages inside nested `<svg>` viewports are detected and skipped with a note in the tool output (`1 nested SVG usage skipped`), because the viewport mapping (`x`/`y`/`width`/`height`/`viewBox`) is not represented by ancestor `transform` attributes.
- Clip usage inside `<defs>`/`<symbol>` that is instanced elsewhere with `<use>` — the instance's transform is unknowable without evaluating the shadow tree. Skipped.
- Clip paths applied purely via an external/class-based stylesheet (no `clip-path` attribute or inline style).

## Scope

`svg_render` intentionally provides only SVG rendering / visual feedback. No SVG validation, optimization, or editing features — your agent already has those tools.

Deliberately deferred: exact geometry queries (point-in-shape, element bounds, clipped-area percentages) and render comparison/history. Those belong in separate tools rather than in the renderer.

## License

[MIT](LICENSE)
