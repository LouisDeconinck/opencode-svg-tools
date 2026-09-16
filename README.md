# OpenCode SVG Tools

Give OpenCode eyes for SVGs: render vector artwork to PNG so vision-capable models can inspect and improve what they generate.

> **Requires a vision-capable model for visual inspection.** Text-only models can call the renderer but cannot see the resulting PNG.

LLMs can edit SVG source, but good visual work requires inspecting the rendered result. `svg_render` closes that loop by rasterizing the SVG and returning the PNG directly to the model as an image attachment:

```
edit SVG → svg_render → visually inspect render → edit SVG again
```

## Installation

### Global (recommended)

Install once, use from every OpenCode project. OpenCode loads tools from `~/.config/opencode/tools/` (honoring `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR`).

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main/install.ps1 | iex
```

Or run `./install.sh` / `.\install.ps1` from a clone of this repository.

The script copies `svg_render.ts` into your OpenCode tools directory and ensures `package.json` there declares the required dependencies:

```text
~/.config/opencode/
├── package.json        → { "dependencies": { "@resvg/resvg-js": "^2.6.2", ... } }
└── tools/
    └── svg_render.ts
```

OpenCode installs config-directory dependencies automatically on startup; the script also runs `bun install`/`npm install` eagerly when a package manager is available.

### Project-local (for shared repositories)

Commit the tool with a project so every contributor's agent gets it:

```text
your-project/
└── .opencode/
    ├── package.json    → { "dependencies": { "@resvg/resvg-js": "^2.6.2" } }
    └── tools/
        └── svg_render.ts
```

Copy `.opencode/tools/svg_render.ts` from this repo and merge the dependencies from `.opencode/package.json`.

Restart OpenCode after installing — `svg_render` appears alongside the built-in tools.

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

Each call writes (or overwrites) `.opencode/renders/<name>.png` inside the current project and returns the image to the model as an `image/png` attachment.

## Verify it works

After restarting OpenCode, ask:

```text
Create a simple test.svg containing a red circle, then use svg_render to visually inspect it and tell me what you see.
```

Expected: the tool reports something like `test.svg → .opencode/renders/test.png` with dimensions, and the agent describes the red circle — proof the rendered image actually reached the model.

## Requirements

- [OpenCode](https://opencode.ai)
- An image/vision-capable model if you want the model itself to inspect the PNG.

## How it works

```text
SVG → resvg → PNG → OpenCode image attachment → model visual inspection
```

Rendering uses [`@resvg/resvg-js`](https://github.com/thx/resvg-js) — no browser, Chromium, or external rasterizer involved. Paths are confined to the project directory and renders always land in `.opencode/renders/` (git-ignored).

## Scope

v1 intentionally provides only SVG rendering / visual feedback. No SVG validation, optimization, or editing features — your agent already has those tools.

## License

[MIT](LICENSE)
