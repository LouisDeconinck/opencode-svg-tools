// Test SVG fixtures for svg_render verification.
// Each fixture exercises one requirement; generated under test/tmp/.

export const fixtures = {
  // 1. Basic path-only SVG (no text → no system font load)
  basic: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="0" y="0" width="200" height="100" fill="#fed7aa"/>
  <circle cx="60" cy="50" r="30" fill="#dc2626"/>
  <path d="M120 20 L180 20 L150 80 Z" fill="#2563eb"/>
</svg>`,

  // 2. SVG with text (forces font loading path)
  text: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect width="200" height="100" fill="#fff"/>
  <text x="100" y="55" font-size="24" text-anchor="middle" fill="#111">Hello</text>
</svg>`,

  // 3. Sticker-like SVG with a clipPath on a <g>, an out-of-clip element,
  //    and small details for region inspection.
  clipped: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <clipPath id="silhouette"><circle cx="256" cy="256" r="200"/></clipPath>
  </defs>
  <rect width="512" height="512" fill="#fff7ed"/>
  <g clip-path="url(#silhouette)">
    <rect x="56" y="56" width="400" height="400" fill="#fbbf24"/>
    <path d="M56 400 Q256 300 456 400 L456 456 L56 456 Z" fill="#65a30d"/>
    <circle cx="256" cy="200" r="60" fill="#fff"/>
    <!-- small detail: heart at ~(245,115) -->
    <path d="M245 105 c-6 -8 -18 -8 -20 3 c-1 8 6 14 20 24 c14 -10 21 -16 20 -24 c-2 -11 -14 -11 -20 -3 Z" fill="#e11d48"/>
    <!-- inside the clipped group but outside the clip circle: silently invisible -->
    <circle cx="480" cy="480" r="40" fill="#7c3aed"/>
  </g>
</svg>`,

  // 4. Transformed clipped group
  clipTransformed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <defs>
    <clipPath id="half"><rect x="0" y="0" width="60" height="60"/></clipPath>
  </defs>
  <rect width="400" height="200" fill="#f1f5f9"/>
  <g transform="translate(100 50) scale(1.5)">
    <g clip-path="url(#half)">
      <rect x="0" y="0" width="120" height="120" fill="#0ea5e9"/>
      <circle cx="80" cy="80" r="40" fill="#f97316"/>
    </g>
  </g>
</svg>`,

  // 5. Multiple clip paths + clipPath with own transform
  clipMulti: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">
  <defs>
    <clipPath id="a"><rect x="0" y="0" width="50" height="100"/></clipPath>
    <clipPath id="b" transform="translate(200 0)"><circle cx="30" cy="50" r="30"/></clipPath>
  </defs>
  <rect width="300" height="100" fill="#fff"/>
  <g clip-path="url(#a)"><rect width="300" height="100" fill="#16a34a"/></g>
  <rect x="0" y="0" width="300" height="100" fill="#be185d" clip-path="url(#b)"/>
</svg>`,

  // 6. No viewBox, width/height only
  noViewBox: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">
  <rect width="300" height="150" fill="#e0e7ff"/>
  <circle cx="150" cy="75" r="50" fill="#4f46e5"/>
</svg>`,

  // 7. Transparent artwork (alpha channel inspection)
  transparent: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="rgba(220,38,38,0.6)"/>
  <rect x="30" y="30" width="40" height="40" fill="none" stroke="#1e40af" stroke-width="4"/>
</svg>`,

  // 8. Dark artwork (would vanish on a black viewer background)
  dark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#0f172a"/>
  <path d="M30 50 L70 50 M50 30 L50 70" stroke="#020617" stroke-width="6"/>
</svg>`,

  // 9. White artwork (would vanish on white)
  white: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#ffffff" stroke="#f8fafc" stroke-width="2"/>
</svg>`,

  // 10. Self-closing root (edge case for region+overlay splice)
  selfClosing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"/>`,

  // 11. clipPathUnits="objectBoundingBox" (unsupported for outlines — must warn)
  clipObb: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><clipPath id="obb" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath></defs>
  <rect width="100" height="100" fill="#0ea5e9" clip-path="url(#obb)"/>
</svg>`,

  // 12. clip usage inside <defs> only instanced via <use> — outline skipped
  clipInDefs: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="d"><circle cx="50" cy="50" r="30"/></clipPath>
    <g id="art" clip-path="url(#d)"><rect width="100" height="100" fill="#16a34a"/></g>
  </defs>
  <rect width="100" height="100" fill="#fff"/>
  <use href="#art"/>
</svg>`,

  // 13. Nested <svg> viewport with a clip usage inside it. The viewport mapping
  //     (x/y/width/height/viewBox) is not represented by ancestor transforms,
  //     so the outline must be skipped with a note rather than drawn wrong.
  //     The root-level usage in the same file must still be outlined.
  nestedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">
  <defs>
    <clipPath id="nclip"><circle cx="50" cy="50" r="40"/></clipPath>
    <clipPath id="rclip"><rect x="0" y="0" width="60" height="60"/></clipPath>
  </defs>
  <rect width="500" height="500" fill="#ffffff"/>
  <svg x="100" y="50" width="200" height="100" viewBox="0 0 100 100">
    <g clip-path="url(#nclip)">
      <rect x="0" y="0" width="100" height="100" fill="#0ea5e9"/>
    </g>
  </svg>
  <g clip-path="url(#rclip)" transform="translate(300 300)">
    <rect x="0" y="0" width="500" height="500" fill="#16a34a"/>
  </g>
</svg>`,

  // 14. Copied clip geometry carries ids that are also referenced elsewhere in
  //     the document — stresses duplicate ids in the diagnostic copy.
  duplicateIds: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">
  <defs>
    <path id="shared-shape" d="M0 0 H60 V60 H0 Z"/>
    <clipPath id="clip">
      <use href="#shared-shape"/>
      <path id="clip-part" d="M70 0 H90 V60 H70 Z"/>
    </clipPath>
  </defs>
  <rect width="300" height="150" fill="#ffffff"/>
  <g clip-path="url(#clip)" transform="translate(10 10)">
    <rect x="-10" y="-10" width="300" height="150" fill="#16a34a"/>
  </g>
  <use href="#clip-part" transform="translate(200 70)" fill="#be185d"/>
  <use href="#shared-shape" transform="translate(200 20)" fill="#2563eb"/>
</svg>`,

  // 15. clipPath DEFINED inside a nested <svg> viewport (which also carries its
  //     own transform) but REFERENCED by a root-level element. Per the SVG spec
  //     and verified resvg behavior, userSpaceOnUse clip contents resolve in the
  //     REFERENCING element's user space, so this outline IS supported: it must
  //     be drawn at the usage-space position, not the definition-site position.
  clipDefinedInNestedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <rect width="400" height="200" fill="#eeeeee"/>
  <svg x="200" y="0" width="200" height="200" viewBox="0 0 100 100" transform="translate(50 0)">
    <defs>
      <clipPath id="nested-def" transform="translate(10 0)">
        <rect x="0" y="0" width="50" height="50"/>
      </clipPath>
    </defs>
  </svg>
  <g clip-path="url(#nested-def)">
    <rect x="0" y="0" width="400" height="200" fill="#16a34a"/>
  </g>
</svg>`,

  // 16. Layer-creating elements completely OUTSIDE the viewBox — the exact
  //     trigger for the resvg-js 2.x native panic (geom.rs unwrap on empty
  //     intersection): filter, mask, clip-path, opacity, stroke and marker
  //     elements sitting off-canvas. Without the expanded-canvas render plan
  //     this aborts the host process; it must render cleanly instead.
  offscreenEffects: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs>
    <filter id="blur"><feGaussianBlur stdDeviation="8"/></filter>
    <mask id="hole"><rect x="-100" y="-100" width="200" height="200" fill="white"/><circle cx="0" cy="0" r="30" fill="black"/></mask>
    <clipPath id="tiny"><rect x="10" y="10" width="40" height="30"/></clipPath>
    <marker id="dot"><circle cx="0" cy="0" r="4" fill="#111"/></marker>
  </defs>
  <rect width="400" height="300" fill="#fef3c7"/>
  <circle cx="200" cy="150" r="60" fill="#dc2626"/>
  <circle cx="900" cy="900" r="80" fill="#22c55e" filter="url(#blur)"/>
  <rect x="-300" y="500" width="120" height="120" fill="#3b82f6" mask="url(#hole)"/>
  <g clip-path="url(#tiny)"><rect x="800" y="-400" width="200" height="200" fill="#8b5cf6"/></g>
  <rect x="700" y="700" width="90" height="90" fill="#f97316" opacity="0.4"/>
  <rect x="-500" y="-300" width="60" height="60" fill="none" stroke="#0ea5e9" stroke-width="30"/>
  <path d="M-100 -100 L-50 -50" stroke="#111" stroke-width="4" marker-end="url(#dot)"/>
</svg>`,

  // 17. Identifiable elements for svg_inspect: ids, nesting, transforms,
  //     a <use>, and an id inside <defs>.
  inspectable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <defs>
    <path id="def-path" d="M0 0 H20 V10 H0 Z"/>
  </defs>
  <rect id="backdrop" width="400" height="200" fill="#fff"/>
  <g id="group-a" transform="translate(100 50)">
    <rect id="inner-rect" x="0" y="0" width="40" height="30" fill="#16a34a"/>
    <g id="nested" transform="scale(2)"><circle id="deep-dot" cx="10" cy="10" r="5" fill="#2563eb"/></g>
  </g>
  <use id="inst" href="#def-path" x="300" y="100"/>
</svg>`,

  // 18. Malformed fixtures for validate/error paths.
  badXml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="50" height="50" fill="red">
  <circle cx="50" cy="50" r="20" fill="blue"/>
</svg>`,
  notSvg: `<html><body>not an svg</body></html>`,

  // 19. Layer-carrying <text> completely outside the viewBox. Same native
  //     panic as offscreenEffects, but text has no measurable extent unless
  //     system fonts are loaded — a fonts-off document bbox misses it, so the
  //     expansion would not cover it and the render would still abort. Guards
  //     the preflight/render font-policy parity.
  offscreenText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs><filter id="tblur"><feGaussianBlur stdDeviation="4"/></filter></defs>
  <rect width="400" height="300" fill="#fef3c7"/>
  <circle cx="200" cy="150" r="60" fill="#dc2626"/>
  <text x="2000" y="2000" font-size="80" opacity="0.5" fill="#111">HELLO</text>
  <text x="-1600" y="2800" font-size="60" filter="url(#tblur)" fill="#111">WORLD</text>
  <g opacity="0.5"><text x="3200" y="-600" font-size="40" fill="#111">!</text></g>
</svg>`,

  // 20. User artwork that already defines the diagnostic checkerboard's
  //     injected id — the tool must pick a non-colliding id, or the user's
  //     url(#__svg_render_bg) references would resolve to the injected
  //     pattern (which is inserted before the source content).
  checkerIdClash: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">
  <defs>
    <pattern id="__svg_render_bg" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#f97316"/>
    </pattern>
    <pattern id="__svg_render_bg_1" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#0ea5e9"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="url(#__svg_render_bg)"/>
  <rect x="100" y="0" width="100" height="100" fill="url(#__svg_render_bg_1)"/>
</svg>`,

  // 21. Path-heavy "sticker" for benchmarks: hundreds of paths.
  heavy: null, // generated below
}

// Generate a path-heavy sticker-like SVG (~150 KB, 400 paths).
{
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">`,
    `<defs><clipPath id="sticker"><circle cx="500" cy="500" r="460"/></clipPath></defs>`,
    `<g clip-path="url(#sticker)"><rect width="1000" height="1000" fill="#fef3c7"/>`,
  ]
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const palette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"]
  for (let i = 0; i < 400; i++) {
    const cx = rand() * 1000, cy = rand() * 1000, r = 5 + rand() * 30
    const c = palette[i % palette.length]
    parts.push(
      `<path d="M${cx.toFixed(1)} ${cy.toFixed(1)} c${(rand() * r).toFixed(1)} ${(-rand() * r).toFixed(1)} ${(rand() * r).toFixed(1)} ${(rand() * r).toFixed(1)} 0 ${r.toFixed(1)} c${(-rand() * r).toFixed(1)} ${(rand() * r).toFixed(1)} ${(-rand() * r).toFixed(1)} ${(-rand() * r).toFixed(1)} 0 ${(-r).toFixed(1)} Z" fill="${c}" fill-opacity="0.8" stroke="#0f172a" stroke-width="${(rand() * 2).toFixed(1)}"/>`,
    )
  }
  parts.push(`</g></svg>`)
  fixtures.heavy = parts.join("\n")
}
