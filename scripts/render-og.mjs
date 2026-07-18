#!/usr/bin/env node
/**
 * Regenerate the Open Graph preview PNG from its SVG source.
 *
 * `og:image` must be a RASTER format — X / Slack / Discord / LinkedIn / Facebook
 * unfurlers do NOT render SVG, so the link preview shows no image if `og:image`
 * points at an `.svg`. `docs/assets/og-image.svg` is the editable source;
 * `docs/assets/og-image.png` is the rendered asset that `og:image` references
 * (`docs/_config.yml` defaults + `docs/index.md` front matter). Edit the SVG,
 * then run this to regenerate the PNG.
 *
 * `sharp` is an OPTIONAL dev tool (not a CI gate, not a runtime dep). If it is
 * not installed:  pnpm add -Dw sharp   # then re-run
 *
 * Usage: node scripts/render-og.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('render-og: `sharp` is not available — install it (pnpm add -Dw sharp) and re-run.');
  process.exit(1);
}

const SRC = 'docs/assets/og-image.svg';
const OUT = 'docs/assets/og-image.png';

const svg = readFileSync(SRC);
// Render the SVG at 2x density for crisp text, then fit the canonical 1280x640
// Open Graph size. The SVG uses system fonts with generic fallbacks
// (sans-serif / monospace), so text renders in whatever face the rasterizer has.
const png = await sharp(svg, { density: 144 })
  .resize(1280, 640, { fit: 'fill' })
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, png);
console.log(`render-og: wrote ${OUT} (${png.length} bytes, 1280x640)`);
