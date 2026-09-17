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
| `svg_inspect` | [custom tool](https://opencode.ai/docs/custom-tools/) | Answers structural SVG questions without rendering: list element ids, get an element's geometric bounding box, validate markup, compare path data, check clip escape and containment. |
| `svg_compare` | [custom tool](https://opencode.ai/docs/custom-tools/) | Renders two SVGs into one image: side-by-side, magenta-ghost overlay, or a pixel diff with a differing-region report. |
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
├── package.json        → { "dependencies": { "@resvg/resvg-js": "2.6.2", ... } }
├── tools/
│   ├── svg_render.ts
│   ├── svg_inspect.ts
│   └── svg_compare.ts
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
    ├── package.json    → { "dependencies": { "@resvg/resvg-js": "2.6.2" } }
    ├── tools/
    │   ├── svg_render.ts
    │   ├── svg_inspect.ts
    │   └── svg_compare.ts
    └── skills/
        └── svg-visual-feedback/
            └── SKILL.md
```

Copy `.opencode/tools/` and `.opencode/skills/` from this repo and merge the dependencies from `.opencode/package.json`.

Restart OpenCode after installing — `svg_render`, `svg_inspect` and `svg_compare` appear alongside the built-in tools, and `svg-visual-feedback` appears in the `skill` tool's available list.

## Usage

Ask your agent to inspect its own work:

```text
Edit sticker.svg, call svg_render to inspect the result visually, fix any issues you see, then render it again.
```

Tool arguments:

```json
{
  "path": "sticker.svg",
  "width": 800,
  "region": { "x": 220, "y": 80, "width": 70, "height": 70 },
  "background": "#f2f2f2",
  "overlay": "grid+clip"
}
```

| Argument     | Type   | Required | Description                                                                                          |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `path`       | string | yes      | Path to the SVG file, resolved relative to the **project directory OpenCode is running in** (`context.directory`) — *not* relative to `.opencode/`. So `"art/logo.svg"` means `<project>/art/logo.svg`. |
| `width`      | number | no       | Target PNG width in pixels, 64–4096 (default `800`). Height preserves the rendered region's aspect ratio. |
| `region`     | object | no       | Region of the SVG's viewBox to render — `{ "x": 220, "y": 80, "width": 70, "height": 70 }`. Coordinates are **SVG/viewBox coordinates, not PNG pixels**: the same numbers you edit the file with. The region is scaled to fill the output image, so it acts as a zoom. It may extend past the viewBox; empty area renders as background. |
| `background` | string | no       | Backdrop behind the artwork. Presets: `"checker"` (**default** — subtle `#eeeeee`/`#dcdcdc` checkerboard, keeps dark and white art visible while making transparency explicit), `"neutral"` (flat `#f2f2f2` inspection gray), `"transparent"` (real PNG alpha). Any other value is a CSS color like `"white"` or `"#ffffff"`. The checkerboard is injected only into the diagnostic render — the source file is never modified. |
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
Output: 800×800 px
Background: checker (default)
Source: a18d302c91b7
PNG: c209bad3761e
Timing: 184 ms total — inspect 14, prepare 2, render 151, png 12, write 3, base64 2
```

`Source` is a SHA-256 prefix of the SVG file as read — if it doesn't change between renders, your edit never reached the file. `PNG` is a SHA-256 prefix of the rendered image — if it doesn't change, neither did the visible output. Together they distinguish "source changed" from "render changed" and remove any doubt about stale renders. The `Timing` line shows where the call spent its time (useful when a render feels slow).

Renders have an internal 20-second timeout: if a pathological document or extreme zoom exceeds it, the tool returns an actionable error instead of hanging the session.

### `svg_inspect`: structural answers without rendering

When the question is "what exists" or "where is it", rendering is the slow way to find out. `svg_inspect` answers directly:

```json
{ "path": "sticker.svg", "operation": "list" }
{ "path": "sticker.svg", "operation": "bounds", "element": "saddle" }
{ "path": "sticker.svg", "operation": "validate" }
{ "path": "sticker.svg", "operation": "clip-escape", "element": "blanket" }
{ "path": "sticker.svg", "operation": "containment-check", "element": "artwork", "against_element": "silhouette" }
{ "path": "sticker.svg", "operation": "compare-path", "element": "outline", "against_file": "reference.svg" }
```

- **`list`** prints every element with an `id` — tag name, parent id, transform flag — capped at 150 rows.
- **`bounds`** returns the element's geometric bounding box in SVG/viewBox coordinates (`x`, `y`, `width`, `height`, `center`) — transforms, groups, nested `<svg>` viewports and `<use>` instances are all resolved. These are geometric (pre-raster) bounds, not the raster extent: filter effects are not included, and clip/mask may hide part of the reported box. Elements inside `<defs>`/`<symbol>` are reported honestly as "never rendered directly" — query the `<use>` that instances them instead.
- **`validate`** reports `Valid SVG` or a parser error with line/column and the offending source line.
- **`clip-escape`** measures an element's geometric bounds against the bounds of the clip-path that applies to it (its own `clip-path` or the nearest clipped ancestor's) and reports which sides overflow and by how much. Pass the clip-bearing group itself to get a per-child list of what escapes. Omit `element` to check every clip usage in the file. An escape is proven — a pixel at the bounds extreme sits outside the clip's bounds — but "no bounding-box escape" is **not** proof of containment within a non-rectangular clip shape. Nested `clip-path` on the `clipPath` itself is intersected; `clipPathUnits="objectBoundingBox"` and clips inside nested `<svg>` viewports are skipped with an honest note.
- **`containment-check`** measures `element`'s bounds against `against_element`'s bounds and reports "fully inside its bounds" or per-side overflow. This is a bounding-box check only — it does not prove geometric containment within a concave shape (an element can sit inside the silhouette's bounding rectangle while lying outside the silhouette itself). `against_element` may be a rendered element, a `<defs>`/`<symbol>` element (measured as if instanced at the origin), or a `<clipPath>` (measured at root coordinates). Pass `against_file` to compare against an element in another SVG — bounds are measured in each file's own coordinate space, which is meaningful when both files share a coordinate system.
- **`compare-path`** compares the `d` data of two `<path>` elements: exact string match, then a normalized compare (command letters and numeric arguments — `10.0` = `10`, `.5` = `0.5`), reporting the first differing token when they diverge. It also reports each side's geometric bounds so "same `d`, different placement" (e.g. a transform upstream) is distinguishable from a truly identical path. The other side defaults to the same id; select it with `against_element` and/or `against_file`.

Use `bounds` output to build `region` arguments for `svg_render` close-ups without guessing.

### `svg_compare`: two files, one image

When the question is "did my edit match the reference?" or "where did these two versions diverge?", `svg_compare` renders both files into a single returned image:

```json
{ "left": "sticker.svg", "right": "reference.svg", "mode": "overlay" }
```

| Argument | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `left` | string | yes | First SVG — drawn on the left / underneath. |
| `right` | string | yes | Second SVG — drawn on the right / on top. |
| `mode` | string | no | `"side-by-side"` (default), `"overlay"`, or `"difference"` — see below. |
| `width` | number | no | Output PNG width in px, 64–4096 (default `800`). |
| `background` | string | no | Same presets as `svg_render` (checker default). Ignored for `difference`, which always diffs transparent renders. |

- **`side-by-side`** places both files next to each other at equal display height, each side scaled to fill its panel with its aspect preserved, separated by a thin divider. Panel size is deliberately independent of coordinate-unit size — a `0 0 1000 1000` file does not render ten times larger than a `0 0 100 100` file of the same drawing.
- **`overlay`** fits `right` into `left`'s coordinate space and draws it as a translucent magenta ghost (onion skin). Shapes that agree blend away; diverging shapes show doubled edges. When the files share a viewBox the alignment is exact; when they differ, `right` is scaled with aspect preserved (`xMidYMid meet`, letterboxed if needed).
- **`difference`** renders each file alone inside `left`'s coordinate space, then diffs the pixels: identical regions fade to pale gray, differing pixels turn magenta, and the output reports the differing pixel count plus the differing region in left-SVG coordinates. The comparison includes alpha (premultiplied RGBA), so transparency-only changes — e.g. a white shape appearing where nothing was — still count. `0 pixels differ above threshold` (threshold 12/255) means the renders match within tolerance — near-identical anti-aliasing noise can sit below the threshold, so it is a strong same-render signal rather than a byte-for-byte proof.

Two details worth knowing: `right`'s element ids are automatically prefixed before composition, so shared ids can't collide (`url(#x)` / `href="#x"` and `#x` selectors inside `<style>` are rewritten consistently), and the same expanded-canvas crash protection as `svg_render` applies — offscreen content can't abort the process.

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

Region rendering rewrites the root `viewBox`/`width`/`height` on the in-memory copy, so the requested region scales to the output width. Overlays are injected into the same copy: grid lines and labels are generated in user space, and clip outlines are drawn at the document end with the referencing element's full ancestor `transform` chain, so they land exactly on the clip boundary and paint above the artwork. When `overlay` is `"none"` the SVG markup is passed through untouched apart from a possible region/canvas rewrite (see crash safety below).

**Crash safety:** resvg-js 2.x contains an upstream bug (fixed in resvg `main`, not yet released) where any element that needs a raster layer — opacity, filter, mask, clip-path, stroke, marker, `<use>` — aborts the entire host process when it lies completely outside the rendered viewBox. Region zooms make this far more likely because more artwork ends up off-canvas. Before rendering, the tool computes the document bounding box; if it extends past the requested view, the canvas is temporarily expanded to cover it and the pixmap is cropped back to the requested view. This keeps renders correct and crash-free; the surface is capped (≈32M px, ≈128 MiB RGBA) so extreme cases render at reduced resolution rather than consuming unbounded memory — noted in the output when it happens.

### Clip overlay limitations

Outlines are drawn for `clipPath` elements referenced via `clip-path="url(#id)"` or an inline `style`, which covers the vast majority of Cricut/Inkscape/Illustrator exports. These cases are intentionally not outlined (and reported in the tool output when relevant):

- `clipPathUnits="objectBoundingBox"` — clip geometry is relative to the clipped element's bounding box, which would need a geometry engine to resolve. Skipped with a note.
- Clip usages inside nested `<svg>` viewports are detected and skipped with a note in the tool output (`1 nested SVG usage skipped`), because the viewport mapping (`x`/`y`/`width`/`height`/`viewBox`) is not represented by ancestor `transform` attributes. A `clipPath` that is *defined* inside a nested viewport but referenced from outside it is still outlined correctly: `userSpaceOnUse` clip contents resolve in the referencing element's user space, not at the definition site.
- Clip usage inside `<defs>`/`<symbol>` that is instanced elsewhere with `<use>` — the instance's transform is unknowable without evaluating the shadow tree. Skipped.
- Clip paths applied purely via an external/class-based stylesheet (no `clip-path` attribute or inline style).

## Scope

`svg_render` intentionally provides only SVG rendering / visual feedback; `svg_inspect` intentionally provides only structural queries (list / bounds / validate / fit checks); `svg_compare` provides visual diffing between two files. No SVG editing or optimization features — your agent already has those tools.

The fit checks (`clip-escape`, `containment-check`) are bounding-box level: they answer "does the rectangle around A exceed the rectangle around B". An escape verdict is proven — a pixel at the bounds extreme really sits outside — but an "inside" verdict does not prove containment within a concave clip or silhouette shape. The planned upgrade is a raster check: render the element and the silhouette as masks at verification resolution and count element pixels outside it, giving a definitive "outside: N pixels (X%)" answer. Also deliberately deferred: element-under-point queries, render history, and multi-render batch calls.

## License

[MIT](LICENSE)
