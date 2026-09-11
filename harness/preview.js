// CPU preview of the extension's whole-ball remap — mirrors the fragment
// shader in shared.js 1:1 (verified-ball disks from balls.js, whole-disk
// remap with exact-lightness transforms). Lets us validate the remap look
// on real frames without loading the extension.
//
// Usage: node harness/preview.js <frame.png> <out.png>
const fs = require('fs');
const { PNG } = require('pngjs');
const table = require('../table.js');
const balls = require('../balls.js');
const { TARGETS } = require('../shared.js');
const { downscaleRgba } = require('../tests/helpers');

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('usage: node harness/preview.js <frame.png> <out.png>');
  process.exit(1);
}

const img = PNG.sync.read(fs.readFileSync(inFile));
const NW = img.width, NH = img.height, native = img.data;

// Table stage on the ≤480-wide downscale (same as the extension), stage-2
// disk scoring at native res.
const d = downscaleRgba(native, NW, NH, 480);
const res = table.analyseData(d.data, d.w, d.h, 32);
const found = balls.detectBallsFull(d.data, res, native, NW, NH, NW / d.w, NH / d.h);
const fmt = (b) => b && { cx: +b.cx.toFixed(1), cy: +b.cy.toFixed(1), r: +b.r.toFixed(1), br: b.br && +b.br.toFixed(1), p: +b.purity.toFixed(2) };
console.log('disks:', JSON.stringify({ five: fmt(found.five), four: fmt(found.four), two: fmt(found.two) }));

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const dd = mx - mn, s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / dd + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / dd + 2;
  else h = (r - g) / dd + 4;
  return [h / 6, s, l];
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hsl2rgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}
// toXxx replica for pixels inside a verified ball disk. Returns null where
// the shader passes through: specular glare, white number print /
// near-neutral grey, or blue-grey felt (channel-ordering test — the arena
// felt's chroma matches the ball's, ordering is what separates them).
function remap(cls, r8, g8, b8) {
  const t = TARGETS[cls];
  const [h, s, l] = rgb2hsl(r8, g8, b8);
  const mx = Math.max(r8, g8, b8), mn = Math.min(r8, g8, b8);
  const chroma = (mx - mn) / 255;
  if (l > 0.94 || chroma < 0.06) return null;
  // Brown spare (shader-mirrored): maroon 7 g−b ≈ 35/255 vs the balls'
  // G ≈ B — spare yellow-brown pixels inside the disk (disk overshoot).
  if (g8 > b8 + 20) return null;
  let felt = g8 > r8 + 3 && b8 > r8; // blue-grey felt
  if (cls === 'five') felt = g8 > r8 + 5 && b8 > r8; // mauve's G≈R dark shades
  if (cls === 'two') felt = felt && (b8 - g8) < 25 && chroma < 0.176;
  if (felt) return null;
  const shadow = smoothstep(t.sh[0], t.sh[1], l);
  const sat = Math.min(t.cap, Math.max(s * t.boost, t.satMin)) * (t.sLo + (1 - t.sLo) * shadow);
  return hsl2rgb(t.hue, sat, Math.min(1, l * t.l)); // lightness scaled per target
}

const out = new PNG({ width: NW, height: NH });
out.data.set(native);
const mw = d.w, mh = d.h;
const sx = NW / mw, sy = NH / mh;
const mask = res.maskU8;
// Disks in the same priority order as the shader's if/else-if chain.
const disks = [['five', found.five], ['four', found.four], ['two', found.two]].filter((x) => x[1]);
let remapped = 0;
for (let y = 0; y < NH; y++) {
  const my = Math.min(mh - 1, ((y * mh) / NH) | 0);
  for (let x = 0; x < NW; x++) {
    // Table gate, same as the shader: pixels outside the region (mask 0)
    // pass through untouched. NOTE: felt (255) and interior balls both read
    // 255 in this arena's washed light — the tight stage-2 disk radius
    // (b.br, native px) is what separates ball from felt, not the mask.
    const mx = Math.min(mw - 1, ((x * mw) / NW) | 0);
    if (mask[my * mw + mx] < 128) continue;
    const o = (y * NW + x) * 4;
    for (const [cls, b] of disks) {
      const dx = x - b.cx * sx, dy = y - b.cy * sy;
      if (dx * dx + dy * dy > b.br * b.br) continue;
      const t = remap(cls, native[o], native[o + 1], native[o + 2]);
      if (t) {
        out.data[o] = t[0]; out.data[o + 1] = t[1]; out.data[o + 2] = t[2];
        remapped++;
      }
      break;
    }
  }
}
fs.writeFileSync(outFile, PNG.sync.write(out));
console.log(`remapped ${remapped} px → ${outFile}`);
