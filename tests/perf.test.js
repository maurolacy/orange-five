/**
 * Performance regression guard for the table detector (table.js).
 *
 * NOT a precision benchmark — machine-dependent by nature. This only trips
 * on CATASTROPHIC regressions (e.g. a morphology rewrite going back to the
 * O(n·r²) naive kernel, or a lost buffer pool causing GC storms). The tuned
 * reference is `npm run bench`; the budget here is ~4× the measured median
 * (~38 ms on an M-series Mac) so ordinary variance and slower CI machines
 * don't flake.
 *
 * Median-of-runs per frame, then median across frames: robust to GC spikes
 * and background load.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const table = require('../table.js');
const { loadWorking } = require('./helpers');

const BUDGET_MS = 150;
const FRAMES = ['table_fail2.png', 'table_fail1.png', 'ref2.png', 'ref7.png'];
const RUNS = 5;

const median = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };

test(`analyse() median runtime stays under ${BUDGET_MS} ms at 480-wide`, { timeout: 60000 }, () => {
  const medians = [];
  for (const name of FRAMES) {
    const s = loadWorking(name);
    table.analyseData(s.data, s.w, s.h, 32);   // warm (JIT + buffer pools)
    const totals = [];
    for (let i = 0; i < 5; i++) {
      medians.push(table.analyseData(s.data, s.w, s.h, 32).timings.total);
    }
    medians.push(median(medians.splice(0, 5)));
  }
  const m = median(medians);
  // Report, always — this is the regression reference.
  console.log(`perf: median analyse() total = ${m.toFixed(1)} ms (budget ${BUDGET_MS})`);
  assert.ok(m < BUDGET_MS,
    `analyse() median ${m.toFixed(1)} ms exceeds ${BUDGET_MS} ms budget — ` +
    `likely a perf regression (compare with \`npm run bench\`)`);
});