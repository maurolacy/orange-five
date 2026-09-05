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
const { GATES, morphClose, diskStats, hotFrac } = balls._internals;

const dir = process.argv[2];
const num = Number(process.argv[3]);
const threshArg = process.argv.includes('--threshold')
  ? Number(process.argv[process.argv.indexOf('--threshold') + 1]) : 32;
const thresh = threshArg;

const file = path.join(dir, `f${String(num).padStart(5, '0')}.png`);
const png = PNG.sync.read(fs.readFileSync(file));
const d = require('../tests/helpers').downscaleRgba(png.data, png.width, png.height, 480);
const data = d.data, w = d.w, h = d.h;
const sx = png.width / w, sy = png.height / h;
const full = png.width > w;
const res = table.analyseData(data, w, h, threshArg);
// Two-stage detector: stage-1 candidates at mask res, stage-2 colour scoring
// at the frame's own resolution (winners come back in mask space).
const official = balls.detectBallsFull(data, res, png.data, png.width, png.height, sx, sy);
const cands = balls.candidates(data, w, h, res.region, res.bumps);
const regFull = full
  ? balls._internals.upscaleRegion(res.region, w, h, png.width, png.height, sx, sy, 0, 0, 0, 0, w - 1, h - 1)
  : res.region;

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

console.log(`frame ${file}  felt=${(res.feltFraction * 100).toFixed(1)}%  mask ${w}x${h}  native ${png.width}x${png.height}`);
for (const cls of ['five', 'four', 'two']) {
  const closed = morphClose(masks[cls], w, h, 2);
  const comps = allComponents(closed);
  console.log(`--- ${cls}: ${comps.length} component(s) at mask res`);
  for (const c of comps) {
    const st = diskStats(cls, data, res.region, w, h, c.cx, c.cy, c.r);
    const gates = c.area >= GATES.minArea && c.fill >= GATES.minFill && c.area <= GATES.maxAreaFrac * n;
    console.log(`  (${c.cx},${c.cy}) r=${c.r} area=${c.area} fill=${c.fill} aspect=${c.aspect}` +
      ` gates=${gates ? 'ok' : 'NO'} mean=${JSON.stringify(st.rgb)} diskMeanCls=${st.mean}` +
      ` purity=${st.purity.toFixed(2)}${st.purity >= GATES.minPurity ? '' : ' LOW'}`);
  }
  if (full) {
    // Stage-2 view: the same candidates, disk-scored at native resolution.
    const minPix = GATES.minArea * sx * sy;
    console.log(`  stage-2 (native disk scoring, scale ${sx.toFixed(2)}):`);
    for (const c of cands[cls]) {
      const fx = c.cx * sx, fy = c.cy * sy, fr = Math.max(2, c.r * sx);
      const st = diskStats(cls, png.data, regFull, png.width, png.height, fx, fy, fr);
      const hf = cls === 'five'
        ? hotFrac(png.data, regFull, png.width, png.height, fx, fy, fr) : 0;
      const ok = st.mean === cls && st.purity >= GATES.minPurity &&
        st.purity * st.n >= minPix && hf <= GATES.hotPinkFrac;
      console.log(`    ${c.src} (${c.cx.toFixed(1)},${c.cy.toFixed(1)}) r=${c.r.toFixed(1)}` +
        ` → disk r=${fr.toFixed(0)} n=${st.n} mean=${JSON.stringify(st.rgb)} cls=${st.mean}` +
        ` purity=${st.purity.toFixed(2)} hot=${hf.toFixed(2)} ${ok ? 'PASS' : 'FAIL'}`);
    }
  }
  const win = official[cls];
  console.log(`  winner: ${win ? `(${win.cx.toFixed(1)},${win.cy.toFixed(1)}) r=${win.r.toFixed(1)} purity=${win.purity.toFixed(2)}` : 'none'}`);
}
