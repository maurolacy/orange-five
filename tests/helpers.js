/**
 * Shared helpers for the node:test suites.
 * - PNG loading + the same box-filter downscale the extension's canvas path
 *   approximates (average over the source rect each destination pixel covers).
 * - Small color utilities used by assertions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'testdata');

/** The extension's working width for mask analysis (see table.js MASK_MAX_W). */
const MAX_W = 480;

function loadPng(rel) {
  return PNG.sync.read(fs.readFileSync(path.join(DATA, rel)));
}

/** Box-filter downscale of RGBA data to ≤ maxW wide (no-op if smaller). */
function downscaleRgba(data, w, h, maxW) {
  const scale = Math.min(1, maxW / w);
  if (scale >= 1) return { data, w, h };
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y / scale), sy1 = Math.min(h, Math.max(sy0 + 1, Math.ceil((y + 1) / scale)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x / scale), sx1 = Math.min(w, Math.max(sx0 + 1, Math.ceil((x + 1) / scale)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * w + sx) * 4;
          r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Load a PNG from testdata and downscale to the extension's working width. */
function loadWorking(rel, maxW = MAX_W) {
  const png = PNG.sync.read(fs.readFileSync(path.join(DATA, rel)));
  return downscaleRgba(png.data, png.width, png.height, maxW);
}

/** HSL lightness/saturation of an RGB triple (0..1 each). */
function hsl(r, g, b) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const mx = Math.max(rf, gf, bf), mn = Math.min(rf, gf, bf);
  const l = (mx + mn) / 2, d = mx - mn;
  const s = l === 0 ? 0 : (l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn));
  let h = 0;
  if (d > 0) {
    if (mx === rf) h = ((gf - bf) / d + 6) % 6;
    else if (mx === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
  }
  return { h: h / 6, s, l };
}

/** Max-normalised chroma distance (table.js chromaDist). */
function chromaDist(r, g, b, cloth) {
  const rm = (r + cloth[0]) / 2;
  const dr = (r - cloth[0]) * (2 - rm / 255);
  const dg = (g - cloth[1]) * (2 - rm / 255);
  const db = (b - cloth[2]) * (2 - rm / 255);
  return Math.sqrt(dr * dr + dg * dg + db * db) / 255;
}

/** Coarse ASCII of an analyseData result. '#' felt · 'o' hole · '.' outside. */
function asciiMask(res, cols = 60, rows = 24) {
  const lines = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x = Math.floor((rx + 0.5) * res.w / cols);
      const y = Math.floor((ry + 0.5) * res.h / rows);
      const i = y * res.w + x;
      line += res.felt[i] ? '#' : (res.fromBorder[i] ? '.' : 'o');
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { ROOT, DATA, MAX_W, loadPng, downscaleRgba, loadWorking, hsl, chromaDist, asciiMask };