#!/usr/bin/env node
/**
 * Per-candidate probe for one frame: shows EVERY component per colour class
 * (not just the winner) with its blob gates and disk stats, so we can see
 * why the winner won and why real balls were rejected.
 *
 * Usage: node harness/ballprobe.js <frames-dir> <frame-number> [--threshold N]
 * e.g.:  node harness/ballprobe.js /tmp/o5-t5950 135
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const table = require('../table.js');
const balls = require('../balls.js');
const { GATES, morphClose, diskStats } = balls._internals;

const dir = process.argv[2];
const num = Number(process.argv[3]);
const threshArg = process.argv.includes('--threshold')
  ? Number(process.argv[process.argv.indexOf('--threshold') + 1]) : 32;
const thresh = threshArg;

const file = path.join(dir, `f${String(num).padStart(5, '0')}.png`);
const png = PNG.sync.read(fs.readFileSync(file));
let data = png.data, w = png.width, h = png.height;
if (png.width > 480) {
  const d = require('../tests/helpers').downscaleRgba(png.data, png.width, png.height, 480);
  data = d.data; w = d.w; h = d.h;
}
const res = table.analyseData(data, w, h, threshArg);
const official = balls.detectBalls(data, w, h, res.region);

// Build per-class masks (same as detectBalls)
const n = w * h;
const masks = { five: new Uint8Array(n), four: new Uint8Array(n), two: new Uint8Array(n) };
for (let i = 0; i < n; i++) {
  if (!res.region[i]) continue;
  const p = i * 4;
  const cls = balls.classify(data[p], data[p + 1], data[p + 2]);
  if (cls) masks[cls][i] = 1;
}

/** Label ALL components of a mask with the same stats biggestBlob collects. */
function allComponents(m) {
  const comp = new Int32Array(n);
  const queue = new Int32Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (!m[start] || comp[start]) continue;
    let qh = 0, qt = 0;
    comp[start] = 1; queue[qt++] = start;
    let area = 0, sx = 0, sy = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    while (qh < qt) {
      const i = queue[qh++];
      area++;
      const x = i % w, y = (i / w) | 0;
      sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && m[i - 1] && !comp[i - 1]) { comp[i - 1] = 1; queue[qt++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !comp[i + 1]) { comp[i + 1] = 1; queue[qt++] = i + 1; }
      if (y > 0 && m[i - w] && !comp[i - w]) { comp[i - w] = 1; queue[qt++] = i - w; }
      if (y < h - 1 && m[i + w] && !comp[i + w]) { comp[i + w] = 1; queue[qt++] = i + w; }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    out.push({
      cx: +(sx / area).toFixed(1), cy: +(sy / area).toFixed(1), area,
      fill: +(area / (bw * bh)).toFixed(2), aspect: +(Math.max(bw, bh) / Math.min(bw, bh)).toFixed(2),
      r: +Math.sqrt(area / Math.PI).toFixed(1),
    });
  }
  return out.sort((a, b) => b.area - a.area).slice(0, 6);
}

console.log(`frame ${file}  felt=${(res.feltFraction * 100).toFixed(1)}%  ${w}x${h}`);
for (const cls of ['five', 'four', 'two']) {
  const closed = morphClose(masks[cls], w, h, 2);
  const comps = allComponents(closed);
  console.log(`--- ${cls}: ${comps.length} component(s)`);
  for (const c of comps) {
    const st = diskStats(cls, data, res.region, w, h, c.cx, c.cy, c.r);
    const gates = c.area >= GATES.minArea && c.fill >= GATES.minFill && c.area <= GATES.maxAreaFrac * n;
    console.log(`  (${c.cx},${c.cy}) r=${c.r} area=${c.area} fill=${c.fill} aspect=${c.aspect}` +
      ` gates=${gates ? 'ok' : 'NO'} mean=${JSON.stringify(st.rgb)} diskMeanCls=${st.mean}` +
      ` purity=${st.purity.toFixed(2)}${st.purity >= GATES.minPurity ? '' : ' LOW'}`);
  }
  const win = official[cls];
  console.log(`  winner: ${win ? `(${win.cx.toFixed(1)},${win.cy.toFixed(1)}) r=${win.r.toFixed(1)} purity=${win.purity.toFixed(2)}` : 'none'}`);
}
