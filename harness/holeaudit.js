#!/usr/bin/env node
/**
 * Audit the border-hole fill: for a given image + threshold, replay the
 * pipeline and report every felt-adjacent border-reached non-felt component
 * with its shape stats and fill decision — so we can see WHY holes stay
 * unfilled (area cap? aspect? fill ratio? part of the giant room component?).
 *
 * Usage: node harness/holeaudit.js <image> [thresh] [--ascii]
 */
'use strict';

const table = require('../table.js');
const { loadWorking, asciiMask } = require('../tests/helpers');

// Mirror of table.js BORDER_FILL (keep in sync).
const G = { minArea: 48, minAbs: 1500, maxRel: 0.12, minFill: 0.55, maxAspect: 2.0 };

function audit(name, thresh, wantAscii) {
  const small = loadWorking(name);
  const res = table.analyseData(small.data, small.w, small.h, thresh);
  const { w, h, felt, fromBorder, filled } = res;
  const n = w * h;
  let feltCount = 0;
  for (let i = 0; i < n; i++) feltCount += felt[i];
  const maxArea = Math.max(G.minAbs, G.maxRel * feltCount);
  let enclosedCount = 0;
  for (let i = 0; i < n; i++) if (!felt[i] && !fromBorder[i]) enclosedCount++;

  console.log(`\n=== ${name} @ thresh ${thresh}  (${w}x${h}) ===`);
  console.log(`felt ${feltCount}px (${(100 * feltCount / n).toFixed(1)}%)  ` +
    `enclosed holes ${enclosedCount}px  filled ${res.filledCount}px  ` +
    `area cap = max(1500, 20%·felt) = ${Math.round(maxArea)}`);

  // Label felt-adjacent border components (same BFS as fillBorderHoles).
  const comp = new Int32Array(n);
  const queue = new Int32Array(n);
  let nextId = 1;
  const comps = [];
  for (let start = 0; start < n; start++) {
    if (felt[start] || !fromBorder[start] || comp[start]) continue;
    let qh = 0, qt = 0;
    comp[start] = nextId; queue[qt++] = start;
    let area = 0, minx = w, maxx = -1, miny = h, maxy = -1, touchesFelt = false;
    while (qh < qt) {
      const i = queue[qh++]; area++;
      const x = i % w, y = (i / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (felt[j]) touchesFelt = true;
        else if (!comp[j]) { comp[j] = nextId; queue[qt++] = j; }
      }
    }
    comps.push({ id: nextId, area, minx, maxx, miny, maxy, touchesFelt });
    nextId++;
  }

  comps.sort((a, b) => b.area - a.area);
  for (const c of comps) {
    if (!c.touchesFelt) continue; // room-interior blobs: never candidates
    const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
    const hi = Math.max(bw, bh), lo = Math.min(bw, bh);
    const fill = c.area / (bw * bh), aspect = hi / lo;
    const wasFilled = filled[c.miny * w + c.minx] === 1;
    let verdict = 'FILLED';
    if (!wasFilled) {
      if (c.area < G.minArea) verdict = 'reject: tiny';
      else if (c.area > maxArea) verdict = `reject: area>${Math.round(maxArea)}`;
      else if (fill < G.minFill) verdict = `reject: fill ${fill.toFixed(2)}<0.45`;
      else if (aspect > G.maxAspect) verdict = `reject: aspect ${aspect.toFixed(1)}>2.5`;
      else verdict = 'reject: ???';
    }
    console.log(`  comp#${c.id}  area ${String(c.area).padStart(6)}  bbox ${bw}x${bh}  ` +
      `fill ${fill.toFixed(2)}  aspect ${aspect.toFixed(1)}  at (${c.minx},${c.miny})..(${c.maxx},${c.maxy})  → ${verdict}`);
  }

  if (wantAscii) console.log(asciiMask(res));
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: node harness/holeaudit.js <image> [thresh] [--ascii]');
  process.exit(1);
}
const name = args[0];
const thresh = Number(args[1]) || 32;
const wantAscii = args.includes('--ascii');
audit(name, thresh, wantAscii);
