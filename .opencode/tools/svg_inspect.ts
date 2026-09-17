import { tool } from "@opencode-ai/plugin"
import { Resvg } from "@resvg/resvg-js"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const localName = (n: string) => n.slice(n.lastIndexOf(":") + 1)
const fmt = (n: number) => String(+n.toFixed(2))
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

interface Box {
  x: number
  y: number
  width: number
  height: number
}

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

// clip-path="url(#id)" or style="... clip-path: url(#id) ..." on an element tag.
function clipRefId(tag: string): string | undefined {
  const m =
    getAttr(tag, "clip-path")?.match(/url\(\s*["']?#([^\s"')]+)/) ??
    getAttr(tag, "style")?.match(/clip-path\s*:\s*url\(\s*["']?#([^\s"')]+)/)
  return m?.[1]
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
  closeStart: number // offset of '<' of the matching close tag (== tagEnd when self-closing)
  closeEnd: number // offset just after the matching close tag (== tagEnd when self-closing)
  dead: boolean
  transform?: string
  clipId?: string
  viewport: boolean // inside a nested <svg> viewport (see indexElements)
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
        els[stack[k]].closeStart = lt
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
    const transform = getAttr(tag, "transform")
    const el: ElInfo = {
      name,
      id: getAttr(tag, "id"),
      parent,
      lt,
      tagEnd: gt + 1,
      closeStart: gt + 1,
      closeEnd: gt + 1,
      dead: (parent >= 0 && els[parent].dead) || DEAD_NAMES.has(name),
      transform,
      clipId: clipRefId(tag),
      // A nested <svg> establishes a viewport (x/y/width/height/viewBox) that an
      // ancestor-transform chain cannot represent. Mark it and its descendants.
      viewport:
        (parent >= 0 && els[parent].viewport) || (name === "svg" && parent >= 0),
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

// Elements to keep when measuring `ti`: itself, its ancestors (transforms
// apply), its descendants, and non-rendering containers (defs resolve
// url(#…) / <use> references). Everything else at top level gets hidden so
// getBBox measures only the target.
function keepMask(els: ElInfo[], ti: number): boolean[] {
  const keep = new Array<boolean>(els.length).fill(false)
  keep[ti] = true
  for (let p = els[ti].parent; p >= 0; p = els[p].parent) keep[p] = true
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
  return keep
}

// Geometric (pre-raster) bbox of the kept elements, measured by hiding the
// unrelated top-level subtrees and asking resvg for the document bbox.
// `inject` splices extra markup just inside the root <svg> before measuring —
// used to measure clip geometry or a <use> instance of a defs-only element.
function measureBBox(
  svg: string,
  els: ElInfo[],
  keep: boolean[],
  inject?: string,
): { box?: Box; err?: string } {
  const edits: { start: number; end: number; text: string }[] = []
  for (let i = 0; i < els.length; i++) {
    if (keep[i]) continue
    const p = els[i].parent
    if (p < 0) continue // the root itself is never hidden
    // Hide an unkept element only when its parent is kept — a hidden ancestor
    // already covers it. The root always counts as kept so top-level subtrees
    // are hidden even when no element mask includes it (dead-only keeps).
    if (!keep[p] && els[p].parent >= 0) continue
    edits.push({ start: els[i].lt, end: els[i].tagEnd, text: hideTag(svg.slice(els[i].lt, els[i].tagEnd)) })
  }
  let mod = svg
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) mod = mod.slice(0, e.start) + e.text + mod.slice(e.end)

  // Font policy must cover only what stays visible: text has no measurable
  // extent without fonts loaded.
  let keptText = inject ?? ""
  for (let i = 0; i < els.length; i++) if (keep[i]) keptText += svg.slice(els[i].lt, els[i].tagEnd)
  const hasText = /<(?:[\w.-]+:)?text\b/i.test(keptText)

  if (inject !== undefined) {
    const ri = els.findIndex((e) => e.name === "svg" && e.parent === -1)
    if (ri < 0) return { err: "no <svg> root element found" }
    const r = els[ri]
    mod = r.selfClose
      ? mod.slice(0, r.tagEnd).replace(/\/\s*>$/, ">") + inject + "</svg>" + mod.slice(r.tagEnd)
      : mod.slice(0, r.tagEnd) + inject + mod.slice(r.tagEnd)
  }
  try {
    const box = new Resvg(mod, { font: { loadSystemFonts: hasText } }).getBBox()
    return { box }
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) }
  }
}

const elBBox = (svg: string, els: ElInfo[], ti: number) => measureBBox(svg, els, keepMask(els, ti))

// Bounding box of a clipPath's geometry in the coordinate space established by
// `chain` — the ancestor transform list (including the referencing element's
// own transform) of the element bearing clip-path. A clip-path reference on
// the clipPath itself is resolved recursively and intersected, since nested
// clip contents share the same usage space (userSpaceOnUse).
function clipBBox(svg: string, els: ElInfo[], cpIdx: number, chain: string, depth = 0): Box | undefined {
  const cp = els[cpIdx]
  let box: Box | undefined
  const body = cp.selfClose ? "" : svg.slice(cp.tagEnd, cp.closeStart)
  if (body.trim()) {
    const inner = `<g${cp.transform ? ` transform="${esc(cp.transform)}"` : ""}>${body}</g>`
    const inject = chain ? `<g transform="${esc(chain)}">${inner}</g>` : inner
    box = measureBBox(svg, els, els.map((e) => e.dead), inject).box
  }
  if (cp.clipId && depth < 4) {
    const ni = els.findIndex((e) => e.name === "clipPath" && e.id === cp.clipId)
    if (ni >= 0) {
      const nb = clipBBox(svg, els, ni, chain, depth + 1)
      if (nb) box = box ? intersectBoxes(box, nb) : nb
    }
  }
  return box
}

function intersectBoxes(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const bot = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, bot - y) }
}

// Ancestor transform chain for element `ti`, root first, including ti's own
// transform — i.e. the user space clip-path geometry resolves in.
function transformChain(els: ElInfo[], ti: number): string {
  const parts: string[] = []
  for (let i = ti; i >= 0; i = els[i].parent) if (els[i].transform) parts.unshift(els[i].transform!)
  return parts.join(" ")
}

// Which sides of `b` stick out past `within`. Positive amount = overflow.
function overflowParts(b: Box, within: Box): string[] {
  const eps = 0.01
  const parts: string[] = []
  const l = within.x - b.x
  const t = within.y - b.y
  const r = b.x + b.width - (within.x + within.width)
  const bot = b.y + b.height - (within.y + within.height)
  if (l > eps) parts.push(`left by ${fmt(l)}`)
  if (t > eps) parts.push(`top by ${fmt(t)}`)
  if (r > eps) parts.push(`right by ${fmt(r)}`)
  if (bot > eps) parts.push(`bottom by ${fmt(bot)}`)
  return parts
}

const boxText = (b: Box) => `x ${fmt(b.x)}, y ${fmt(b.y)}, w ${fmt(b.width)}, h ${fmt(b.height)}`

function resolveElement(els: ElInfo[], want: string, file: string): { ti: number; dupNote: string } {
  const matches = els.map((e, i) => (e.id === want ? i : -1)).filter((i) => i >= 0)
  if (matches.length === 0) {
    const allIds = els.filter((e) => e.id !== undefined).map((e) => e.id!)
    const close = allIds.filter((id) => id.toLowerCase().includes(want.toLowerCase())).slice(0, 10)
    throw new Error(
      `No element with id "${want}" in ${file}.` +
        (close.length ? `\nDid you mean: ${close.map((i) => `#${i}`).join(", ")}?` : `\nRun svg_inspect with operation "list" to see all ids.`),
    )
  }
  return {
    ti: matches[0],
    dupNote: matches.length > 1 ? `\n(${matches.length} elements share id "${want}"; reporting the first)` : "",
  }
}

const stripHash = (s: string | undefined) => (s ?? "").replace(/^#/, "")

// Command letter or numeric literal in a path "d" attribute.
const PATH_TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g

// Canonical compare of two d strings: same command letters and numerically
// equal arguments ("10.0" == "10", ".5" == "0.5", "1e2" == "100").
function comparePathData(a: string, b: string): { verdict: string; detail?: string } {
  if (a.trim() === b.trim()) return { verdict: "identical (exact string match)" }
  const ta = a.match(PATH_TOKEN) ?? []
  const tb = b.match(PATH_TOKEN) ?? []
  const n = Math.min(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const x = ta[i]
    const y = tb[i]
    const same = /[a-zA-Z]/.test(x) ? x === y : parseFloat(x) === parseFloat(y)
    if (!same) {
      const ctx = (t: string[], i: number) => t.slice(Math.max(0, i - 3), i + 3).join(" ")
      return {
        verdict: "differ",
        detail: `first difference at token ${i}: "${x}" vs "${y}"\n  context: … ${ctx(ta, i)} …  |  … ${ctx(tb, i)} …`,
      }
    }
  }
  if (ta.length !== tb.length) {
    return {
      verdict: "differ",
      detail: `same up to token ${n}, then one side continues (${ta.length} vs ${tb.length} tokens): "${(ta[n] ?? "") || (tb[n] ?? "")}"…`,
    }
  }
  return { verdict: "equivalent (same path data, formatting differs only)" }
}

export default tool({
  description:
    "Answer structural questions about an SVG file without rendering: list elements with ids, get an element's geometric bounding box in SVG/viewBox coordinates, validate the markup, compare path data between two elements/files, check whether an element escapes the clip applied to it, or check whether one element is fully contained within another's bounds. Use this to find what exists and where things are before editing or before rendering a region with svg_render — do not guess coordinates from path data.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Path to the SVG file, resolved relative to the project directory OpenCode is running in (context.directory) — not relative to .opencode/. Example: 'stickers/llama.svg'.",
      ),
    operation: tool.schema
      .enum(["list", "bounds", "validate", "compare-path", "clip-escape", "containment-check"])
      .describe(
        "'list' = elements with ids (tag, parent, transform flag). 'bounds' = geometric bounding box of one element in SVG coordinates — transforms and <use> resolved, but filters excluded and clip/mask may hide part of it; not the raster extent (requires `element`). 'validate' = parse check with line/column on failure. 'compare-path' = compare the d data of two <path> elements — exact + normalized, plus each side's bounds (requires `element`; `against_file`/`against_element` select the other side, default = same id in the same file). 'clip-escape' = does an element's bounds exceed the clip-path applied to it — omit `element` to check every clip usage in the file. 'containment-check' = is `element`'s bounds fully inside `against_element`'s bounds (optionally in `against_file`).",
      ),
    element: tool.schema
      .string()
      .optional()
      .describe("Element id for 'bounds', 'compare-path', 'clip-escape' and 'containment-check', with or without '#'. Example: 'saddle'."),
    against_file: tool.schema
      .string()
      .optional()
      .describe("Second SVG file for 'compare-path' and 'containment-check' (default: same file as `path`)."),
    against_element: tool.schema
      .string()
      .optional()
      .describe("Element id on the 'against' side (default: the same id as `element`)."),
  },
  async execute(args, context) {
    const root = context.directory

    const loadSvg = async (p: string) => {
      const svgPath = path.resolve(root, p)
      const rel = path.relative(root, svgPath)
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes the project directory: ${p}`)
      }
      if (path.extname(svgPath).toLowerCase() !== ".svg") {
        throw new Error(`Expected an .svg file, got: ${p}`)
      }
      const info = await stat(svgPath).catch((e) => {
        if (e?.code === "ENOENT") throw new Error(`SVG file not found: ${p}`)
        throw e
      })
      if (!info.isFile()) throw new Error(`Not a regular file: ${p}`)
      const realRel = path.relative(await realpath(root), await realpath(svgPath))
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`Path escapes the project directory: ${p}`)
      }
      return { svgPath, svg: (await readFile(svgPath)).toString("utf8") }
    }

    const { svg } = await loadSvg(args.path)

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
        return `#${e.id}  ${e.name}` + (pid ? `  (in #${pid})` : "") + (e.transform ? "  [transform]" : "")
      })
      if (withId.length > CAP) rows.push(`… and ${withId.length - CAP} more`)
      return {
        title: `${withId.length} ids in ${args.path}`,
        output:
          `${withId.length} elements with id (${els.length} total):\n` + rows.join("\n"),
      }
    }

    // --- compare-path ----------------------------------------------------------
    if (args.operation === "compare-path") {
      const want = stripHash(args.element)
      if (!want) throw new Error(`operation "compare-path" requires an element id, e.g. { "element": "outline" }`)
      const a = resolveElement(els, want, args.path)
      const other = await loadSvg(args.against_file ?? args.path)
      const oEls = args.against_file ? indexElements(other.svg) : els
      const wantB = stripHash(args.against_element) || want
      const b = resolveElement(oEls, wantB, args.against_file ?? args.path)

      const tagOf = (s: string, e: ElInfo) => s.slice(e.lt, e.tagEnd)
      const elA = els[a.ti]
      const elB = oEls[b.ti]
      for (const [el, file, id] of [
        [elA, args.path, want],
        [elB, args.against_file ?? args.path, wantB],
      ] as const) {
        if (el.name !== "path") {
          throw new Error(`#${id} in ${file} is a <${el.name}>, not a <path> — "compare-path" compares path d data.`)
        }
      }
      const dA = getAttr(tagOf(svg, elA), "d") ?? ""
      const dB = getAttr(tagOf(other.svg, elB), "d") ?? ""
      if (!dA.trim() || !dB.trim()) {
        throw new Error(`Missing d data: #${want} has ${dA.trim() ? "d" : "no d"}, #${wantB} has ${dB.trim() ? "d" : "no d"}.`)
      }

      const cmp = comparePathData(dA, dB)
      const lines = [
        `#${want} (${args.path}) vs #${wantB} (${args.against_file ?? args.path})`,
        `path data: ${cmp.verdict}`,
      ]
      if (cmp.detail) lines.push(`  ${cmp.detail}`)

      const bA = elA.dead ? undefined : elBBox(svg, els, a.ti).box
      const bB = elB.dead ? undefined : elBBox(other.svg, oEls, b.ti).box
      const deadNote = (el: ElInfo, id: string) =>
        el.dead ? `\n#${id} is inside a non-rendering container — it has no rendered bounds` : ""
      if (bA && bB) {
        const same =
          Math.abs(bA.x - bB.x) < 0.01 &&
          Math.abs(bA.y - bB.y) < 0.01 &&
          Math.abs(bA.width - bB.width) < 0.01 &&
          Math.abs(bA.height - bB.height) < 0.01
        lines.push(
          `bounds ${args.path}: ${boxText(bA)}`,
          `bounds ${args.against_file ?? args.path}: ${boxText(bB)}`,
          same
            ? "bounds match — same outline position"
            : `bounds differ — shifted by (${fmt(bB.x - bA.x)}, ${fmt(bB.y - bA.y)}), size Δw ${fmt(bB.width - bA.width)} Δh ${fmt(bB.height - bA.height)}${args.against_file ? " (each measured in its own file's coordinate space)" : ""}`,
        )
      } else {
        lines.push(`bounds: unavailable${deadNote(elA, want)}${deadNote(elB, wantB)}`)
      }
      return {
        title: `compare-path: ${cmp.verdict}`,
        output: lines.join("\n") + a.dupNote + b.dupNote,
      }
    }

    // --- clip-escape -------------------------------------------------------------
    if (args.operation === "clip-escape") {
      // The effective clip for element ti is its own clip-path or the nearest
      // ancestor's. Returns the bearer index and clipPath element index.
      const effectiveClip = (ti: number): { bearer: number; cpIdx: number; missing?: string } | undefined => {
        for (let i = ti; i >= 0; i = els[i].parent) {
          if (!els[i].clipId) continue
          const cpIdx = els.findIndex((e) => e.name === "clipPath" && e.id === els[i].clipId)
          return cpIdx >= 0 ? { bearer: i, cpIdx } : { bearer: i, cpIdx: -1, missing: els[i].clipId }
        }
        return undefined
      }

      const escapeLine = (ti: number, bearer: number, cpIdx: number, label: string): string => {
        const cp = els[cpIdx]
        if (els[bearer].viewport) return `${label}: skipped — clip usage inside a nested <svg> viewport cannot be resolved`
        const obb = getAttr(svg.slice(cp.lt, cp.tagEnd), "clipPathUnits") === "objectBoundingBox"
        if (obb) return `${label}: skipped — clip #${cp.id} uses objectBoundingBox units`
        const cBox = clipBBox(svg, els, cpIdx, transformChain(els, bearer))
        if (!cBox) return `${label}: clip #${cp.id} produced no bounds (empty or unmeasurable clip geometry)`
        const { box, err } = elBBox(svg, els, ti)
        if (err) return `${label}: bounds unavailable (${err})`
        if (!box) return `${label}: no geometric bounds — invisible or fully hidden`
        const over = overflowParts(box, cBox)
        return (
          `${label}: clip #${cp.id} [${boxText(cBox)}] — ` +
          (over.length ? `ESCAPES ${over.join(", ")}` : `inside`) +
          ` (element ${boxText(box)})`
        )
      }

      const want = stripHash(args.element)
      if (want) {
        const { ti, dupNote } = resolveElement(els, want, args.path)
        const ec = effectiveClip(ti)
        if (!ec) {
          return {
            title: `No clip applies to #${want}`,
            output: `#${want} has no clip-path of its own and no clipped ancestor — nothing clips it.${dupNote}`,
          }
        }
        if (ec.cpIdx < 0) {
          return {
            title: `Clip unresolved for #${want}`,
            output: `#${want} is clipped by url(#${ec.missing}) but no <clipPath> with that id exists.${dupNote}`,
          }
        }
        const bearer = ec.bearer
        const via = bearer === ti ? "" : ` (clip held by ancestor #${els[bearer].id ?? els[bearer].name})`
        const lines = [escapeLine(ti, bearer, ec.cpIdx, `#${want}${via}`)]
        // When the queried element is the clip bearer, report which direct
        // children escape — the "list elements escaping the clip" question.
        if (bearer === ti) {
          const kids = els.map((e, i) => (e.parent === ti && !e.dead ? i : -1)).filter((i) => i >= 0)
          const shown = kids.slice(0, 40)
          for (const ci of shown) {
            lines.push(escapeLine(ci, bearer, ec.cpIdx, `  ${els[ci].id ? `#${els[ci].id}` : `<${els[ci].name}>`}`))
          }
          if (kids.length > shown.length) lines.push(`  … and ${kids.length - shown.length} more children`)
        }
        return {
          title: `clip-escape: #${want}`,
          output: lines.join("\n") + dupNote,
        }
      }

      // No element: check every rendered clip usage in the document.
      const usages = els
        .map((e, i) => (e.clipId && !e.dead && !(e.name === "svg" && e.parent === -1) ? i : -1))
        .filter((i) => i >= 0)
      if (usages.length === 0) {
        return { title: `No clip usages in ${args.path}`, output: "No rendered element carries a clip-path." }
      }
      const lines: string[] = []
      let escapes = 0
      for (const ti of usages.slice(0, 40)) {
        const e = els[ti]
        const cpIdx = els.findIndex((c) => c.name === "clipPath" && c.id === e.clipId)
        const label = e.id ? `#${e.id}` : `<${e.name}> element ${ti}`
        if (cpIdx < 0) {
          lines.push(`${label}: clip reference url(#${e.clipId}) unresolved`)
          continue
        }
        const line = escapeLine(ti, ti, cpIdx, label)
        if (line.includes("ESCAPES")) escapes++
        lines.push(line)
      }
      if (usages.length > 40) lines.push(`… and ${usages.length - 40} more usages`)
      return {
        title: `${escapes} of ${usages.length} clip usage${usages.length > 1 ? "s" : ""} escape`,
        output: `${usages.length} clip usage${usages.length > 1 ? "s" : ""} in ${args.path}:\n` + lines.join("\n"),
      }
    }

    // --- containment-check -------------------------------------------------------
    if (args.operation === "containment-check") {
      const want = stripHash(args.element)
      if (!want) throw new Error(`operation "containment-check" requires an element id, e.g. { "element": "artwork" }`)
      const { ti, dupNote } = resolveElement(els, want, args.path)
      const { box: aBox, err: aErr } = elBBox(svg, els, ti)
      if (aErr) throw new Error(`Cannot compute bounds for #${want} in ${args.path}: ${aErr}`)
      if (!aBox) {
        return {
          title: `Bounds unavailable for #${want}`,
          output: `#${want} produced no geometric bounds — it may be display:none, visibility:hidden, or fully clipped.${dupNote}`,
        }
      }

      const otherFile = args.against_file ?? args.path
      const other = await loadSvg(otherFile)
      const oEls = args.against_file ? indexElements(other.svg) : els
      const wantB = stripHash(args.against_element) || want
      const { ti: tiB, dupNote: dupB } = resolveElement(oEls, wantB, otherFile)
      if (oEls === els && tiB === ti) {
        return { title: "Same element", output: `#${want} is trivially inside itself — pass a different against_element or against_file.` }
      }
      const elB = oEls[tiB]

      // A non-rendering "against" element (defs/clipPath) can still act as the
      // container: instance it at the origin with <use>, or measure clipPath
      // geometry in root coordinates.
      let bBox: Box | undefined
      let bNote = ""
      if (elB.dead) {
        if (elB.name === "clipPath") {
          bBox = clipBBox(other.svg, oEls, tiB, "")
          bNote = ` (clipPath #${wantB} measured at root coordinates — a clip usage's own transform chain may place it differently)`
        } else {
          bBox = measureBBox(other.svg, oEls, oEls.map((e) => e.dead), `<use href="#${esc(wantB)}"/>`).box
          bNote = ` (#${wantB} never renders directly — measured as if instanced at the origin)`
        }
      } else {
        bBox = elBBox(other.svg, oEls, tiB).box
      }
      if (!bBox) {
        return {
          title: `Bounds unavailable for #${wantB}`,
          output: `#${wantB} in ${otherFile} produced no measurable bounds.${dupB}`,
        }
      }

      const over = overflowParts(aBox, bBox)
      const crossFile = args.against_file ? `\n(each side measured in its own file's coordinate space)` : ""
      return {
        title: over.length ? `#${want} escapes` : `#${want} inside`,
        output:
          `#${want} [${boxText(aBox)}] vs #${wantB} [${boxText(bBox)}] in ${otherFile}${bNote}\n` +
          (over.length ? `NOT fully inside — escapes ${over.join(", ")}` : `fully inside`) +
          crossFile + dupNote + dupB,
      }
    }

    // --- bounds ----------------------------------------------------------------
    const want = stripHash(args.element)
    if (!want) throw new Error(`operation "bounds" requires an element id, e.g. { "element": "saddle" }`)
    const { ti, dupNote } = resolveElement(els, want, args.path)
    const target = els[ti]

    if (target.dead) {
      const container = els[target.parent >= 0 ? target.parent : ti].name
      return {
        title: `Bounds unavailable for #${want}`,
        output:
          `#${want} is inside <${container}> — it is never rendered directly, so it has no position of its own.\n` +
          `Query the id of a <use> element (or other rendered element) that instances it to get rendered bounds.`,
      }
    }

    const { box: bbox, err: mErr } = elBBox(svg, els, ti)
    if (mErr) throw new Error(`Cannot compute bounds for #${want} in ${args.path}: ${mErr}`)
    if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) {
      return {
        title: `Bounds unavailable for #${want}`,
        output: `#${want} produced no geometric bounds — it may be display:none, visibility:hidden, fully clipped, or otherwise invisible.${dupNote}`,
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
