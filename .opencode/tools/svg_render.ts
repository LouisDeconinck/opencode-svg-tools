import { tool } from "@opencode-ai/plugin"
import { renderAsync } from "@resvg/resvg-js"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_WIDTH = 1600
const DEFAULT_BACKGROUND = "#f2f2f2"

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex").slice(0, 12)

// Locate the root <svg ...> tag, skipping the XML prolog, comments and doctype.
function findRootSvgTag(svg: string): { start: number; end: number } | null {
  let i = 0
  for (;;) {
    while (i < svg.length && /\s/.test(svg[i])) i++
    if (svg.startsWith("<?", i)) {
      const end = svg.indexOf("?>", i + 2)
      if (end === -1) return null
      i = end + 2
    } else if (svg.startsWith("<!--", i)) {
      const end = svg.indexOf("-->", i + 4)
      if (end === -1) return null
      i = end + 3
    } else if (svg.startsWith("<!", i)) {
      const end = svg.indexOf(">", i + 2)
      if (end === -1) return null
      i = end + 1
    } else {
      break
    }
  }
  if (!svg.startsWith("<svg", i)) return null
  let quote = ""
  for (let j = i + 4; j < svg.length; j++) {
    const c = svg[j]
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ">") {
      return { start: i, end: j + 1 }
    }
  }
  return null
}

function getAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
  return m?.[1] ?? m?.[2]
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s)${name}\\s*=\\s*("[^"]*"|'[^']*')`)
  if (re.test(tag)) return tag.replace(re, `$1${name}="${value}"`)
  return tag.replace(/<svg\b/, `<svg ${name}="${value}"`)
}

const parseLength = (v: string | undefined) =>
  v !== undefined && /^\d*\.?\d+(px)?$/i.test(v.trim()) ? parseFloat(v) : undefined

export default tool({
  description:
    "Render an SVG to PNG and return the rendered image for visual inspection. Use this after creating or modifying SVG artwork so you can inspect the actual visual result rather than reasoning only from SVG source code. Re-render after visual changes to verify the final result. Pass a `region` to zoom into part of the SVG's viewBox for close-up inspection. The PNG is also saved under .opencode/renders/.",
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
      .describe("Target PNG width in pixels (default 1600). Height is scaled to preserve the rendered region's aspect ratio."),
    region: tool.schema
      .object({
        x: tool.schema.number().describe("Left edge of the region in SVG viewBox coordinates"),
        y: tool.schema.number().describe("Top edge of the region in SVG viewBox coordinates"),
        width: tool.schema.number().positive().describe("Region width in SVG units"),
        height: tool.schema.number().positive().describe("Region height in SVG units"),
      })
      .optional()
      .describe(
        "Region of the SVG's viewBox to render, in SVG coordinates — the same coordinates used when editing the SVG. The region is scaled up to fill the output image, so it effectively acts as a zoom.",
      ),
    background: tool.schema
      .string()
      .optional()
      .describe(
        "CSS background color drawn behind the artwork, e.g. 'white', '#ffffff' or 'rgba(255,255,255,1)' (default '#f2f2f2' light gray, which keeps both black and white details visible). Pass 'transparent' to preserve alpha when inspecting transparency.",
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
    if (context.abort?.aborted) throw new Error("Render aborted")

    const svgBytes = await readFile(svgPath)
    const sourceSha = sha256(svgBytes)
    let svg = svgBytes.toString("utf8")

    const loc = findRootSvgTag(svg)
    const tag = loc ? svg.slice(loc.start, loc.end) : null

    const rawViewBox = tag ? getAttr(tag, "viewBox")?.trim() : undefined
    let viewBoxText = "unknown"
    if (rawViewBox) {
      viewBoxText = rawViewBox.split(/[\s,]+/).join(" ")
    } else if (tag) {
      const w = parseLength(getAttr(tag, "width"))
      const h = parseLength(getAttr(tag, "height"))
      viewBoxText = w !== undefined && h !== undefined ? `0 0 ${w} ${h}` : "not set"
    }

    if (args.region) {
      if (!loc || !tag) throw new Error("Cannot apply region: no <svg> root element found")
      const { x, y, width: rw, height: rh } = args.region
      let t = setAttr(tag, "viewBox", `${x} ${y} ${rw} ${rh}`)
      t = setAttr(t, "width", `${rw}`)
      t = setAttr(t, "height", `${rh}`)
      svg = svg.slice(0, loc.start) + t + svg.slice(loc.end)
    }

    const background =
      args.background?.trim().toLowerCase() === "transparent"
        ? undefined
        : (args.background ?? DEFAULT_BACKGROUND)

    const rendered = await renderAsync(
      svg,
      {
        fitTo: { mode: "width", value: width },
        ...(background === undefined ? {} : { background }),
        font: { loadSystemFonts: /<(?:[\w.-]+:)?text\b/i.test(svg) },
        shapeRendering: 2,
        textRendering: 1,
        imageRendering: 0,
      },
      context.abort,
    )
    const png = rendered.asPng()
    const pngSha = sha256(png)

    const outName = `${path.basename(svgPath, path.extname(svgPath)) || "render"}.png`
    const pngPath = path.join(root, ".opencode", "renders", outName)
    await mkdir(path.dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)

    const lines = [
      `${args.path} → ${path.relative(root, pngPath)}`,
      `SVG viewBox: ${viewBoxText}`,
      ...(args.region
        ? [`Render region: ${args.region.x} ${args.region.y} ${args.region.width} ${args.region.height}`]
        : []),
      `Output: ${rendered.width}×${rendered.height}`,
      `Source: ${sourceSha}`,
      `PNG: ${pngSha}`,
    ]

    return {
      title: `Rendered ${path.basename(svgPath)}`,
      output: lines.join("\n"),
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: `data:image/png;base64,${png.toString("base64")}`,
          filename: outName,
        },
      ],
      metadata: {
        svg: svgPath,
        png: pngPath,
        width: rendered.width,
        height: rendered.height,
        viewBox: viewBoxText,
        region: args.region ?? null,
        sourceSha256: sourceSha,
        pngSha256: pngSha,
      },
    }
  },
})
