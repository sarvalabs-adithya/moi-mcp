#!/usr/bin/env node
/**
 * Render assets/moi-logo.svg to the PNG sizes the server hands out as its
 * icon. Run once and commit the output; sharp is a dev dependency only.
 *
 *   node scripts/render-logo.mjs
 *
 * The mark is wider than tall (26x20), so it is centred on a square,
 * transparent canvas rather than stretched.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const svgPath = fileURLToPath(new URL("../assets/moi-logo.svg", import.meta.url));
const svg = await readFile(svgPath);

for (const size of [512, 64]) {
  const png = await sharp(svg, { density: 384 })
    .resize({ width: size, height: size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const out = fileURLToPath(new URL(`../assets/moi-logo-${size}.png`, import.meta.url));
  await writeFile(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
