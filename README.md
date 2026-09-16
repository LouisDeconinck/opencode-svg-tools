# OpenCode SVG Tools

Give OpenCode eyes for SVGs: render vector artwork to PNG so vision-capable models can inspect and improve what they generate.

LLMs can edit SVG source, but good visual work requires inspecting the rendered result. `svg_render` closes that loop by rasterizing the SVG and returning the PNG directly to the model as an image attachment:

```
edit SVG → svg_render → visually inspect render → edit SVG again
```

## Installation

Copy `svg_render.ts` into your project's `.opencode/tools/` directory:

```text
your-project/
└── .opencode/
    ├── package.json
    └── tools/
        └── svg_render.ts
```

Then add the renderer dependency to your project's `.opencode/package.json`:

```json
{
  "dependencies": {
    "@resvg/resvg-js": "^2.6.2"
  }
}
```

OpenCode installs `.opencode` dependencies automatically the next time it loads your tools.

## Usage

Ask your agent to inspect its own work:

```text
Edit sticker.svg, call svg_render to inspect the result visually, fix any issues you see, then render it again.
```

Tool arguments:

```json
{
  "path": "sticker.svg",
  "width": 1600
}
```

| Argument     | Type   | Required | Description                                                                                          |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `path`       | string | yes      | Project-relative path to the SVG file.                                                               |
| `width`      | number | no       | Target PNG width in pixels, 64–8192 (default `1600`). Height preserves the SVG aspect ratio.         |
| `background` | string | no       | CSS color drawn behind the artwork, e.g. `"white"`, `"#ffffff"`, `"rgba(255,255,255,1)"`. Omit for transparency. |

Each call writes (or overwrites) `.opencode/renders/<name>.png` and returns the image to the model as an `image/png` attachment.

## Requirements

- [OpenCode](https://opencode.ai)
- An image/vision-capable model if you want the model itself to inspect the PNG. Text-only models still get the saved file path and dimensions, but they cannot see the image.

## How it works

```text
SVG → resvg → PNG → OpenCode image attachment → model visual inspection
```

Rendering uses [`@resvg/resvg-js`](https://github.com/thx/resvg-js) — no browser, Chromium, or external rasterizer involved. Paths are confined to the project directory and renders always land in `.opencode/renders/` (git-ignored).

## Scope

v1 intentionally provides only SVG rendering / visual feedback. No SVG validation, optimization, or editing features — your agent already has those tools.

## License

[MIT](LICENSE)
