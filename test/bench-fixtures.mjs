// Benchmark fixtures: each isolates one SVG construct that could plausibly
// blow up under region magnification. All use viewBox="0 0 1200 800" so the
// zoom ladder in bench.mix maps cleanly to ~1x/2x/4x/8x/16x.

const seed = { s: 42 }
const rand = () => (seed.s = (seed.s * 1103515245 + 12345) % 2147483648) / 2147483648
const palette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"]

function blob(cx, cy, r, fill, extra = "") {
  const a = rand() * r, b = rand() * r, c = rand() * r, d = rand() * r
  return `<path d="M${cx} ${cy} c${a.toFixed(1)} ${(-b).toFixed(1)} ${c.toFixed(1)} ${d.toFixed(1)} 0 ${r.toFixed(1)} c${(-a).toFixed(1)} ${b.toFixed(1)} ${(-c).toFixed(1)} ${(-d).toFixed(1)} 0 ${(-r).toFixed(1)} Z" fill="${fill}" fill-opacity="0.8" stroke="#0f172a" stroke-width="1.2" ${extra}/>`
}

const head = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1200 800">`
const tail = `</svg>`

export const benchFixtures = {}

// --- many paths (no effects) -------------------------------------------------
{
  seed.s = 42
  const parts = [head, `<rect width="1200" height="800" fill="#fef3c7"/>`]
  for (let i = 0; i < 400; i++) parts.push(blob(rand() * 1200, rand() * 800, 5 + rand() * 30, palette[i % 8]))
  parts.push(tail)
  benchFixtures.bpaths = parts.join("\n")
}

// --- clip paths ---------------------------------------------------------------
{
  seed.s = 7
  const parts = [head, `<defs>`]
  for (let i = 0; i < 8; i++)
    parts.push(`<clipPath id="cp${i}"><circle cx="${(i % 4) * 300 + 150}" cy="${Math.floor(i / 4) * 400 + 200}" r="140"/></clipPath>`)
  parts.push(`</defs><rect width="1200" height="800" fill="#fff"/>`)
  for (let i = 0; i < 8; i++) {
    parts.push(`<g clip-path="url(#cp${i})">`)
    for (let j = 0; j < 25; j++) parts.push(blob(rand() * 1200, rand() * 800, 8 + rand() * 25, palette[(i + j) % 8]))
    parts.push(`</g>`)
  }
  parts.push(tail)
  benchFixtures.bclip = parts.join("\n")
}

// --- masks ---------------------------------------------------------------------
{
  seed.s = 11
  const parts = [head, `<defs>`]
  for (let i = 0; i < 6; i++)
    parts.push(`<mask id="m${i}"><rect x="0" y="0" width="1200" height="800" fill="white"/><circle cx="${200 + i * 160}" cy="400" r="${60 + i * 10}" fill="black"/></mask>`)
  parts.push(`</defs><rect width="1200" height="800" fill="#f8fafc"/>`)
  for (let i = 0; i < 6; i++) {
    parts.push(`<g mask="url(#m${i})">`)
    for (let j = 0; j < 30; j++) parts.push(blob(rand() * 1200, rand() * 800, 10 + rand() * 20, palette[(i * 3 + j) % 8]))
    parts.push(`</g>`)
  }
  parts.push(tail)
  benchFixtures.bmask = parts.join("\n")
}

// --- gradients ------------------------------------------------------------------
{
  seed.s = 13
  const parts = [head, `<defs>`]
  for (let i = 0; i < 10; i++)
    parts.push(`<linearGradient id="lg${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[i % 8]}"/><stop offset="1" stop-color="${palette[(i + 3) % 8]}"/></linearGradient>`)
  for (let i = 0; i < 10; i++)
    parts.push(`<radialGradient id="rg${i}"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${palette[(i + 5) % 8]}"/></radialGradient>`)
  parts.push(`</defs><rect width="1200" height="800" fill="#fff"/>`)
  for (let i = 0; i < 200; i++)
    parts.push(`<rect x="${rand() * 1100}" y="${rand() * 700}" width="${20 + rand() * 80}" height="${20 + rand() * 80}" fill="url(#${rand() > 0.5 ? "lg" : "rg"}${i % 10})"/>`)
  parts.push(tail)
  benchFixtures.bgrad = parts.join("\n")
}

// --- filters (prime suspect: filter surfaces rasterize at screen resolution) ----
{
  seed.s = 17
  const parts = [head, `<defs>`]
  parts.push(`<filter id="blur"><feGaussianBlur stdDeviation="6"/></filter>`)
  parts.push(`<filter id="bigblur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="20"/></filter>`)
  parts.push(`<filter id="shadow"><feDropShadow dx="8" dy="8" stdDeviation="10"/></filter>`)
  parts.push(`<filter id="turb"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3"/><feDisplacementMap in="SourceGraphic" scale="30"/></filter>`)
  parts.push(`</defs><rect width="1200" height="800" fill="#fff7ed"/>`)
  const filters = ["blur", "bigblur", "shadow", "turb"]
  for (let i = 0; i < 60; i++)
    parts.push(blob(rand() * 1200, rand() * 800, 10 + rand() * 40, palette[i % 8], `filter="url(#${filters[i % 4]})"`))
  parts.push(tail)
  benchFixtures.bfilter = parts.join("\n")
}

// --- filters applied to a huge group (worst case: surface spans whole canvas) ---
{
  seed.s = 19
  const parts = [head, `<defs><filter id="gblur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter></defs>`]
  parts.push(`<rect width="1200" height="800" fill="#fff"/><g filter="url(#gblur)">`)
  for (let i = 0; i < 80; i++) parts.push(blob(rand() * 1200, rand() * 800, 10 + rand() * 30, palette[i % 8]))
  parts.push(`</g>${tail}`)
  benchFixtures.bfilterGroup = parts.join("\n")
}

// --- patterns --------------------------------------------------------------------
{
  const parts = [head, `<defs>`,
    `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="5" fill="#3b82f6"/></pattern>`,
    `<pattern id="stripes" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="16" fill="#f97316"/></pattern>`,
    `</defs><rect width="1200" height="800" fill="#fff"/>`]
  for (let i = 0; i < 12; i++)
    parts.push(`<rect x="${(i % 4) * 300 + 10}" y="${Math.floor(i / 4) * 260 + 10}" width="280" height="240" rx="20" fill="url(#${i % 2 ? "dots" : "stripes"})" stroke="#0f172a"/>`)
  parts.push(tail)
  benchFixtures.bpattern = parts.join("\n")
}

// --- embedded raster image ---------------------------------------------------------
{
  // Build a real 16x16 RGBA PNG data URI (zlib only, no deps).
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(t))
    return Buffer.concat([len, t, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(16, 0)
  ihdr.writeUInt32BE(16, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(16 * (1 + 16 * 4))
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const o = y * 65 + 1 + x * 4
      raw[o] = (x * 16) & 255
      raw[o + 1] = (y * 16) & 255
      raw[o + 2] = 128
      raw[o + 3] = 255
    }
  const zlib = await import("node:zlib")
  const pngBuf = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
  const png = `data:image/png;base64,${pngBuf.toString("base64")}`
  const parts = [head, `<rect width="1200" height="800" fill="#f1f5f9"/>`,
    `<image href="${png}" x="100" y="100" width="600" height="400" preserveAspectRatio="none"/>`,
    `<image href="${png}" x="700" y="300" width="300" height="300" preserveAspectRatio="none" transform="rotate(15 850 450)"/>`]
  for (let i = 0; i < 20; i++)
    parts.push(`<image href="${png}" x="${(i * 57) % 1100}" y="${(i * 89) % 700}" width="64" height="64"/>`)
  parts.push(tail)
  benchFixtures.bimage = parts.join("\n")
}

// --- text --------------------------------------------------------------------------
{
  seed.s = 23
  const parts = [head, `<rect width="1200" height="800" fill="#fff"/>`]
  for (let i = 0; i < 80; i++)
    parts.push(`<text x="${rand() * 1100}" y="${rand() * 780}" font-size="${10 + rand() * 30}" fill="${palette[i % 8]}" font-family="serif">node ${i}</text>`)
  parts.push(tail)
  benchFixtures.btext = parts.join("\n")
}

// --- transformed groups --------------------------------------------------------------
{
  seed.s = 29
  const parts = [head, `<rect width="1200" height="800" fill="#ecfeff"/>`]
  for (let i = 0; i < 60; i++) {
    parts.push(`<g transform="translate(${rand() * 1100} ${rand() * 700}) rotate(${rand() * 360}) scale(${0.5 + rand() * 2})">`)
    parts.push(blob(0, 0, 10 + rand() * 25, palette[i % 8]))
    parts.push(`<g transform="translate(20 10) rotate(30)">${blob(0, 0, 8 + rand() * 15, palette[(i + 2) % 8])}</g>`)
    parts.push(`</g>`)
  }
  parts.push(tail)
  benchFixtures.btransform = parts.join("\n")
}

// --- kitchen sink: clip + mask + filter + gradient + text + transforms ----------------
{
  seed.s = 31
  const parts = [head, `<defs>`,
    `<clipPath id="sil"><circle cx="600" cy="400" r="360"/></clipPath>`,
    `<mask id="fade"><rect width="1200" height="800" fill="url(#fadeG)"/><linearGradient id="fadeG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient></mask>`,
    `<filter id="soft"><feGaussianBlur stdDeviation="4"/></filter>`,
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#fef3c7"/></linearGradient>`,
    `</defs>`,
    `<rect width="1200" height="800" fill="url(#sky)"/>`,
    `<g clip-path="url(#sil)"><g mask="url(#fade)">`]
  for (let i = 0; i < 150; i++) {
    const f = i % 7 === 0 ? ` filter="url(#soft)"` : ""
    parts.push(`<g transform="translate(${rand() * 1100} ${rand() * 700}) rotate(${rand() * 360})">${blob(0, 0, 8 + rand() * 30, palette[i % 8], "")}${f ? `<circle cx="0" cy="0" r="30" fill="${palette[(i + 1) % 8]}"${f}/>` : ""}</g>`)
  }
  parts.push(`</g>`)
  for (let i = 0; i < 12; i++)
    parts.push(`<text x="${100 + (i % 4) * 280}" y="${150 + Math.floor(i / 4) * 250}" font-size="28" fill="#0f172a">label ${i}</text>`)
  parts.push(`</g>${tail}`)
  benchFixtures.bmix = parts.join("\n")
}
