// Verification harness for svg_render — invokes the tool's execute() directly
// against the fixtures in test/tmp/. Run from the repo root:
//   node test/verify.mjs
import { mkdir, writeFile, readFile, symlink, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import zlib from "node:zlib"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
// pathToFileURL keeps the absolute .ts import working on Windows (C:\... is not
// a valid ESM specifier).
const tool = (await import(pathToFileURL(path.join(repo, ".opencode/tools/svg_render.ts")).href)).default

const tmp = path.join(repo, "test", "tmp")
await rm(tmp, { recursive: true, force: true })
await mkdir(tmp, { recursive: true })
const ctx = { directory: tmp }

const { fixtures } = await import("./fixtures.mjs")
for (const [name, src] of Object.entries(fixtures))
  await writeFile(path.join(tmp, `${name}.svg`), src)

// --- helpers ---------------------------------------------------------------
let pass = 0, fail = 0
const check = (name, cond, extra = "") => {
  if (cond) pass++
  else {
    fail++
    console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

const png = (att) => Buffer.from(att.url.split(",")[1], "base64")
const pngSize = (att) => {
  const b = png(att)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }
}

// Decode PNG → RGBA buffer (no deps; assumes resvg's 8-bit RGBA output).
function decodePng(att) {
  const b = png(att)
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20)
  const colorType = b[25]
  let idat = []
  let off = 8
  while (off < b.length) {
    const len = b.readUInt32BE(off)
    if (b.toString("ascii", off + 4, off + 8) === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const bb = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + bb) & 255
      else if (f === 3) v = (v + ((a + bb) >> 1)) & 255
      else if (f === 4) {
        const p = a + bb - c
        const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { w, h, bpp, data: out }
}
const px = (img, x, y) => {
  const o = (y * img.w + x) * img.bpp
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.bpp === 4 ? img.data[o + 3] : 255]
}

const run = async (args) => {
  try {
    return { res: await tool.execute(args, ctx) }
  } catch (e) {
    return { err: e }
  }
}
const countColor = (img, test) => {
  let n = 0
  for (let i = 0; i < img.w * img.h; i++) if (test(img.data[i * img.bpp], img.data[i * img.bpp + 1], img.data[i * img.bpp + 2])) n++
  return n
}

// --- 1. basic render -------------------------------------------------------
console.log("· basic render")
{
  const { res, err } = await run({ path: "basic.svg" })
  check("no error", !err, err?.message)
  const s = pngSize(res.attachments[0])
  check("1600 wide", s.w === 1600, `${s.w}`)
  check("aspect kept (1600x800)", s.h === 800, `${s.h}`)
  check("attachment mime", res.attachments[0].mime === "image/png")
  const img = decodePng(res.attachments[0])
  const mid = px(img, 480, 400) // red circle center-ish (60/200*1600=480)
  check("red circle visible", mid[0] > 180 && mid[1] < 80, mid.join(","))
  check("png file written", (await stat(path.join(tmp, ".opencode/renders/basic.png"))).size > 0)
  check("viewBox reported", res.output.includes("SVG viewBox: 0 0 200 100"))
  check("region reported full", res.output.includes("Render region: full viewBox"))
  check("hashes present", /Source: [0-9a-f]{12}/.test(res.output) && /PNG: [0-9a-f]{12}/.test(res.output))
  check("background reported", res.output.includes("Background: #f2f2f2"))
}

// --- 2. text svg still works ----------------------------------------------
{
  const { res, err } = await run({ path: "text.svg" })
  check("text svg renders", !err && pngSize(res?.attachments[0] ?? { url: "x:" }).w === 1600, err?.message)
}

// --- 3. transparent background --------------------------------------------
{
  const { res } = await run({ path: "transparent.svg", background: "transparent" })
  const img = decodePng(res.attachments[0])
  const corner = px(img, 4, 4)
  check("transparent alpha preserved", img.bpp === 4 && corner[3] === 0, corner.join(","))
  const { res: res2 } = await run({ path: "transparent.svg" })
  const img2 = decodePng(res2.attachments[0])
  const corner2 = px(img2, 4, 4)
  check("default bg #f2f2f2 fills alpha", corner2[3] === 255 && corner2[0] === 242 && corner2[1] === 242, corner2.join(","))
}

// --- 4. dark/white artwork on neutral bg ----------------------------------
{
  const { res } = await run({ path: "dark.svg" })
  const img = decodePng(res.attachments[0])
  const c = px(img, 800, 800)
  check("dark art visible on gray", c[0] < 60, c.join(","))
  const { res: w } = await run({ path: "white.svg" })
  const imgw = decodePng(w.attachments[0])
  const cw = px(imgw, 800, 800)
  check("white art distinguishable from bg", cw[0] > 245, cw.join(","))
  const edge = px(imgw, 20, 20)
  check("gray bg around white art", Math.abs(edge[0] - 242) < 4, edge.join(","))
}

// --- 5. region render ------------------------------------------------------
{
  const { res, err } = await run({ path: "clipped.svg", region: { x: 205, y: 85, width: 80, height: 80 } })
  check("region render ok", !err, err?.message)
  const s = pngSize(res.attachments[0])
  check("region output 1600", s.w === 1600 && s.h === 1600, `${s.w}x${s.h}`)
  check("region reported", res.output.includes("Render region: 205 85 80 80"))
  const img = decodePng(res.attachments[0])
  // heart ~ (245,115) in region (205..285, 85..165): rel (40,30)/80 → px (800,600)
  const heart = px(img, 800, 600)
  check("heart visible at expected px", heart[0] > 150 && heart[2] < 120, heart.join(","))
  // invalid regions
  for (const [nm, r] of [
    ["zero width", { x: 0, y: 0, width: 0, height: 5 }],
    ["neg height", { x: 0, y: 0, width: 5, height: -2 }],
    ["NaN", { x: NaN, y: 0, width: 5, height: 5 }],
    ["Infinity", { x: 0, y: 0, width: Infinity, height: 5 }],
  ]) {
    const { err } = await run({ path: "basic.svg", region: r })
    check(`region rejected: ${nm}`, !!err)
  }
  // non-square region aspect
  const { res: ns } = await run({ path: "clipped.svg", region: { x: 0, y: 0, width: 512, height: 128 } })
  const ss = pngSize(ns.attachments[0])
  check("non-square region aspect", ss.h === 400, `${ss.w}x${ss.h}`)
}

// --- 6. grid overlay --------------------------------------------------------
{
  const { res, err } = await run({ path: "basic.svg", overlay: "grid" })
  check("grid render ok", !err, err?.message)
  check("overlay reported", res.output.includes("Overlay: grid"))
  const img = decodePng(res.attachments[0])
  const blueish = countColor(img, (r, g, b) => b > 150 && b > r + 30)
  check("grid lines drawn", blueish > 1500, `${blueish} px`)
  const srcAfter = await readFile(path.join(tmp, "basic.svg"), "utf8")
  check("source unchanged by grid", srcAfter === fixtures.basic)
  const { res: rg } = await run({ path: "clipped.svg", region: { x: 205, y: 85, width: 80, height: 80 }, overlay: "grid" })
  check("grid+region ok", !!rg)
}

// --- 7. clip overlay --------------------------------------------------------
{
  const { res, err } = await run({ path: "clipped.svg", overlay: "clip" })
  check("clip render ok", !err, err?.message)
  check("clip reported", res.output.includes("Overlay: clip"))
  check("outline count", res.output.includes("1 outlined"), res.output)
  const img = decodePng(res.attachments[0])
  // silhouette clip is a circle r=200 centered 256 → outline should be pinkish
  const pinkish = countColor(img, (r, g, b) => r > 200 && b > 100 && b > g + 30)
  check("clip outline drawn", pinkish > 500, `${pinkish} px`)
  // the hidden purple circle at (480,480) stays hidden — correct semantics:
  const purple = countColor(img, (r, g, b) => r > 90 && r < 150 && b > 180)
  check("clipped element still not rendered", purple < 50, `${purple} px`)
  const srcAfter = await readFile(path.join(tmp, "clipped.svg"), "utf8")
  check("source unchanged by clip overlay", srcAfter === fixtures.clipped)

  const { res: tr, err: trErr } = await run({ path: "clipTransformed.svg", overlay: "clip" })
  check("transformed clip ok", !trErr, trErr?.message)
  check("transformed clip count", tr?.output.includes("1 outlined") ?? false, tr?.output ?? "")
  const img2 = decodePng(tr.attachments[0])
  const pink2 = countColor(img2, (r, g, b) => r > 200 && b > 100 && b > g + 30)
  check("transformed outline drawn", pink2 > 300, `${pink2} px`)
  // clip rect 0..60 under translate(100,50) scale(1.5) → viewBox x 100..190, y 50..140
  // → px x 400..760, y 200..560 in a 1600x800 render
  let inBox = 0, total = 0
  for (let y = 0; y < img2.h; y += 2)
    for (let x = 0; x < img2.w; x += 2) {
      const [r, g, b] = px(img2, x, y)
      if (r > 200 && b > 100 && b > g + 30) {
        total++
        if (x >= 390 && x <= 780 && y >= 190 && y <= 580) inBox++
      }
    }
  check("outline positioned in transformed area", inBox > 50 && inBox / Math.max(total, 1) > 0.7, `${inBox}/${total}`)

  const { res: m, err: mErr } = await run({ path: "clipMulti.svg", overlay: "clip" })
  check("multi clip count", m?.output.includes("2 outlined") ?? false, mErr?.message ?? m?.output)

  const { res: gc, err: gcErr } = await run({ path: "clipped.svg", overlay: "grid+clip" })
  check("grid+clip ok", gc?.output.includes("Overlay: grid+clip") ?? false, gcErr?.message)

  // edge cases
  const { res: sc, err: scErr } = await run({ path: "selfClosing.svg", overlay: "grid", region: { x: 0, y: 0, width: 25, height: 25 } })
  check("self-closing root + region + grid ok", !scErr, scErr?.message)
  const { res: sc2, err: sc2Err } = await run({ path: "selfClosing.svg", overlay: "grid" })
  check("self-closing root + grid ok", !sc2Err, sc2Err?.message)

  const { res: obb } = await run({ path: "clipObb.svg", overlay: "clip" })
  check("objectBoundingBox skipped with note", obb?.output.includes("objectBoundingBox") ?? false, obb?.output)
  const { res: dd } = await run({ path: "clipInDefs.svg", overlay: "clip" })
  check("defs-contained usage → 0 outlined", dd?.output.includes("0 outlined") ?? false, dd?.output)
}

// --- 7b. nested <svg> viewport clip usages -----------------------------------
{
  const magenta = (r, g, b) => r > 200 && b > 100 && b > g + 30

  const { res: norm, err: normErr } = await run({ path: "nestedSvg.svg" })
  check("nested svg renders", !normErr, normErr?.message)
  const nImg = decodePng(norm.attachments[0])
  const blue = countColor(nImg, (r, g, b) => b > 180 && r < 90)
  const green = countColor(nImg, (r, g, b) => g > 120 && r < 90 && b < 90)
  check("nested svg artwork visible (blue)", blue > 5000, `${blue} px`)
  check("root-level artwork visible (green)", green > 5000, `${green} px`)

  const { res: clip, err: clipErr } = await run({ path: "nestedSvg.svg", overlay: "clip" })
  check("nested svg clip overlay renders", !clipErr, clipErr?.message)
  check(
    "nested usage skipped and reported",
    clip?.output.includes("1 outlined, 1 nested SVG usage skipped") ?? false,
    clip?.output,
  )
  const cImg = decodePng(clip.attachments[0])
  // The skipped usage must not produce an outline anywhere in the nested
  // viewport region (x 100..300, y 50..150 of 500 → px 320..960, 160..480).
  let strayInViewport = 0
  for (let y = 160; y < 480; y += 2)
    for (let x = 320; x < 960; x += 2) {
      const [r, g, b] = px(cImg, x, y)
      if (magenta(r, g, b)) strayInViewport++
    }
  check("no misleading outline in nested viewport", strayInViewport === 0, `${strayInViewport} px`)
  // Control: the root-level usage is still outlined at translate(300,300) →
  // clip rect 0..60 → px 960..1152.
  let rootOutline = 0
  for (let y = 940; y < 1170; y += 2)
    for (let x = 940; x < 1170; x += 2) {
      const [r, g, b] = px(cImg, x, y)
      if (magenta(r, g, b)) rootOutline++
    }
  check("root-level clip still outlined", rootOutline > 50, `${rootOutline} px`)
  check("nested svg artwork unchanged by overlay", countColor(cImg, (r, g, b) => b > 180 && r < 90) > 5000)

  const srcAfter = await readFile(path.join(tmp, "nestedSvg.svg"), "utf8")
  check("nested svg source unchanged", srcAfter === fixtures.nestedSvg)
}

// --- 7d. clipPath defined in a nested viewport, used outside it ---------------
// resvg resolves userSpaceOnUse clip contents in the REFERENCING element's user
// space, so this outline must be drawn at the usage-space position. The clip
// rect 0..50 with the clipPath's own translate(10,0) lands at root x 10..60,
// y 0..50 — the nested viewport (x=200, translate(50,0)) must not shift it.
{
  const magenta = (r, g, b) => r > 200 && b > 100 && b > g + 30
  const green = (r, g, b) => g > 120 && r < 90 && b < 90

  const { res: norm, err: normErr } = await run({ path: "clipDefinedInNestedSvg.svg" })
  check("nested-defined clip renders", !normErr, normErr?.message)
  const nImg = decodePng(norm.attachments[0])
  // clip rect 50x50 units at 4 px/unit = 40_000 px of green. A full-canvas
  // render would be 1_280_000 px, so this also proves the clip was applied.
  const nGreen = countColor(nImg, green)
  check("nested-defined clip applied in usage space", Math.abs(nGreen - 40000) < 8000, `${nGreen} px`)
  let greenAtDefinition = 0
  for (let y = 0; y < nImg.h; y += 2)
    for (let x = 800; x < nImg.w; x += 2) {
      const [r, g, b] = px(nImg, x, y)
      if (green(r, g, b)) greenAtDefinition++
    }
  check("no clipped artwork at definition-site position", greenAtDefinition === 0, `${greenAtDefinition} px`)

  const { res: clip, err: clipErr } = await run({ path: "clipDefinedInNestedSvg.svg", overlay: "clip" })
  check("nested-defined clip overlay renders", !clipErr, clipErr?.message)
  check("nested-defined clip is outlined, not skipped", clip?.output.includes("1 outlined") ?? false, clip?.output)
  check(
    "no nested-usage skip reported for a root usage",
    !(clip?.output.includes("nested SVG usage skipped") ?? false),
    clip?.output,
  )
  const cImg = decodePng(clip.attachments[0])
  // usage space: x 10..60, y 0..50 of 400x200 → px 40..240, y 0..200 at 1600 wide
  let atUsage = 0
  for (let y = 0; y < 210; y += 2)
    for (let x = 30; x < 260; x += 2) {
      const [r, g, b] = px(cImg, x, y)
      if (magenta(r, g, b)) atUsage++
    }
  check("outline drawn at usage-space position", atUsage > 50, `${atUsage} px`)
  // definition site (nested viewport occupies x 200..400 → px 800..1600): no outline
  let atDefinition = 0
  for (let y = 0; y < cImg.h; y += 2)
    for (let x = 500; x < cImg.w; x += 2) {
      const [r, g, b] = px(cImg, x, y)
      if (magenta(r, g, b)) atDefinition++
    }
  check("no outline at definition-site position", atDefinition === 0, `${atDefinition} px`)

  const srcAfter = await readFile(path.join(tmp, "clipDefinedInNestedSvg.svg"), "utf8")
  check("nested-defined clip source unchanged", srcAfter === fixtures.clipDefinedInNestedSvg)
}

// --- 7c. duplicate ids in copied clip geometry -------------------------------
{
  const pink = (r, g, b) => Math.abs(r - 190) < 12 && Math.abs(g - 24) < 12 && Math.abs(b - 93) < 12
  const blue = (r, g, b) => Math.abs(r - 37) < 12 && Math.abs(g - 99) < 12 && Math.abs(b - 235) < 12

  const { res: norm, err: normErr } = await run({ path: "duplicateIds.svg" })
  check("duplicate-id fixture renders", !normErr, normErr?.message)
  const nImg = decodePng(norm.attachments[0])
  const nPink = countColor(nImg, pink)
  const nBlue = countColor(nImg, blue)
  check("referenced ids render normally", nPink > 500 && nBlue > 500, `pink=${nPink} blue=${nBlue}`)

  const { res: clip, err: clipErr } = await run({ path: "duplicateIds.svg", overlay: "clip" })
  check("duplicate-id clip overlay renders", !clipErr, clipErr?.message)
  check("duplicate-id outline drawn", clip?.output.includes("1 outlined") ?? false, clip?.output)
  const cImg = decodePng(clip.attachments[0])
  // Copied geometry duplicates id="clip-part"; the <use href="#clip-part"> and
  // <use href="#shared-shape"> instances must be unaffected by that.
  check("unrelated pink use unchanged", countColor(cImg, pink) === nPink, `${countColor(cImg, pink)} vs ${nPink}`)
  check("unrelated blue use unchanged", countColor(cImg, blue) === nBlue, `${countColor(cImg, blue)} vs ${nBlue}`)
  check("debug outline appears", countColor(cImg, (r, g, b) => r > 200 && b > 100 && b > g + 30) > 200)
}

// --- 8. hashes --------------------------------------------------------------
{
  const a = await run({ path: "basic.svg" })
  const b = await run({ path: "basic.svg" })
  check("same source → same source hash", a.res.metadata.sourceSha256 === b.res.metadata.sourceSha256)
  check("same render → same png hash", a.res.metadata.pngSha256 === b.res.metadata.pngSha256)
  await writeFile(path.join(tmp, "basic.svg"), fixtures.basic.replace("#dc2626", "#16a34a"))
  const c = await run({ path: "basic.svg" })
  check("edited source → new source hash", c.res.metadata.sourceSha256 !== a.res.metadata.sourceSha256)
  check("edited render → new png hash", c.res.metadata.pngSha256 !== a.res.metadata.pngSha256)
  await writeFile(path.join(tmp, "basic.svg"), fixtures.basic) // restore
}

// --- 9. security ------------------------------------------------------------
{
  const { err: e1 } = await run({ path: "../outside.svg" })
  check("traversal rejected", /escapes|not found|Expected/.test(e1?.message ?? ""), e1?.message)
  const { err: e2 } = await run({ path: "missing.svg" })
  check("missing file rejected", /not found/.test(e2?.message ?? ""), e2?.message)
  await writeFile(path.join(tmp, "notsvg.svg.png"), "x")
  const { err: e3 } = await run({ path: "notsvg.svg.png" })
  check("non-.svg rejected", /\.svg/.test(e3?.message ?? ""), e3?.message)
  // symlink escape — creating symlinks needs privileges on Windows, so a setup
  // failure there is reported as skipped rather than as a test failure.
  await writeFile(path.join(tmp, "..", "secret-outside.svg"), "<svg/>").catch(() => {})
  try {
    await symlink(path.join(tmp, "..", "secret-outside.svg"), path.join(tmp, "link.svg"), "file")
    const { err: e4 } = await run({ path: "link.svg" })
    check("symlink escape rejected", /escapes/.test(e4?.message ?? ""), e4?.message)
  } catch (e) {
    if (e?.code === "EPERM" || e?.code === "EACCES") console.log(`  skip symlink escape test (${e.code}: no symlink privilege)`)
    else check("symlink escape rejected", false, `setup failed: ${e.message}`)
  }
  await rm(path.join(tmp, "..", "secret-outside.svg"), { force: true })
}

// --- 10. cancellation --------------------------------------------------------
{
  const ctl = new AbortController()
  ctl.abort()
  const { err } = await (async () => {
    try {
      return { res: await tool.execute({ path: "basic.svg" }, { directory: tmp, abort: ctl.signal }) }
    } catch (e) {
      return { err: e }
    }
  })()
  check("pre-aborted render throws", !!err, err?.message ?? "no error")
}

// --- 11. no-viewBox reporting ------------------------------------------------
{
  const { res } = await run({ path: "noViewBox.svg" })
  check("no-viewBox reported", res.output.includes("no viewBox") || res.output.includes("width/height"), res.output)
  const { res: g, err: gErr } = await run({ path: "noViewBox.svg", overlay: "grid" })
  check("grid works on w/h-only svg", !!g && !gErr, gErr?.message)
}

// --- 12. performance ---------------------------------------------------------
console.log("· benchmark (heavy.svg, width 1600)")
{
  const bench = async (args) => {
    await tool.execute(args, ctx) // warmup
    const t0 = performance.now()
    const n = 3
    for (let i = 0; i < n; i++) await tool.execute(args, ctx)
    return (performance.now() - t0) / n
  }
  const results = {
    normal: await bench({ path: "heavy.svg" }),
    region: await bench({ path: "heavy.svg", region: { x: 300, y: 300, width: 200, height: 200 } }),
    grid: await bench({ path: "heavy.svg", overlay: "grid" }),
    clip: await bench({ path: "heavy.svg", overlay: "clip" }),
    "grid+clip": await bench({ path: "heavy.svg", overlay: "grid+clip" }),
  }
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(10)} ${v.toFixed(0)} ms`)

  // Informational: system fonts are only loaded when the SVG (or an overlay)
  // actually contains <text>, so the path-only render stays cheap.
  const median = async (args, n = 5) => {
    await tool.execute(args, ctx)
    const ts = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      await tool.execute(args, ctx)
      ts.push(performance.now() - t)
    }
    return ts.sort((a, b) => a - b)[n >> 1]
  }
  const noText = await median({ path: "heavy.svg" })
  const withText = await median({ path: "text.svg" })
  console.log(`  font check: path-only ${noText.toFixed(0)} ms vs text-bearing ${withText.toFixed(0)} ms`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
