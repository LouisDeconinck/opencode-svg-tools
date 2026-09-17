import { tool } from "@opencode-ai/plugin"
import { Resvg } from "@resvg/resvg-js"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const localName = (n: string) => n.slice(n.lastIndexOf(":") + 1)
const fmt = (n: number) => String(+n.toFixed(2))

function getAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
  return m?.[1] ?? m?.[2]
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

// Containers whose children never render directly.
const DEAD_NAMES = new Set([
  "defs", "symbol", "mask", "pattern", "marker", "clipPath", "linearGradient",
  "radialGradient", "hatch", "solidcolor", "title", "desc", "metadata",
  "foreignObject", "script", "style",
])

interface ElInfo {
  name: string
  id?: string
  parent: number // index into els, -1 for the root <svg>
  lt: number // offset of '<'
  tagEnd: number // offset just after '>' of the start tag
  closeEnd: number // offset just after the matching close tag (== tagEnd when self-closing)
  dead: boolean
  hasTransform: boolean
  selfClose: boolean
}

// Single pass over the markup building a flat element index.
function indexElements(svg: string): ElInfo[] {
  const els: ElInfo[] = []
  const stack: number[] = []
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
        if (els[stack[k]].name !== name) continue
        els[stack[k]].closeEnd = gt + 1
        stack.length = k
        break
      }
      continue
    }
    const m = /^<([^\s/>]+)/.exec(tag)
    if (!m) continue
    const name = localName(m[1])
    const parent = stack.length ? stack[stack.length - 1] : -1
    const selfClose = /\/\s*>$/.test(tag)
    const el: ElInfo = {
      name,
      id: getAttr(tag, "id"),
      parent,
      lt,
      tagEnd: gt + 1,
      closeEnd: gt + 1,
      dead: (parent >= 0 && els[parent].dead) || DEAD_NAMES.has(name),
      hasTransform: getAttr(tag, "transform") !== undefined,
      selfClose,
    }
    els.push(el)
    if (!selfClose) stack.push(els.length - 1)
  }
  return els
}

// Force-hide an element: merge into style when present (inline style beats the
// display attribute), otherwise set/replace the display attribute.
function hideTag(tag: string): string {
  if (/\sstyle\s*=\s*"/.test(tag)) return tag.replace(/(\sstyle\s*=\s*")([^"]*)"/, '$1$2;display:none"')
  if (/\sstyle\s*=\s*'/.test(tag)) return tag.replace(/(\sstyle\s*=\s*')([^']*)'/, "$1$2;display:none'")
  if (/\sdisplay\s*=/.test(tag)) return tag.replace(/(\s)display\s*=\s*("[^"]*"|'[^']*')/, '$1display="none"')
  return tag.replace(/\s*\/?>$/, (m) => ` display="none"${m.trimEnd()}`)
}

export default tool({
  description:
    "Answer structural questions about an SVG file without rendering: list elements with ids, get an element's bounding box in SVG/viewBox coordinates, or validate the markup. Use this to find what exists and where things are before editing or before rendering a region with svg_render.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Path to the SVG file, resolved relative to the project directory OpenCode is running in (context.directory) — not relative to .opencode/. Example: 'stickers/llama.svg'.",
      ),
    operation: tool.schema
      .enum(["list", "bounds", "validate"])
      .describe(
        "'list' = elements with ids (tag, parent, transform flag). 'bounds' = bounding box of one element in SVG coordinates (requires `element`). 'validate' = parse check with line/column on failure.",
      ),
    element: tool.schema
      .string()
      .optional()
      .describe("Element id for operation 'bounds', with or without '#'. Example: 'saddle'."),
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
    if (!info.isFile()) throw new Error(`Not a regular file: ${args.path}`)
    const realRel = path.relative(await realpath(root), await realpath(svgPath))
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Path escapes the project directory: ${args.path}`)
    }

    const svg = (await readFile(svgPath)).toString("utf8")

    // --- validate ------------------------------------------------------------
    if (args.operation === "validate") {
      try {
        new Resvg(svg, { font: { loadSystemFonts: false } })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const m = /at (\d+):(\d+)/.exec(msg)
        const srcLine = m ? svg.split("\n")[Number(m[1]) - 1] : undefined
        throw new Error(
          `Invalid SVG: ${args.path}\n${msg}` +
            (srcLine !== undefined ? `\n  line ${m![1]}: ${srcLine.trim().slice(0, 160)}` : ""),
        )
      }
      const els = indexElements(svg)
      const ids = els.filter((e) => e.id !== undefined).length
      return {
        title: `Valid SVG: ${args.path}`,
        output: `Valid SVG\n${els.length} elements, ${ids} with id`,
      }
    }

    const els = indexElements(svg)

    // --- list ------------------------------------------------------------------
    if (args.operation === "list") {
      const withId = els.filter((e) => e.id !== undefined)
      if (withId.length === 0) {
        return {
          title: `No ids in ${args.path}`,
          output: `No elements with id found (${els.length} elements total).`,
        }
      }
      const CAP = 150
      const rows = withId.slice(0, CAP).map((e) => {
        const pid = e.parent >= 0 ? els[e.parent].id : undefined
        return `#${e.id}  ${e.name}` + (pid ? `  (in #${pid})` : "") + (e.hasTransform ? "  [transform]" : "")
      })
      if (withId.length > CAP) rows.push(`… and ${withId.length - CAP} more`)
      return {
        title: `${withId.length} ids in ${args.path}`,
        output:
          `${withId.length} elements with id (${els.length} total):\n` + rows.join("\n"),
      }
    }

    // --- bounds ----------------------------------------------------------------
    const want = (args.element ?? "").replace(/^#/, "")
    if (!want) throw new Error(`operation "bounds" requires an element id, e.g. { "element": "saddle" }`)
    const matches = els.map((e, i) => (e.id === want ? i : -1)).filter((i) => i >= 0)
    if (matches.length === 0) {
      const allIds = els.filter((e) => e.id !== undefined).map((e) => e.id!)
      const close = allIds.filter((id) => id.toLowerCase().includes(want.toLowerCase())).slice(0, 10)
      throw new Error(
        `No element with id "${want}" in ${args.path}.` +
          (close.length ? `\nDid you mean: ${close.map((i) => `#${i}`).join(", ")}?` : `\nRun svg_inspect with operation "list" to see all ids.`),
      )
    }
    const ti = matches[0]
    const target = els[ti]
    const dupNote = matches.length > 1 ? `\n(${matches.length} elements share id "${want}"; reporting the first)` : ""

    if (target.dead) {
      const container = els[target.parent >= 0 ? target.parent : ti].name
      return {
        title: `Bounds unavailable for #${want}`,
        output:
          `#${want} is inside <${container}> — it is never rendered directly, so it has no position of its own.\n` +
          `Query the id of a <use> element (or other rendered element) that instances it to get rendered bounds.`,
      }
    }

    // Keep: the target, its ancestors (transforms apply), its descendants, and
    // non-rendering containers (defs resolve url(#…) references). Hide the
    // outermost unrelated rendering subtrees so getBBox measures only #want.
    const keep = new Array<boolean>(els.length).fill(false)
    keep[ti] = true
    for (let p = target.parent; p >= 0; p = els[p].parent) keep[p] = true
    for (let i = 0; i < els.length; i++) {
      if (els[i].dead) keep[i] = true
      else {
        for (let p = els[i].parent; p >= 0; p = els[p].parent) {
          if (p === ti) {
            keep[i] = true
            break
          }
        }
      }
    }
    const edits: { start: number; end: number; text: string }[] = []
    for (let i = 0; i < els.length; i++) {
      if (keep[i] || els[i].parent < 0) continue
      if (!keep[els[i].parent]) continue // an ancestor is already hidden
      edits.push({ start: els[i].lt, end: els[i].tagEnd, text: hideTag(svg.slice(els[i].lt, els[i].tagEnd)) })
    }
    let mod = svg
    edits.sort((a, b) => b.start - a.start)
    for (const e of edits) mod = mod.slice(0, e.start) + e.text + mod.slice(e.end)

    const hasText = /<(?:[\w.-]+:)?text\b/i.test(svg.slice(target.lt, target.closeEnd))
    let bbox
    try {
      bbox = new Resvg(mod, { font: { loadSystemFonts: hasText } }).getBBox()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot compute bounds for #${want} in ${args.path}: ${msg}`)
    }
    if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) {
      return {
        title: `Bounds unavailable for #${want}`,
        output: `#${want} produced no rendered bounds — it may be display:none, visibility:hidden, fully clipped, or otherwise invisible.${dupNote}`,
      }
    }

    const tag = svg.slice(target.lt, target.tagEnd)
    const caveats: string[] = []
    if (getAttr(tag, "clip-path") || getAttr(tag, "mask")) caveats.push("bounds are geometric — clip/mask may hide part of it")
    if (getAttr(tag, "filter")) caveats.push("filter effects are not included in the bounds")
    if (target.name === "use") caveats.push("bounds cover the instanced content")

    return {
      title: `#${want} bounds`,
      output:
        `#${want} (${target.name}) in ${args.path}\n` +
        `x: ${fmt(bbox.x)}\ny: ${fmt(bbox.y)}\nwidth: ${fmt(bbox.width)}\nheight: ${fmt(bbox.height)}\n` +
        `center: ${fmt(bbox.x + bbox.width / 2)}, ${fmt(bbox.y + bbox.height / 2)}` +
        (caveats.length ? `\n(${caveats.join("; ")})` : "") +
        dupNote,
      metadata: { id: want, x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
    }
  },
})
