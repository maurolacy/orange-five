/**
 * Ball detector (harness/detector.js) — suite.
 *
 * Compares against the Rust baseline (testdata/rust-baseline.txt, generated
 * by orange-five-detect with --method cloth defaults). Only the mauve-5
 * labels are asserted: the JS port must find a 5-ball matching at least one
 * of the Rust picks (same ball = center within tolerance). Rust often lists
 * several candidates per frame (shadow/reflection duplicates); the JS scorer
 * may legitimately prefer a different one of the same cluster.
 *
 * All coordinates are in the 2560-max-side working space (baseline was
 * generated at max-side 2560; refs are already ≤2560 wide so scale = 1).
 *
 * NOTE: detector.js is the experimental full detector (cloth holes + mauve
 * blobs + Kåsa fit) used by the browser harness — not shipped in the
 * extension; content.js only consumes table.js. These tests pin its behavior
 * so the compare-vs-Rust effort has a stable floor.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorking } = require('./helpers');
const { detectFive } = require('../harness/detector.js');

// Rust baseline mauve-5 picks (center in 2560-wide coords), from
// testdata/rust-baseline.txt. Keep in sync when regenerating the baseline.
const RUST_FIVE = {
  1: [{ cx: 50.4, cy: 283.1, r: 13.1 }],
  2: [{ cx: 222.9, cy: 492.7, r: 31.4 }, { cx: 225.2, cy: 834.9, r: 21.9 }],
  3: [{ cx: 606.8, cy: 583.6, r: 24.4 }, { cx: 564.5, cy: 602.7, r: 19.8 }],
  4: [{ cx: 550.6, cy: 638.5, r: 31.3 }, { cx: 526.8, cy: 984.4, r: 18.8 }, { cx: 556.1, cy: 984.8, r: 18.4 }],
};

for (const [i, picks] of Object.entries(RUST_FIVE)) {
  test(`ref${i}: mauve 5-ball matches a Rust baseline pick`, { timeout: 60000 }, () => {
    const small = loadWorking(`ref${i}.png`, 2560);
    // detectFive needs full-resolution input: balls are ~25-35 px radius in
    // the 2560-wide working size; at the 480-wide table-mask width the blob
    // gates no longer fire (min-blob sizes are absolute px). Matches the
    // Rust baseline space and harness/run.js defaults.
    const res = detectFive(small.data, small.w, small.h);
    if (!res.five) {
      assert.fail(`ref${i}: JS found no 5-ball (Rust picks: ${JSON.stringify(picks)})`);
    }
    const got = res.five;
    // "Same ball": center within max(30px, 1.5×Rust radius) of any pick.
    const best = Math.min(...picks.map((p) =>
      Math.hypot(got.cx - p.cx, got.cy - p.cy)));
    const tol = Math.max(30, ...picks.map((p) => p.r * 1.5));
    assert.ok(best <= tol,
      `ref${i}: 5-ball center (${got.cx.toFixed(0)},${got.cy.toFixed(1)}) is ${best.toFixed(0)}px from the ` +
      `nearest Rust pick (tol ${tol.toFixed(0)}px); Rust picks: ${JSON.stringify(picks)}`);
  });
}

test('ref8: full detector reports no 5-ball (Rust: NOWHERE)', { timeout: 60000 }, () => {
  const small = loadWorking('ref8.png', 2560);
  const res = detectFive(small.data, small.w, small.h);
  assert.equal(res.five, null, 'ref8 must not produce a 5-ball');
});