#!/usr/bin/env node
/**
 * Table-detector benchmark — per-step timings over the testdata frames.
 *
 * Usage: npm run bench  (or: node harness/bench-table.js [runs=5] [frames...])
 *
 * Reference numbers (2026-09-04, M-series Mac, 480-wide, thresh 32):
 *   avg total ≈ 38 ms — ballclose ~12 + morph ~8 + classify ~5 + seed ~4
 *   + shadow ~4 + flood/fill/bumps/mask ~6.
 *   content.js self-throttles (≥100 ms + 3× cost backoff), so speed gains buy
 *   mask freshness, not less CPU. GC churn is pooled away (see table.js
 *   POOL); allocation regressions show up as irregular spikes, so the bench
 *   reports the median of several runs, not the min.
 */
'use strict';

const path = require('path');
const table = require('../table.js');
const { loadWorking } = require('../tests/helpers');

const FRAMES = [
  'table_fail1.png', 'table_fail2.png', 'table_fail3.png', 'table_fail4.png',
  'ref1.png', 'ref2.png', 'ref3.png', 'ref4.png', 'ref6.png', 'ref7.png', 'ref9.png',
];
const STEPS = ['seed', 'classify', 'morph', 'shadow', 'ballclose', 'flood', 'fill', 'bumps', 'mask'];
const RUNS = Number(process.argv[2]) || 5;

const median = (a) => {
  const v = [...a].sort((x, y) => x - y);
  return v[v.length >> 1];
};

const out = [];
const acc = {};
let totMed = [];
for (const name of FRAMES) {
  const s = loadWorking(name);
  table.analyseData(s.data, s.w, s.h, 32);            // warm (JIT + pools)
  const totals = [], stepMed = {};
  for (let i = 0; i < RUNS; i++) {
    const r = table.analyseData(s.data, s.w, s.h, 32);
    totals.push(r.timings.total);
    for (const k of STEPS) {
      (stepMed[k] = stepMed[k] || []).push(r.timings[k] || 0);
    }
  }
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
  const t = med(totals);
  totMed.push(t);
  const row = [name.replace('.png', '').padEnd(14), String(t).padStart(5) + 'ms'];
  for (const k of STEPS) {
    const m = med(stepMed[k]);
    (acc[k] = acc[k] || []).push(m);
    row.push(`${k} ${m.toFixed(1)}`);
  }
  out.push(row.join('  '));
}
const sum = ['MEDIAN-OF-MEDIANS'.padEnd(14), String(median(totMed)).padStart(5) + 'ms'];
for (const k of STEPS) {
  const a = acc[k].reduce((x, v) => x + v, 0) / acc[k].length;
  sum.push(`${k} ${a.toFixed(1)}`);
}
out.unshift(sum.join('  '));
console.log(out.join('\n'));