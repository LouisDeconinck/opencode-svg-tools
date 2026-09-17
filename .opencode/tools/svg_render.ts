import { tool } from "@opencode-ai/plugin"
import { Resvg, renderAsync } from "@resvg/resvg-js"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_WIDTH = 1600
const DEFAULT_BACKGROUND = "#f2f2f2"

// Hard cap on a single render. The environment override exists so the
// verification harness can exercise the timeout without waiting 20s.
const renderTimeoutMs = () => {
  const v = Number(process.env.SVG_RENDER_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 20_000
}

// Safety caps for the expanded-canvas path (see render plan below): keep the
// intermediate pixmap bounded even when artwork sits far outside the canvas.
const MAX_SURFACE_SIDE = 16384
const MAX_SURFACE_PIXELS = 1 << 26 // ~67M px ≈ 268 MB RGBA

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex").slice(0, 12)

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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
const localName = (n: string) => n.slice(n.lastIndexOf(":") + 1)
const r4 = (n: number) => +n.toFixed(4)
const fmtNum = (v: number) => String(Number(v.toPrecision(10)))

// Wrap resvg failures with the project-relative path, plus the offending
// source line when the error carries resvg's 1-based "at <line>:<col>".
function renderError(e: unknown, rel: string, svg: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /at (\d+):(\d+)/.exec(msg)
  const srcLine = m ? svg.split("\n")[Number(m[1]) - 1] : undefined
  const detail = srcLine !== undefined ? `\n  line ${m![1]}: ${srcLine.trim().slice(0, 160)}` : ""
  return new Error(`Failed to render SVG: ${rel}\n${msg}${detail}`)
}

// Index of the unquoted '>' closing the tag that starts at `lt`, or -1.
function scanTagEnd(svg: string, lt: number): number {
  let quote = ""
  for (let j = lt + 1; j < svg.length; j++) {
    const c = svg[j]
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ">") {
      return j
    }
  }
  return -1
}

// clip-path="url(#id)" or style="... clip-path: url(#id) ..." on an element tag.
function clipRefId(tag: string): string | undefined {
  const m =
    getAttr(tag, "clip-path")?.match(/url\(\s*["']?#([^\s"')]+)/) ??
    getAttr(tag, "style")?.match(/clip-path\s*:\s*url\(\s*["']?#([^\s"')]+)/)
  return m?.[1]
}

// Containers whose children never render directly, so a clip-path inside them
// would produce an invisible or misplaced debug outline — skipped entirely.
const DEAD_NAMES = new Set([
  "defs", "symbol", "mask", "pattern", "marker", "clipPath", "linearGradient",
  "radialGradient", "hatch", "solidcolor", "title", "desc", "metadata",
  "foreignObject", "script", "style",
])

interface ClipInfo {
  body: string
  transform?: string
  clip?: string // clipPath's own clip-path attribute
  obb: boolean // clipPathUnits="objectBoundingBox"
}

// One lightweight pass over the markup, driven by the overlay mode:
//   "none"      → locate the root <svg> tag only, then stop
//   "grid"      → + root close offset (for the overlay insertion point)
//   "clip"/"grid+clip" → + clipPath bodies, usages and ancestor transforms
function scanSvg(svg: string, mode: string) {
  const wantClips = mode === "clip" || mode === "grid+clip"
  const deep = mode !== "none"
  const clipPaths = new Map<string, ClipInfo>()
  const usages: { clipId: string; chain: string[] }[] = []
  interface Open {
    name: string
    contentStart: number
    transform?: string
    clipId?: string
    dead: boolean
    viewport: boolean // inside a nested <svg> viewport (see below)
    cp?: ClipInfo & { id?: string }
  }
  const stack: Open[] = []
  let root: { start: number; end: number; tag: string; selfClose: boolean } | null = null
  let rootCloseStart = -1
  let viewportSkipped = 0
  let i = 0
  while (i < svg.length) {
    const lt = svg.indexOf("<", i)
    if (lt === -1) break
    const c1 = svg[lt + 1]
    if (c1 === "?") {
      const e = svg.indexOf("?>", lt + 2)
      if (e === -1) break
      i = e + 2
      continue
    }
    if (c1 === "!") {
      const [, close, skip] = svg.startsWith("!--", lt)
        ? ["<!--", "-->", 4]
        : svg.startsWith("![CDATA[", lt)
          ? ["<![CDATA[", "]]>", 9]
          : ["<!", ">", 2]
      const e = svg.indexOf(close, lt + skip)
      if (e === -1) break
      i = e + close.length
      continue
    }
    const gt = scanTagEnd(svg, lt)
    if (gt === -1) break
    const tag = svg.slice(lt, gt + 1)
    i = gt + 1
    if (c1 === "/") {
      const name = localName(tag.slice(2, -1).trim().split(/\s/)[0] ?? "")
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name !== name) continue
        const el = stack[k]
        if (name === "clipPath" && el.cp?.id && !clipPaths.has(el.cp.id)) {
          el.cp.body = svg.slice(el.contentStart, lt)
          clipPaths.set(el.cp.id, el.cp)
        }
        if (el.clipId && !el.dead && !(k === 0 && name === "svg")) {
          if (el.viewport) {
            viewportSkipped++
          } else {
            const chain: string[] = []
            for (let j = 0; j <= k; j++) if (stack[j].transform) chain.push(stack[j].transform!)
            usages.push({ clipId: el.clipId, chain })
          }
        }
        if (k === 0 && name === "svg") rootCloseStart = lt
        stack.length = k
        break
      }
      continue
    }
    const m = /^<([^\s/>]+)/.exec(tag)
    if (!m) continue
    const name = localName(m[1])
    const selfClose = /\/\s*>$/.test(tag)
    if (!root && name === "svg" && stack.length === 0) {
      root = { start: lt, end: gt + 1, tag, selfClose }
      if (!deep) break
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined
    const dead = (parent?.dead ?? false) || DEAD_NAMES.has(name)
    // A nested <svg> establishes a viewport (x/y/width/height/viewBox) that an
    // ancestor-transform chain cannot represent, so any clip usage there would
    // be outlined in the wrong place. Mark the nested <svg> element itself and
    // its descendants, then skip those usages instead of drawing them wrong.
    const viewport = (parent?.viewport ?? false) || (name === "svg" && stack.length > 0)
    if (!wantClips) {
      if (!selfClose) stack.push({ name, contentStart: gt + 1, dead, viewport })
      continue
    }
    const transform = getAttr(tag, "transform")
    if (name === "clipPath") {
      const cp: ClipInfo & { id?: string } = {
        id: getAttr(tag, "id"),
        body: "",
        transform,
        clip: getAttr(tag, "clip-path"),
        obb: getAttr(tag, "clipPathUnits") === "objectBoundingBox",
      }
      if (selfClose) {
        if (cp.id && !clipPaths.has(cp.id)) clipPaths.set(cp.id, cp)
      } else {
        stack.push({ name, contentStart: gt + 1, transform, clipId: clipRefId(tag), dead, viewport, cp })
      }
      continue
    }
    const clipId = clipRefId(tag)
    if (selfClose) {
      if (clipId && !dead && !(name === "svg" && stack.length === 0)) {
        if (viewport) {
          viewportSkipped++
        } else {
          const chain = stack.filter((e) => e.transform).map((e) => e.transform!)
          if (transform) chain.push(transform)
          usages.push({ clipId, chain })
        }
      }
    } else {
      stack.push({ name, contentStart: gt + 1, transform, clipId, dead, viewport })
    }
  }
  return { root, rootCloseStart, clipPaths, usages, viewportSkipped }
}

// Paint/visibility attributes that would defeat the debug style — removed from
// copied clip geometry. transform, id, href and geometry attributes are kept.
const STRIP_ATTRS =
  /\s(?:fill|fill-opacity|stroke|stroke-width|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-opacity|opacity|display|visibility|style|class|clip-path|mask|filter|color|paint-order|mix-blend-mode)\s*=\s*("[^"]*"|'[^']*')/g

function stripPaintAttrs(fragment: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const lt = fragment.indexOf("<", i)
    if (lt === -1) {
      out += fragment.slice(i)
      break
    }
    const c1 = fragment[lt + 1]
    if (c1 === "?" || c1 === "!") {
      const close = c1 === "?" ? "?>" : fragment.startsWith("!--", lt) ? "-->" : fragment.startsWith("![CDATA[", lt) ? "]]>" : ">"
      const e = fragment.indexOf(close, lt + 2)
      if (e === -1) {
        out += fragment.slice(i)
        break
      }
      out += fragment.slice(i, e + close.length)
      i = e + close.length
      continue
    }
    const gt = scanTagEnd(fragment, lt)
    if (gt === -1) {
      out += fragment.slice(i)
      break
    }
    let tag = fragment.slice(lt, gt + 1)
    if (c1 !== "/") tag = tag.replace(STRIP_ATTRS, "")
    out += fragment.slice(i, lt) + tag
    i = gt + 1
  }
  return out
}

// Smallest of 1/2/5×10^n closest to `approx` — grid major spacing.
function niceStep(approx: number): number {
  const mag = 10 ** Math.floor(Math.log10(approx))
  let best = mag
  let bestD = Infinity
  for (const m of [1, 2, 5, 10]) {
    const d = Math.abs(Math.log10((m * mag) / approx))
    if (d < bestD) {
      bestD = d
      best = m * mag
    }
  }
  return best
}

interface Space {
  x: number
  y: number
  w: number
  h: number
}

// Coordinate grid in SVG user space. `u` = user units per output pixel, so
// strokes/labels keep a constant on-screen size at any zoom level.
function gridMarkup(sp: Space, u: number): string {
  const fs = 28 * u
  const minor: string[] = []
  const major: string[] = []
  const labels: string[] = []
  const axes: [number, number, number, boolean][] = [
    [sp.x, sp.w, niceStep(sp.w / 8), true],
    [sp.y, sp.h, niceStep(sp.h / 8), false],
  ]
  for (const [off, span, step, vert] of axes) {
    const lo = off
    const hi = off + span
    const sub = step / 5
    for (let n = Math.ceil(lo / sub - 1e-9); n * sub <= hi + 1e-9; n++) {
      const v = r4(n * sub)
      if (Math.abs(v / step - Math.round(v / step)) > 1e-4) {
        minor.push(vert ? `M${v} ${r4(sp.y)}V${r4(sp.y + sp.h)}` : `M${r4(sp.x)} ${v}H${r4(sp.x + sp.w)}`)
      }
    }
    for (let n = Math.ceil(lo / step - 1e-9); n * step <= hi + 1e-9; n++) {
      const v = r4(n * step)
      major.push(vert ? `M${v} ${r4(sp.y)}V${r4(sp.y + sp.h)}` : `M${r4(sp.x)} ${v}H${r4(sp.x + sp.w)}`)
      const s = fmtNum(v)
      if (vert) {
        const end = v + 0.3 * fs + s.length * 0.62 * fs > sp.x + sp.w
        labels.push(
          `<text x="${r4(end ? v - 0.3 * fs : v + 0.3 * fs)}" y="${r4(sp.y + 1.15 * fs)}"${end ? ' text-anchor="end"' : ""}>${s}</text>`,
        )
      } else {
        const below = v - 1.3 * fs < sp.y
        labels.push(`<text x="${r4(sp.x + 0.3 * fs)}" y="${r4(below ? v + 0.95 * fs : v - 0.25 * fs)}">${s}</text>`)
      }
    }
  }
  return (
    `<g fill="none" font-family="monospace">` +
    `<path d="${minor.join("")}" stroke="rgba(37,99,235,0.16)" stroke-width="${r4(u)}"/>` +
    `<path d="${major.join("")}" stroke="rgba(37,99,235,0.45)" stroke-width="${r4(1.5 * u)}"/>` +
    `<g font-size="${r4(fs)}" fill="#1d4fd7" stroke="rgba(255,255,255,0.85)" stroke-width="${r4(3 * u)}" stroke-linejoin="round" paint-order="stroke">${labels.join("")}</g></g>`
  )
}

export default tool({
  description:
    "Render an SVG to PNG and return the rendered image for visual inspection. Use this after creating or modifying SVG artwork so you can inspect the actual visual result rather than reasoning only from SVG source code. Re-render after visual changes to verify the final result. Pass `region` to zoom into part of the SVG's viewBox for close-up inspection, and `overlay` to draw a coordinate grid or clip-path outlines into the diagnostic image. The PNG is also saved under .opencode/renders/. For structural questions (element ids, element bounds, validation) use the svg_inspect tool instead of guessing coordinates from source.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Path to the SVG file, resolved relative to the project directory OpenCode is running in (context.directory) — not relative to .opencode/. Example: 'stickers/llama.svg'.",
      ),
    width: tool.schema
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe("Target PNG width in pixels (default 1600, max 4096 — vision models downscale larger images anyway, so prefer `region` over huge widths). Height is scaled to preserve the rendered region's aspect ratio."),
    region: tool.schema
      .object({
        x: tool.schema.number().describe("Left edge of the region in SVG viewBox coordinates"),
        y: tool.schema.number().describe("Top edge of the region in SVG viewBox coordinates"),
        width: tool.schema.number().positive().describe("Region width in SVG units"),
        height: tool.schema.number().positive().describe("Region height in SVG units"),
      })
      .optional()
      .describe(
        "Region of the SVG's viewBox to render, in SVG coordinates — the same coordinates used when editing the SVG. The region is scaled up to fill the output image, so it effectively acts as a zoom. It may extend past the viewBox (empty area renders as background).",
      ),
    background: tool.schema
      .string()
      .optional()
      .describe(
        "Backdrop behind the artwork (default 'checker' — a subtle transparency checkerboard that keeps black and white details visible while making alpha visually explicit). Other presets: 'neutral' = #f2f2f2 light gray; 'transparent' = real PNG alpha. Any other value is treated as a CSS color, e.g. 'white', '#ffffff', 'rgba(255,255,255,0.5)'.",
      ),
    overlay: tool.schema
      .enum(["none", "grid", "clip", "grid+clip"])
      .optional()
      .describe(
        "Diagnostic overlay drawn on top of the render (default 'none'). 'grid' adds labeled SVG-coordinate grid lines for placement reasoning. 'clip' outlines clipPath boundaries (dashed magenta) so clipped-away content is explainable. 'grid+clip' draws both. Overlays never modify the source SVG.",
      ),
  },
  async execute(args, context) {
    const t0 = performance.now()
    const times: Record<string, number> = {}
    let tPrev = t0
    // Accumulate wall time per phase; phases may interleave with awaits.
    const mark = (name: string) => {
      const now = performance.now()
      times[name] = (times[name] ?? 0) + (now - tPrev)
      tPrev = now
    }

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
    mark("validate")

    const width = args.width ?? DEFAULT_WIDTH
    const overlay = args.overlay ?? "none"
    if (context.abort?.aborted) throw new Error("Render aborted")

    const svgBytes = await readFile(svgPath)
    const sourceSha = sha256(svgBytes)
    let svg = svgBytes.toString("utf8")
    mark("read")

    const wantGrid = overlay === "grid" || overlay === "grid+clip"
    const wantClip = overlay === "clip" || overlay === "grid+clip"
    const scan = scanSvg(svg, overlay)

    const rawViewBox = scan.root ? getAttr(scan.root.tag, "viewBox")?.trim() : undefined
    const vbNums = rawViewBox?.split(/[\s,]+/).filter(Boolean).map(Number)
    const viewBox: Space | undefined =
      vbNums && vbNums.length === 4 && vbNums.every(Number.isFinite)
        ? { x: vbNums[0], y: vbNums[1], w: vbNums[2], h: vbNums[3] }
        : undefined
    const rootW = scan.root ? parseLength(getAttr(scan.root.tag, "width")) : undefined
    const rootH = scan.root ? parseLength(getAttr(scan.root.tag, "height")) : undefined
    const viewBoxText = rawViewBox
      ? rawViewBox.split(/[\s,]+/).filter(Boolean).join(" ")
      : scan.root
        ? rootW !== undefined && rootH !== undefined
          ? `0 0 ${rootW} ${rootH} (from width/height, no viewBox)`
          : "not set"
        : "unknown"

    const edits: { start: number; end: number; text: string }[] = []

    let newRootTag: string | null = null
    if (args.region) {
      if (!scan.root) throw new Error("Cannot apply region: no <svg> root element found")
      const { x, y, width: rw, height: rh } = args.region
      if (![x, y, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) {
        throw new Error(`Invalid region: x/y/width/height must be finite and width/height > 0, got ${x} ${y} ${rw} ${rh}`)
      }
      newRootTag = setAttr(setAttr(setAttr(scan.root.tag, "viewBox", `${x} ${y} ${rw} ${rh}`), "width", `${rw}`), "height", `${rh}`)
    }

    // Coordinate space the overlays are drawn in: the rendered region.
    const space: Space | undefined = args.region
      ? { x: args.region.x, y: args.region.y, w: args.region.width, h: args.region.height }
      : (viewBox ?? (rootW !== undefined && rootH !== undefined ? { x: 0, y: 0, w: rootW, h: rootH } : undefined))
    const u = space ? space.w / width : 1

    const tail: string[] = []
    let clipNote = ""
    if (wantGrid) {
      if (!space) {
        throw new Error(
          `overlay "grid" needs SVG coordinates to label: the SVG has no viewBox/width/height. Pass an explicit region or add a viewBox.`,
        )
      }
      tail.push(gridMarkup(space, u))
    }
    if (wantClip) {
      const outlines: string[] = []
      let obb = 0
      let missing = 0
      for (const use of scan.usages) {
        const cp = scan.clipPaths.get(use.clipId)
        if (!cp) {
          missing++
          continue
        }
        if (cp.obb) {
          obb++
          continue
        }
        if (!cp.body.trim()) continue
        const chain = [...use.chain, cp.transform].filter(Boolean).join(" ")
        outlines.push(
          `<g${chain ? ` transform="${esc(chain)}"` : ""}${cp.clip ? ` clip-path="${esc(cp.clip)}"` : ""}>` +
            `<g fill="rgba(255,45,120,0.08)" stroke="#ff2d78" stroke-width="${r4(2.2 * u)}" stroke-dasharray="${r4(7 * u)} ${r4(4.5 * u)}" stroke-linejoin="round">` +
            stripPaintAttrs(cp.body) +
            `</g></g>`,
        )
      }
      tail.push(...outlines)
      const bits = [`${outlines.length} outlined`]
      if (scan.viewportSkipped)
        bits.push(`${scan.viewportSkipped} nested SVG usage${scan.viewportSkipped > 1 ? "s" : ""} skipped`)
      if (obb) bits.push(`${obb} objectBoundingBox clip path${obb > 1 ? "s" : ""} skipped`)
      if (missing) bits.push(`${missing} unresolved reference${missing > 1 ? "s" : ""}`)
      if (scan.usages.length === 0 && scan.clipPaths.size === 0) bits[0] = "no clip paths found"
      clipNote = ` (clip: ${bits.join(", ")})`
    }
    if (tail.length && scan.root?.selfClose) {
      // splice the self-closing '/' out of the (possibly region-rewritten) tag:
      // <svg .../> → <svg ...>tail</svg>
      const t = newRootTag ?? scan.root.tag
      let j = t.length - 2
      while (j > 0 && t[j] !== "/") j--
      newRootTag = t.slice(0, j) + `>${tail.join("")}</svg>`
    } else if (tail.length && scan.rootCloseStart !== -1) {
      edits.push({ start: scan.rootCloseStart, end: scan.rootCloseStart, text: tail.join("") })
    }
    if (newRootTag !== null && scan.root) {
      edits.push({ start: scan.root.start, end: scan.root.end, text: newRootTag })
    }

    edits.sort((a, b) => b.start - a.start)
    for (const e of edits) svg = svg.slice(0, e.start) + e.text + svg.slice(e.end)
    mark("prepare")

    // --- render plan ---------------------------------------------------------
    // resvg-js 2.x contains a known upstream panic (fixed in resvg main, not
    // yet released): elements that need a raster layer — opacity, filters,
    // masks, clip-paths, strokes, markers, <use> — abort the whole process
    // when they lie completely outside the rendered viewBox. The abort is a
    // native SIGABRT: it cannot be caught from JS, so the only safe fix is to
    // never render a canvas that leaves artwork outside. Compute the document
    // bbox and, when it extends past the requested canvas, render an expanded
    // viewBox that covers everything, then crop the pixmap back to the canvas.
    const canvas = space // user units: region ?? viewBox ?? intrinsic size
    let fitTo: { mode: "width"; value: number } | { mode: "zoom"; value: number } = {
      mode: "width",
      value: width,
    }
    let crop: { left: number; top: number; right: number; bottom: number } | undefined
    let renderSpace = canvas
    let zoom = canvas ? width / canvas.w : 1 // output px per user unit
    let degraded = false
    if (canvas && scan.root) {
      let bbox: { x: number; y: number; width: number; height: number } | undefined
      try {
        bbox = new Resvg(svg, { font: { loadSystemFonts: false } }).getBBox()
      } catch (e) {
        throw renderError(e, args.path, svg)
      }
      if (
        bbox &&
        [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) &&
        !(
          bbox.x >= canvas.x - 1e-6 &&
          bbox.y >= canvas.y - 1e-6 &&
          bbox.x + bbox.width <= canvas.x + canvas.w + 1e-6 &&
          bbox.y + bbox.height <= canvas.y + canvas.h + 1e-6
        )
      ) {
        const ex = Math.min(canvas.x, bbox.x)
        const ey = Math.min(canvas.y, bbox.y)
        const ew = Math.max(canvas.x + canvas.w, bbox.x + bbox.width) - ex
        const eh = Math.max(canvas.y + canvas.h, bbox.y + bbox.height) - ey
        const E = { x: ex, y: ey, w: ew, h: eh }
        const zCap = Math.min(
          MAX_SURFACE_SIDE / E.w,
          MAX_SURFACE_SIDE / E.h,
          Math.sqrt(MAX_SURFACE_PIXELS / (E.w * E.h)),
        )
        if (zoom > zCap) {
          zoom = zCap
          degraded = true
        }
        const lt2 = scan.root.start
        const gt2 = scanTagEnd(svg, lt2)
        const tag = setAttr(
          setAttr(
            setAttr(svg.slice(lt2, gt2 + 1), "viewBox", `${fmtNum(E.x)} ${fmtNum(E.y)} ${fmtNum(E.w)} ${fmtNum(E.h)}`),
            "width",
            fmtNum(E.w),
          ),
          "height",
          fmtNum(E.h),
        )
        svg = svg.slice(0, lt2) + tag + svg.slice(gt2 + 1)
        renderSpace = E
        fitTo = { mode: "zoom", value: zoom }
        const pw = Math.max(1, Math.round(E.w * zoom))
        const ph = Math.max(1, Math.round(E.h * zoom))
        const cl = Math.min(pw, Math.max(0, Math.round((canvas.x - E.x) * zoom)))
        const ct = Math.min(ph, Math.max(0, Math.round((canvas.y - E.y) * zoom)))
        crop = {
          left: cl,
          top: ct,
          right: Math.min(pw, Math.max(cl + 1, Math.round((canvas.x - E.x + canvas.w) * zoom))),
          bottom: Math.min(ph, Math.max(ct + 1, Math.round((canvas.y - E.y + canvas.h) * zoom))),
        }
      }
    }
    mark("inspect")

    // --- background -----------------------------------------------------------
    const bgArg = args.background?.trim()
    const bgLower = bgArg?.toLowerCase()
    const wantChecker = bgLower === "checker" || bgArg === undefined // checker is the default
    let background: string | undefined
    let backgroundLabel: string
    if (wantChecker && renderSpace && scan.root) {
      // Diagnostic checkerboard injected into the in-memory copy only (the
      // source file is untouched). The pattern tile is sized in user units so
      // cells stay ~10 output px at any zoom level.
      const cell = r4(10 / zoom)
      const tile = r4(2 * cell)
      const lt2 = scan.root.start
      const gt2 = scanTagEnd(svg, lt2)
      svg =
        svg.slice(0, gt2 + 1) +
        `<pattern id="__svg_render_bg" patternUnits="userSpaceOnUse" x="${r4(renderSpace.x)}" y="${r4(renderSpace.y)}" width="${tile}" height="${tile}"><rect width="${tile}" height="${tile}" fill="#eeeeee"/><rect width="${cell}" height="${cell}" fill="#dcdcdc"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#dcdcdc"/></pattern>` +
        `<rect x="${r4(renderSpace.x)}" y="${r4(renderSpace.y)}" width="${r4(renderSpace.w)}" height="${r4(renderSpace.h)}" fill="url(#__svg_render_bg)"/>` +
        svg.slice(gt2 + 1)
      backgroundLabel = `checker${bgArg === undefined ? " (default)" : ""}`
    } else if (bgLower === "transparent") {
      background = undefined
      backgroundLabel = "transparent"
    } else if (wantChecker) {
      background = DEFAULT_BACKGROUND // no coordinate space to tile in
      backgroundLabel = `checker→${DEFAULT_BACKGROUND} (no viewBox/region)`
    } else if (bgLower === "neutral") {
      background = DEFAULT_BACKGROUND
      backgroundLabel = `neutral ${DEFAULT_BACKGROUND}`
    } else {
      background = bgArg!
      backgroundLabel = bgArg!
    }
    mark("background")

    // --- render with hard timeout ----------------------------------------------
    const timeoutMs = renderTimeoutMs()
    const ctrl = new AbortController()
    let timedOut = false
    const onUserAbort = () => ctrl.abort()
    context.abort?.addEventListener("abort", onUserAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    timer.unref?.()

    // resvg-js can strand the returned promise when the abort lands as the
    // native work finishes: the JS side then never settles and a bare `await`
    // would hang forever. Once our signal fires, give resvg a short grace
    // period to reject, then stop waiting either way.
    const GAVE_UP = "__svg_render_gave_up__"
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<never>((_, rej) => {
      ctrl.signal.addEventListener(
        "abort",
        () => {
          graceTimer = setTimeout(() => rej(new Error(GAVE_UP)), 1500)
          graceTimer.unref?.()
        },
        { once: true },
      )
    })

    let rendered: { asPng(): Buffer; width: number; height: number }
    try {
      const renderP = renderAsync(
        svg,
        {
          fitTo,
          ...(crop ? { crop } : {}),
          ...(background === undefined ? {} : { background }),
          font: { loadSystemFonts: /<(?:[\w.-]+:)?text\b/i.test(svg) },
          shapeRendering: 2,
          textRendering: 1,
          imageRendering: 0,
        },
        ctrl.signal,
      )
      renderP.catch(() => {}) // settle listener for a wedged/late rejection
      rendered = await Promise.race([renderP, gaveUp])
    } catch (e) {
      if (timedOut) {
        const t = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
        throw new Error(
          `SVG render timed out after ${t}.\n\n` +
            `Try:\n` +
            `- render the region without an overlay\n` +
            `- render the full view with grid to locate coordinates first\n` +
            `- use a slightly larger region`,
        )
      }
      if ((e as Error)?.message === GAVE_UP || ctrl.signal.aborted || context.abort?.aborted) {
        throw new Error("Render aborted")
      }
      throw renderError(e, args.path, svg)
    } finally {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      context.abort?.removeEventListener("abort", onUserAbort)
    }
    mark("render")

    const png = rendered.asPng()
    mark("png")
    const pngSha = sha256(png)

    const outName = `${path.basename(svgPath, path.extname(svgPath)) || "render"}.png`
    const pngPath = path.join(root, ".opencode", "renders", outName)
    await mkdir(path.dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)
    mark("write")

    const b64 = png.toString("base64")
    mark("base64")
    times.total = performance.now() - t0

    const timingParts = (["inspect", "prepare", "render", "png", "write", "base64"] as const)
      .filter((k) => (times[k] ?? 0) >= 1)
      .map((k) => `${k} ${Math.round(times[k])}`)
      .join(", ")

    const lines = [
      `${args.path} → ${path.relative(root, pngPath)}`,
      `SVG viewBox: ${viewBoxText}`,
      `Render region: ${args.region ? `${args.region.x} ${args.region.y} ${args.region.width} ${args.region.height}` : "full viewBox"}`,
      ...(overlay !== "none" ? [`Overlay: ${overlay}${clipNote}`] : []),
      `Output: ${rendered.width}×${rendered.height} px${degraded ? " (resolution reduced: surface caps)" : ""}`,
      `Background: ${backgroundLabel}`,
      `Source: ${sourceSha}`,
      `PNG: ${pngSha}`,
      `Timing: ${Math.round(times.total)} ms total${timingParts ? ` — ${timingParts}` : ""}`,
    ]

    return {
      title: `Rendered ${path.basename(svgPath)}`,
      output: lines.join("\n"),
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: `data:image/png;base64,${b64}`,
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
        overlay,
        sourceSha256: sourceSha,
        pngSha256: pngSha,
        timing: times,
      },
    }
  },
})
