import { tool } from "@opencode-ai/plugin"
import { Resvg } from "@resvg/resvg-js"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_WIDTH = 1600

export default tool({
  description:
    "Render an SVG file to a PNG image and attach it to this tool result so the rendered result can be visually inspected. The PNG is also saved under .opencode/renders/. Use this whenever you create or edit an SVG and need to check what it actually looks like.",
  args: {
    path: tool.schema
      .string()
      .describe("Project-relative path to the SVG file to render, e.g. 'stickers/llama.svg'"),
    width: tool.schema
      .number()
      .int()
      .min(64)
      .max(8192)
      .optional()
      .describe("Target PNG width in pixels (default 1600). Height is scaled to preserve the SVG aspect ratio."),
    background: tool.schema
      .string()
      .optional()
      .describe(
        "CSS background color drawn behind the artwork, e.g. 'white', '#ffffff' or 'rgba(255,255,255,1)'. Omit to preserve transparency.",
      ),
  },
  async execute(args, context) {
    const root = context.directory
    const svgPath = path.resolve(root, args.path)

    const rel = path.relative(root, svgPath)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes the project directory: ${args.path}`)
    }
    if (path.extname(svgPath).toLowerCase() !== ".svg") {
      throw new Error(`Expected an .svg file, got: ${args.path}`)
    }

    const info = await stat(svgPath).catch((e) => {
      if (e?.code === "ENOENT") throw new Error(`SVG file not found: ${args.path}`)
      throw e
    })
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${args.path}`)
    }

    const realRel = path.relative(await realpath(root), await realpath(svgPath))
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Path escapes the project directory: ${args.path}`)
    }

    const width = args.width ?? DEFAULT_WIDTH
    const resvg = new Resvg(await readFile(svgPath, "utf8"), {
      fitTo: { mode: "width", value: width },
      ...(args.background === undefined ? {} : { background: args.background }),
      font: { loadSystemFonts: true },
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    })
    const rendered = resvg.render()
    const png = rendered.asPng()

    const outName = `${path.basename(svgPath, path.extname(svgPath)) || "render"}.png`
    const pngPath = path.join(root, ".opencode", "renders", outName)
    await mkdir(path.dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)

    return {
      title: `Rendered ${path.basename(svgPath)}`,
      output: [
        `${args.path} → ${path.relative(root, pngPath)}`,
        `${rendered.width}×${rendered.height} px (source viewBox ${resvg.width}×${resvg.height}, ${args.background ? `background ${args.background}` : "transparent"})`,
      ].join("\n"),
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: `data:image/png;base64,${png.toString("base64")}`,
          filename: outName,
        },
      ],
      metadata: { svg: svgPath, png: pngPath, width: rendered.width, height: rendered.height },
    }
  },
})
