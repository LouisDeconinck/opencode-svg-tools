import { tool } from "@opencode-ai/plugin"
import { Resvg, renderAsync } from "@resvg/resvg-js"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"

const DEFAULT_WIDTH = 800
const DEFAULT_BACKGROUND = "#f2f2f2"

const renderTimeoutMs = () => {
  const v = Number(process.env.SVG_RENDER_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 20_000
}

// Same surface caps as svg_render's expanded-canvas path.
const MAX_SURFACE_SIDE = 16384
const MAX_SURFACE_PIXELS = 1 << 25

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
const fmt = (n: number) => String(+n.toFixed(2))

interface Box {
  x: number
  y: number
  w: number
  h: number
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

interface RootEl {
  start: number // offset of '<' of the root <svg> tag
  tagEnd: number // just after '>' of the start tag
  closeStart: number // offset of '<' of the matching </svg> (== tagEnd when self-closing)
  end: number // just after the root element
  tag: string
  selfClose: boolean
}

// Locate the root <svg> element's full span, tracking nesting depth so a
// nested <svg> doesn't end the search early.
function findRootElement(svg: string): RootEl | null {
  const stack: string[] = []
  let root: RootEl | null = null
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
        if (stack[k] !== name) continue
        stack.length = k
        if (root && name === "svg" && stack.length === 0) {
          root.closeStart = lt
          root.end = gt + 1
          return root
        }
        break
      }
      continue
    }
    const m = /^<([^\s/>]+)/.exec(tag)
    if (!m) continue
    const name = localName(m[1])
    const selfClose = /\/\s*>$/.test(tag)
    if (!root && name === "svg" && stack.length === 0) {
      root = { start: lt, tagEnd: gt + 1, closeStart: gt + 1, end: gt + 1, tag, selfClose }
      if (selfClose) return root
    }
    if (!selfClose) stack.push(name)
  }
  return root
}

// Coordinate space of a document: viewBox, else width/height, else the
// document's own geometric bbox as a last resort.
function docSpace(svg: string, rootTag: string): { space: Box; source: string } {
  const vb = getAttr(rootTag, "viewBox")?.trim().split(/[\s,]+/).filter(Boolean).map(Number)
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    return { space: { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }, source: "viewBox" }
  }
  const w = parseLength(getAttr(rootTag, "width"))
  const h = parseLength(getAttr(rootTag, "height"))
  if (w !== undefined && h !== undefined && w > 0 && h > 0) {
    return { space: { x: 0, y: 0, w, h }, source: "width/height" }
  }
  const hasText = /<(?:[\w.-]+:)?text\b/i.test(svg)
  const bbox = new Resvg(svg, { font: { loadSystemFonts: hasText } }).getBBox()
  if (bbox && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) && bbox.width > 0 && bbox.height > 0) {
    return { space: { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height }, source: "document bounds (no viewBox/width/height)" }
  }
  throw new Error("Cannot determine the SVG's coordinate space (no viewBox, no width/height, empty bounds)")
}

// Prefix every id in a fragment so two documents embedded into one wrapper
// cannot collide: `id="x"`, `url(#x)`, `href="#x"` and `#x` selectors inside
// <style> are rewritten together. (SMIL `begin="x.click"`-style references and
// CSS attribute selectors like `[href="#x"]` are not rewritten — rare in
// artwork.)
function renamespaceIds(fragment: string, prefix: string): string {
  const ids = new Set<string>()
  for (const m of fragment.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) ids.add(m[1] ?? m[2])
  if (!ids.size) return fragment
  let out = fragment
  for (const id of ids) {
    const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out
      .replace(new RegExp(`(\\sid\\s*=\\s*")${e}"`, "g"), `$1${prefix}${id}"`)
      .replace(new RegExp(`(\\sid\\s*=\\s*')${e}'`, "g"), `$1${prefix}${id}'`)
      .replace(new RegExp(`url\\(\\s*(['"]?)#${e}\\1\\s*\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`(\\s(?:xlink:)?href\\s*=\\s*")#${e}"`, "g"), `$1#${prefix}${id}"`)
      .replace(new RegExp(`(\\s(?:xlink:)?href\\s*=\\s*')#${e}'`, "g"), `$1#${prefix}${id}'`)
  }
  // <style> bodies: `#id` tokens are rewritten only in selector preludes —
  // never inside { ... } declaration blocks, where `#fff` is a hex color, not
  // a selector (a document can legally have id="fff"). At-rule groups like
  // @media contain nested rules whose preludes are still rewritten; comments
  // and quoted strings pass through verbatim. Bounded so #wool does not match
  // #wool2. (Declaration values don't need rewriting — url(#id) and href are
  // already handled above; attribute selectors like [href="#x"] are not.)
  const rewritePrelude = (p: string) => {
    for (const id of ids) {
      const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      p = p.replace(new RegExp(`#${e}(?![\\w-])`, "g"), `#${prefix}${id}`)
    }
    return p
  }
  const rewriteStyleBody = (body: string) => {
    let out = ""
    let i = 0
    let segStart = 0
    let prelude = true // current context accepts selector rewriting
    const decl: boolean[] = [] // stack: true = inside a declaration block
    while (i < body.length) {
      const c = body[i]
      if (body.startsWith("/*", i) || c === '"' || c === "'") {
        if (prelude) out += rewritePrelude(body.slice(segStart, i))
        else out += body.slice(segStart, i)
        let j: number
        if (c === "/") {
          j = body.indexOf("*/", i + 2)
          j = j === -1 ? body.length : j + 2
        } else {
          j = i + 1
          while (j < body.length && body[j] !== c) {
            if (body[j] === "\\") j++
            j++
          }
          j = Math.min(body.length, j + 1)
        }
        out += body.slice(i, j)
        i = segStart = j
        continue
      }
      if (c === "{") {
        // Only rule-grouping at-rules switch back to prelude mode inside;
        // @font-face/@page/@keyframes blocks hold declarations, not selectors.
        const isGroup = /^@(media|supports|layer|scope|container|starting-style)\b/i.test(
          body.slice(segStart, i).trimStart(),
        )
        out += (prelude ? rewritePrelude(body.slice(segStart, i)) : body.slice(segStart, i)) + "{"
        decl.push(!isGroup)
        prelude = isGroup
        i++
        segStart = i
        continue
      }
      if (c === "}") {
        out += (prelude ? rewritePrelude(body.slice(segStart, i)) : body.slice(segStart, i)) + "}"
        decl.pop()
        prelude = !(decl[decl.length - 1] ?? false)
        i++
        segStart = i
        continue
      }
      i++
    }
    out += prelude ? rewritePrelude(body.slice(segStart)) : body.slice(segStart)
    return out
  }
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, body: string, close: string) => open + rewriteStyleBody(body) + close)
  return out
}

// Re-emit a document's root <svg> as a nested element pinned to `cell`. Its
// own viewBox is kept so the content scales into the cell (xMidYMid meet
// letterboxes if the aspect differs); without a viewBox one is synthesized
// from the resolved space so the mapping stays 1:1.
function embedSvg(svg: string, root: RootEl, space: Box, cell: Box): string {
  let tag = root.tag
  tag = setAttr(tag, "x", fmtNum(cell.x))
  tag = setAttr(tag, "y", fmtNum(cell.y))
  tag = setAttr(tag, "width", fmtNum(cell.w))
  tag = setAttr(tag, "height", fmtNum(cell.h))
  if (!getAttr(tag, "viewBox")) {
    tag = setAttr(tag, "viewBox", `${fmtNum(space.x)} ${fmtNum(space.y)} ${fmtNum(space.w)} ${fmtNum(space.h)}`)
  }
  const inner = root.selfClose ? "" : svg.slice(root.tagEnd, root.closeStart)
  return tag.replace(/\/\s*>$/, ">") + inner + "</svg>"
}

// The resvg-js 2.x layer panic (see svg_render): elements needing a raster
// layer abort the host process when fully outside the rendered viewBox.
// Embedded documents can drag content off-canvas, so render the wrapper with
// the same expand-then-crop plan: if the document bbox exceeds the requested
// canvas, temporarily widen the viewBox to cover it and crop the pixmap back.
async function renderFitted(
  svg: string,
  canvas: Box,
  width: number,
  background: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ pixels: Buffer; png: Buffer; w: number; h: number; degraded: boolean }> {
  const hasText = /<(?:[\w.-]+:)?text\b/i.test(svg)
  let s = svg
  let fitTo: { mode: "width"; value: number } | { mode: "zoom"; value: number } = { mode: "width", value: width }
  let crop: { left: number; top: number; right: number; bottom: number } | undefined
  let zoom = width / canvas.w
  let degraded = false
  let bbox: Box | undefined
  try {
    const b = new Resvg(s, { font: { loadSystemFonts: hasText } }).getBBox()
    if (b) bbox = { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    bbox = undefined
  }
  if (
    bbox &&
    [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite) &&
    !(
      bbox.x >= canvas.x - 1e-6 &&
      bbox.y >= canvas.y - 1e-6 &&
      bbox.x + bbox.w <= canvas.x + canvas.w + 1e-6 &&
      bbox.y + bbox.h <= canvas.y + canvas.h + 1e-6
    )
  ) {
    const ex = Math.min(canvas.x, bbox.x)
    const ey = Math.min(canvas.y, bbox.y)
    const ew = Math.max(canvas.x + canvas.w, bbox.x + bbox.w) - ex
    const eh = Math.max(canvas.y + canvas.h, bbox.y + bbox.h) - ey
    const E = { x: ex, y: ey, w: ew, h: eh }
    const zCap = Math.min(MAX_SURFACE_SIDE / E.w, MAX_SURFACE_SIDE / E.h, Math.sqrt(MAX_SURFACE_PIXELS / (E.w * E.h)))
    if (zoom > zCap) {
      zoom = zCap
      degraded = true
    }
    const lt = s.indexOf("<svg")
    if (lt === -1) throw new Error("wrapper lost its root <svg> tag")
    const gt = scanTagEnd(s, lt)
    const tag = setAttr(
      setAttr(
        setAttr(s.slice(lt, gt + 1), "viewBox", `${fmtNum(E.x)} ${fmtNum(E.y)} ${fmtNum(E.w)} ${fmtNum(E.h)}`),
        "width",
        fmtNum(E.w),
      ),
      "height",
      fmtNum(E.h),
    )
    s = s.slice(0, lt) + tag + s.slice(gt + 1)
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

  const rendered = await renderAsync(
    s,
    {
      fitTo,
      ...(crop ? { crop } : {}),
      ...(background === undefined ? {} : { background }),
      font: { loadSystemFonts: hasText },
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    },
    signal,
  )
  const png = rendered.asPng()
  return { pixels: rendered.pixels, png, w: rendered.width, h: rendered.height, degraded }
}

// --- minimal PNG encoder (8-bit RGBA, filter 0) for the diff image ------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0
    rgba.copy(raw, row + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

// Composite a resvg pixel over white. resvg emits PREMULTIPLIED RGBA
// (a 50% red pixel is 128,0,0,128), so over-white is c + 255 - a.
const overWhite = (px: Buffer, o: number): [number, number, number] => {
  const w = 255 - px[o + 3]
  return [
    Math.min(255, px[o] + w),
    Math.min(255, px[o + 1] + w),
    Math.min(255, px[o + 2] + w),
  ]
}

export default tool({
  description:
    "Compare two SVG files visually by rendering them into a single image: 'side-by-side' places them next to each other at equal display height, 'overlay' draws the right file on top of the left as a translucent magenta ghost (onion skin — matching shapes blend away, diverging shapes show doubled edges), and 'difference' pixel-diffs both renders (premultiplied RGB + alpha, so transparency-only changes count) and reports differing pixels with their region in SVG coordinates. Overlay and difference fit the right file into the left file's coordinate space, so files sharing a viewBox align exactly. Use this to check whether an edit matched a reference, whether two paths coincide, or where two versions diverge — instead of eyeballing two separate renders.",
  args: {
    left: tool.schema
      .string()
      .describe("Path to the first SVG, resolved relative to the project directory (context.directory). Drawn on the left / underneath."),
    right: tool.schema
      .string()
      .describe("Path to the second SVG, resolved relative to the project directory. Drawn on the right / on top."),
    mode: tool.schema
      .enum(["side-by-side", "overlay", "difference"])
      .optional()
      .describe(
        "'side-by-side' (default): both files next to each other, each scaled to the same display height with its aspect preserved (coordinate-unit size does not affect panel size). 'overlay': right fitted into left's coordinate space and ghosted magenta at 55% opacity. 'difference': pixel diff of both renders aligned in left's space (premultiplied RGB + alpha — transparency-only differences count) — identical pixels fade to gray, differing pixels turn magenta.",
      ),
    width: tool.schema
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe("Target PNG width in pixels (default 800, max 4096). Height follows the composed canvas's aspect ratio."),
    background: tool.schema
      .string()
      .optional()
      .describe(
        "Backdrop behind the artwork for 'side-by-side' and 'overlay' (default 'checker' — a subtle transparency checkerboard; 'neutral' = #f2f2f2; 'transparent' = real PNG alpha; any other value = CSS color). Ignored for 'difference', which always diffs transparent renders.",
      ),
  },
  async execute(args, context) {
    const t0 = performance.now()
    const root = context.directory

    const loadSvg = async (p: string, label: string) => {
      const svgPath = path.resolve(root, p)
      const rel = path.relative(root, svgPath)
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes the project directory: ${p}`)
      }
      if (path.extname(svgPath).toLowerCase() !== ".svg") {
        throw new Error(`Expected an .svg file, got: ${p}`)
      }
      const info = await stat(svgPath).catch((e) => {
        if (e?.code === "ENOENT") throw new Error(`SVG file not found (${label}): ${p}`)
        throw e
      })
      if (!info.isFile()) throw new Error(`Not a regular file: ${p}`)
      const realRel = path.relative(await realpath(root), await realpath(svgPath))
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`Path escapes the project directory: ${p}`)
      }
      return { svgPath, svg: (await readFile(svgPath)).toString("utf8") }
    }

    const L = await loadSvg(args.left, "left")
    const R = await loadSvg(args.right, "right")
    if (context.abort?.aborted) throw new Error("Render aborted")

    const lRoot = findRootElement(L.svg)
    const rRoot0 = findRootElement(R.svg)
    if (!lRoot) throw new Error(`No <svg> root element in ${args.left}`)
    if (!rRoot0) throw new Error(`No <svg> root element in ${args.right}`)
    const lSpace = docSpace(L.svg, lRoot.tag)
    const rSpace = docSpace(R.svg, rRoot0.tag)

    const width = args.width ?? DEFAULT_WIDTH
    const mode = args.mode ?? "side-by-side"
    // The right document is always id-renamespaced: two files under comparison
    // typically share structure (and ids), and without prefixes the second
    // occurrence wins id resolution — left's url(#x) would silently resolve to
    // right's #x and equal-looking output could hide a real difference.
    const rSvg = renamespaceIds(R.svg, "__r__")
    const rRoot = findRootElement(rSvg)!
    const rEmbed = (cell: Box) => embedSvg(rSvg, rRoot, rSpace.space, cell)

    const sameSpace =
      Math.abs(lSpace.space.x - rSpace.space.x) < 1e-6 &&
      Math.abs(lSpace.space.y - rSpace.space.y) < 1e-6 &&
      Math.abs(lSpace.space.w - rSpace.space.w) < 1e-6 &&
      Math.abs(lSpace.space.h - rSpace.space.h) < 1e-6

    const bgArg = args.background?.trim()
    const bgLower = bgArg?.toLowerCase()
    const wantChecker = bgLower === "checker" || bgArg === undefined
    let background: string | undefined
    let backgroundLabel: string

    // Checkerboard injected into the composed wrapper (source files untouched).
    const checkerDefs = (canvas: Box, zoom: number, content: string) => {
      let bgId = "__svg_compare_bg"
      for (let n = 1; content.includes(bgId); n++) bgId = `__svg_compare_bg_${n}`
      const cell = r4(10 / zoom)
      const tile = r4(2 * cell)
      return (
        `<pattern id="${bgId}" patternUnits="userSpaceOnUse" x="${r4(canvas.x)}" y="${r4(canvas.y)}" width="${tile}" height="${tile}"><rect width="${tile}" height="${tile}" fill="#eeeeee"/><rect width="${cell}" height="${cell}" fill="#dcdcdc"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#dcdcdc"/></pattern>` +
        `<rect x="${r4(canvas.x)}" y="${r4(canvas.y)}" width="${r4(canvas.w)}" height="${r4(canvas.h)}" fill="url(#${bgId})"/>`
      )
    }

    const mkWrapper = (canvas: Box, inner: string, checker: boolean) => {
      const zoom = width / canvas.w
      const bg = checker ? checkerDefs(canvas, zoom, inner) : ""
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmtNum(canvas.x)} ${fmtNum(canvas.y)} ${fmtNum(canvas.w)} ${fmtNum(canvas.h)}" width="${fmtNum(canvas.w)}" height="${fmtNum(canvas.h)}">${bg}${inner}</svg>`
    }

    // --- timeout / abort plumbing (same pattern as svg_render) ----------------
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

    const GAVE_UP = "__svg_compare_gave_up__"
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

    // resvg-js's binding consumes the passed AbortSignal — it cannot back two
    // renderAsync calls (second call rejects with InvalidArg). Each render gets
    // a fresh signal that forwards the shared one.
    const subSignal = () => {
      const sub = new AbortController()
      if (ctrl.signal.aborted) sub.abort()
      else ctrl.signal.addEventListener("abort", () => sub.abort(), { once: true })
      return sub.signal
    }

    let png: Buffer
    let outW = 0
    let outH = 0
    let degraded = false
    const notes: string[] = []

    try {
      if (context.abort?.aborted) ctrl.abort()
      if (ctrl.signal.aborted) throw new Error("Render aborted")

      if (wantChecker) {
        background = undefined // injected as markup instead
        backgroundLabel = `checker${bgArg === undefined ? " (default)" : ""}`
      } else if (bgLower === "transparent" || mode === "difference") {
        background = undefined
        backgroundLabel = "transparent"
      } else if (bgLower === "neutral") {
        background = DEFAULT_BACKGROUND
        backgroundLabel = `neutral ${DEFAULT_BACKGROUND}`
      } else {
        background = bgArg!
        backgroundLabel = bgArg!
      }

      if (mode === "side-by-side") {
        // Each side gets a cell of equal display height; width follows its own
        // aspect. Coordinate-unit size must not determine screen size — a
        // 0 0 100 100 file and a 0 0 1000 1000 file of the same drawing should
        // compare at the same rendered size.
        const H = 1000
        const lw = (lSpace.space.w / lSpace.space.h) * H
        const rw = (rSpace.space.w / rSpace.space.h) * H
        const gap = r4(H * 0.05)
        const canvas: Box = { x: 0, y: 0, w: r4(lw + gap + rw), h: H }
        const lCell: Box = { x: 0, y: 0, w: r4(lw), h: H }
        const rCell: Box = { x: r4(lw + gap), y: 0, w: r4(rw), h: H }
        const pxUnit = canvas.w / width
        const divider = `<rect x="${r4(lw + gap / 2 - pxUnit / 2)}" y="0" width="${r4(pxUnit)}" height="${r4(canvas.h)}" fill="rgba(0,0,0,0.25)"/>`
        const wrapper = mkWrapper(
          canvas,
          embedSvg(L.svg, lRoot, lSpace.space, lCell) + divider + rEmbed(rCell),
          wantChecker,
        )
        const r = await Promise.race([renderFitted(wrapper, canvas, width, background, subSignal()), gaveUp])
        png = r.png
        outW = r.w
        outH = r.h
        degraded = r.degraded
        notes.push("both sides shown at equal display height, aspect preserved — panel size does not reflect coordinate-unit size")
      } else if (mode === "overlay") {
        const canvas = lSpace.space
        const cell: Box = { x: canvas.x, y: canvas.y, w: canvas.w, h: canvas.h }
        const tint =
          `<defs><filter id="__svg_compare_tint" x="-5%" y="-5%" width="110%" height="110%">` +
          `<feFlood flood-color="#ff2d78"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>`
        const inner =
          embedSvg(L.svg, lRoot, lSpace.space, cell) +
          tint +
          `<g opacity="0.55" filter="url(#__svg_compare_tint)">${rEmbed(cell)}</g>`
        const wrapper = mkWrapper(canvas, inner, wantChecker)
        const r = await Promise.race([renderFitted(wrapper, canvas, width, background, subSignal()), gaveUp])
        png = r.png
        outW = r.w
        outH = r.h
        degraded = r.degraded
        notes.push("right drawn over left as a magenta ghost at 55% opacity")
        if (!sameSpace) notes.push("different viewBoxes: right was fitted into left's space (aspect preserved, letterboxed if needed)")
      } else {
        // difference: render each file alone inside left's coordinate space.
        const canvas = lSpace.space
        const cell: Box = { x: canvas.x, y: canvas.y, w: canvas.w, h: canvas.h }
        const wA = mkWrapper(canvas, embedSvg(L.svg, lRoot, lSpace.space, cell), false)
        const wB = mkWrapper(canvas, rEmbed(cell), false)
        // Sequential: resvg-js's napi binding rejects two renderAsync calls
        // that share one AbortSignal, and it halves peak memory.
        const ra = await Promise.race([renderFitted(wA, canvas, width, undefined, subSignal()), gaveUp])
        const rb = await Promise.race([renderFitted(wB, canvas, width, undefined, subSignal()), gaveUp])
        degraded = ra.degraded || rb.degraded
        const w = Math.min(ra.w, rb.w)
        const h = Math.min(ra.h, rb.h)
        if (ra.w !== rb.w || ra.h !== rb.h) notes.push(`renders differed in size (${ra.w}×${ra.h} vs ${rb.w}×${rb.h}) — compared on the shared ${w}×${h} area`)

        const THRESH = 12
        const out = Buffer.alloc(w * h * 4)
        let diffCount = 0
        let minX = w, minY = h, maxX = -1, maxY = -1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4
            const oa = (y * ra.w + x) * 4
            const ob = (y * rb.w + x) * 4
            const [ar, ag, ab] = overWhite(ra.pixels, oa)
            // Compare premultiplied RGB + alpha: two pixels look identical over
            // every backdrop iff these four channels match. Compositing to RGB
            // first would make "transparent vs opaque white" invisible.
            const d = Math.max(
              Math.abs(ra.pixels[oa] - rb.pixels[ob]),
              Math.abs(ra.pixels[oa + 1] - rb.pixels[ob + 1]),
              Math.abs(ra.pixels[oa + 2] - rb.pixels[ob + 2]),
              Math.abs(ra.pixels[oa + 3] - rb.pixels[ob + 3]),
            )
            if (d > THRESH) {
              diffCount++
              if (x < minX) minX = x
              if (y < minY) minY = y
              if (x > maxX) maxX = x
              if (y > maxY) maxY = y
              out[o] = 255
              out[o + 1] = 45
              out[o + 2] = 120
              out[o + 3] = 255
            } else {
              // fade the left render toward white so diffs pop but context stays
              out[o] = Math.round(ar + (255 - ar) * 0.78)
              out[o + 1] = Math.round(ag + (255 - ag) * 0.78)
              out[o + 2] = Math.round(ab + (255 - ab) * 0.78)
              out[o + 3] = 255
            }
          }
        }
        png = encodePng(w, h, out)
        outW = w
        outH = h
        const pct = ((diffCount / (w * h)) * 100).toFixed(2)
        if (diffCount === 0) {
          notes.push(`0 pixels differ above threshold ${THRESH}/255 (premultiplied RGB + alpha compared)`)
        } else {
          const u = canvas.w / w
          notes.push(
            `${diffCount.toLocaleString("en-US")} differing pixels (${pct}%)`,
            `diff region: px ${minX}..${maxX} × ${minY}..${maxY} ≈ left-space x ${fmt(canvas.x + minX * u)}..${fmt(canvas.x + (maxX + 1) * u)}, y ${fmt(canvas.y + minY * u)}..${fmt(canvas.y + (maxY + 1) * u)}`,
          )
        }
        if (!sameSpace) notes.push("different viewBoxes: right was fitted into left's space (aspect preserved, letterboxed if needed)")
      }
    } catch (e) {
      if (timedOut) {
        const t = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
        throw new Error(`SVG compare timed out after ${t}.\n\nTry:\n- compare with mode "side-by-side" (single render)\n- a smaller width\n- inspect each file with svg_render first`)
      }
      if ((e as Error)?.message === GAVE_UP || ctrl.signal.aborted || context.abort?.aborted) {
        throw new Error("Render aborted")
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to compare SVGs: ${args.left} vs ${args.right}\n${msg}`)
    } finally {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      context.abort?.removeEventListener("abort", onUserAbort)
    }

    const lBase = path.basename(L.svgPath, path.extname(L.svgPath)) || "left"
    const rBase = path.basename(R.svgPath, path.extname(R.svgPath)) || "right"
    const outName = `compare-${lBase}-vs-${rBase}.${mode}.png`
    const pngPath = path.join(root, ".opencode", "renders", outName)
    await mkdir(path.dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)

    const pngSha = sha256(png)
    const spaceText = (s: { space: Box; source: string }) =>
      `${s.source} ${fmt(s.space.x)} ${fmt(s.space.y)} ${fmt(s.space.w)} ${fmt(s.space.h)}`

    const lines = [
      `${args.left} vs ${args.right} → ${path.relative(root, pngPath)}`,
      `Mode: ${mode}`,
      `Left space: ${spaceText(lSpace)}`,
      `Right space: ${spaceText(rSpace)}${sameSpace ? " (same space — aligned 1:1)" : ""}`,
      `Output: ${outW}×${outH} px${degraded ? " (resolution reduced: surface caps)" : ""}`,
      ...(mode === "difference" ? [] : [`Background: ${backgroundLabel!}`]),
      `Sources: ${sha256(L.svg)} / ${sha256(R.svg)}`,
      `PNG: ${pngSha}`,
      ...notes.map((n) => `Note: ${n}`),
      `Timing: ${Math.round(performance.now() - t0)} ms total`,
    ]

    return {
      title: `Compared ${lBase} vs ${rBase} (${mode})`,
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
        left: L.svgPath,
        right: R.svgPath,
        png: pngPath,
        mode,
        width: outW,
        height: outH,
        leftSha256: sha256(L.svg),
        rightSha256: sha256(R.svg),
        pngSha256: pngSha,
      },
    }
  },
})
