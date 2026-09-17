// Benchmark/reproduction harness for the region+overlay performance question.
// Times renderAsync directly on raw vs. tool-mutated SVG so resvg cost and
// overlay-generation cost are measured separately.
//   node test/bench.mjs [fixture-filter]
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { renderAsync } from "../.opencode/node_modules/@resvg/resvg-js/index.js"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tool = (await import(pathToFileURL(path.join(repo, ".opencode/tools/svg_render.ts")).href)).default

const tmp = path.join(repo, "test", "tmp")
await mkdir(tmp, { recursive: true })
const ctx = { directory: tmp }

const { benchFixtures } = await import("./bench-fixtures.mjs")
const filter = process.argv[2]
for (const [name, src] of Object.entries(benchFixtures)) {
  if (filter && !name.includes(filter)) continue
  await writeFile(path.join(tmp, `${name}.svg`), src)
}

// Render a fixture through the tool at a given region zoom + overlay, report
// wall time. A cell that exceeds 40s wall-clock is reported as WEDGED rather
// than stalling the matrix (the tool itself bounds work at ~20s).
async function toolTime(file, { region, overlay, width = 1200 } = {}) {
  const t0 = performance.now()
  const giveUp = new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error("WEDGED>40s")), 40000)
    t.unref()
  })
  await Promise.race([tool.execute({ path: file, width, region, overlay }, ctx), giveUp])
  return performance.now() - t0
}

const median = async (fn, n = 2) => {
  await fn() // warmup
  const ts = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await fn()
    ts.push(performance.now() - t)
  }
  return ts.sort((a, b) => a - b)[ts.length >> 1]
}

// Magnification ladder: regions sized so region.width → 1200px output gives
// ~1x, 2x, 4x, 8x, 16x against a 1200-unit-wide viewBox.
const ZOOMS = [
  ["full", null],
  ["~1x", { x: 0, y: 0, width: 1200, height: 800 }],
  ["~2x", { x: 300, y: 200, width: 600, height: 400 }],
  ["~4x", { x: 450, y: 300, width: 300, height: 200 }],
  ["~8x", { x: 525, y: 350, width: 150, height: 100 }],
  ["~16x", { x: 587, y: 375, width: 75, height: 50 }],
]

const names = Object.keys(benchFixtures).filter((n) => !filter || n.includes(filter))
for (const name of names) {
  const file = `${name}.svg`
  console.log(`\n=== ${file} ===`)
  console.log("zoom        none     grid     clip   grid+clip")
  for (const [label, region] of ZOOMS) {
    const row = [label.padEnd(10)]
    for (const overlay of [undefined, "grid", "clip", "grid+clip"]) {
      try {
        const ms = await median(() => toolTime(file, { region, overlay }), 3)
        row.push(`${ms.toFixed(0).padStart(6)} ms`)
      } catch (e) {
        row.push(`  ERR:${(e.message || e).slice(0, 40)}`)
      }
    }
    console.log(row.join("  "))
  }
}
