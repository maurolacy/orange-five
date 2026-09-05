/**
 * Ball classifier (balls.js) — suite.
 *
 * Synthetic frames (felt bed + painted balls) pin the per-class behaviour:
 * colour classification, biggest-component-wins, size/shape gates, and the
 * phantom-5 guard (the pink 4's desaturated shadow side reads as mauve).
 * A real-frame test pins the 5's position on ref2 (known from the Rust
 * baseline, mapped to the 480-wide mask space).
 *
 * All masks come from table.analyseData, exactly like production.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const table = require('../table.js');
const balls = require('../balls.js');
const { loadWorking } = require('./helpers');

const THRESH = 32;

/** Bright-felt frame with paint helpers (same pattern as table.test.js). */
function synthFrame(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 128; data[i * 4 + 1] = 138; data[i * 4 + 2] = 148;
    data[i * 4 + 3] = 255;
  }
  const paint = (x, y, rgb) => {
    const o = (y * w + x) * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
  };
  const disc = (cx, cy, rad, rgb) => {
    for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
      for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= rad * rad) paint(x, y, rgb);
      }
    }
  };
  const rect = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(x, y, rgb);
  };
  return { data, paint, disc, rect, w, h };
}

// Measured ball colours (Rust lab / broadcast samples).
const MAUVE = [134, 92, 101];   // 5: desaturated rose #865c65
const PINK = [214, 96, 142];    // 4: saturated rose, blue bias (Rust-lab fixture)
const SALMON = [222, 141, 128]; // 4: broadcast salmon/coral (US Open main camera)
const CYAN = [88, 165, 174];    // 2: cyan (measured shaded ball; B ≈ G, both ≫ R)

function run(f) {
  const res = table.analyseData(f.data, f.w, f.h, THRESH);
  return { res, found: balls.detectBalls(f.data, f.w, f.h, res.region) };
}

test('classify: mauve vs pink vs cyan (order + saturation matter)', () => {
  assert.equal(balls.classify(...MAUVE), 'five');
  assert.equal(balls.classify(...PINK), 'four');
  assert.equal(balls.classify(...CYAN), 'two');
  assert.equal(balls.classify(152, 214, 216), 'two', 'glare-washed real 2');
  // The green 6 reads [106,204,177] under arena light — inside the cyan hue
  // band (h≈0.47, s≈0.49) but greener than any real 2 (g−b ≈ 27; the 2 keeps
  // g−b ≤ 0 shaded or washed). Must not classify as the 2.
  assert.equal(balls.classify(106, 204, 177), null, 'green 6 is not the cyan 2');
  assert.equal(balls.classify(128, 138, 148), null, 'felt is not a ball');
  assert.equal(balls.classify(240, 240, 240), null, 'white cue excluded');
  assert.equal(balls.classify(88, 92, 100), null, 'grey shirt excluded');
  // The 4's desaturated shadow side reads mauve (phantom-5 source).
  assert.equal(balls.classify(120, 88, 96), 'five');
  // Broadcast salmon 4: r ≫ b ≈ g, hue in the rose band — the old magenta
  // gate missed it entirely. Brown 7 / lit red 3 must stay excluded.
  assert.equal(balls.classify(...SALMON), 'four', 'salmon 4 detected');
  assert.equal(balls.classify(138, 84, 49), null, 'brown 7 is not the 4');
  assert.equal(balls.classify(200, 55, 75), null, 'lit red 3 is not the 4');
});

test('detects each ball class on the felt, at the right centre', () => {
  const f = synthFrame(480, 320);
  f.disc(120, 80, 8, MAUVE);
  f.disc(300, 160, 10, PINK);
  f.disc(200, 240, 9, CYAN);
  const { found } = run(f);
  assert.ok(found.five, 'five found');
  assert.ok(Math.hypot(found.five.cx - 120, found.five.cy - 80) < 2,
    `five centre (${found.five.cx.toFixed(1)},${found.five.cy.toFixed(1)}) ≈ (120,80)`);
  assert.ok(found.four && Math.hypot(found.four.cx - 300, found.four.cy - 160) < 2, 'four at centre');
  assert.ok(found.two && Math.hypot(found.two.cx - 200, found.two.cy - 240) < 2, 'two at centre');
  assert.ok(found.five.r > 6 && found.five.r < 11, `five r=${found.five.r.toFixed(1)} ≈ 8 (area-derived)`);
});

test('biggest component wins the slot', () => {
  const f = synthFrame(480, 320);
  f.disc(80, 80, 5, MAUVE);     // small mauve blob (area ~78)
  f.disc(300, 200, 10, MAUVE);  // big mauve blob (area ~314)
  const { found } = run(f);
  assert.ok(found.five, 'five found');
  assert.ok(Math.hypot(found.five.cx - 300, found.five.cy - 200) < 3,
    'the bigger blob wins the five slot');
});

test('off-table colours are invisible (region-gated)', () => {
  const f = synthFrame(480, 320);
  f.rect(0, 0, 479, 79, [25, 28, 34]);  // dark room band on top
  f.disc(240, 40, 12, MAUVE);           // mauve blob in the room, off table
  f.disc(240, 240, 8, MAUVE);           // real 5 on the bed
  const { found } = run(f);
  assert.ok(found.five, 'on-table five found');
  assert.ok(Math.hypot(found.five.cx - 240, found.five.cy - 240) < 3,
    'the off-table mauve blob is ignored');
});

test('oversized blob (set dressing / arm) is rejected', () => {
  const f = synthFrame(480, 320);
  f.rect(40, 40, 359, 199, MAUVE);      // huge mauve slab ON the bed
  const { found } = run(f);
  assert.equal(found.five, null, 'slab exceeds max area → no five');
});

test('phantom-5 guard: mauve shadow ON the four is not a five', () => {
  const f = synthFrame(480, 320);
  f.disc(240, 160, 14, PINK);           // the 4
  f.disc(236, 156, 6, [120, 88, 96]);   // desaturated shadow patch on it
  const { found } = run(f);
  assert.ok(found.four, 'four detected');
  assert.equal(found.five, null, 'shadow patch inside the four → phantom five suppressed');
});

test('ref2: the five is found near its known position (Rust baseline)', { timeout: 30000 }, () => {
  // Rust baseline (1200-wide space): five at (222.9, 492.7) r≈31.4.
  // 480-wide mask space: scale 0.4 → (89.2, 197.1).
  const small = loadWorking('ref2.png');
  const res = table.analyseData(small.data, small.w, small.h, THRESH);
  const found = balls.detectBalls(small.data, small.w, small.h, res.region);
  assert.ok(found.five, `no five detected on ref2\n five: ${JSON.stringify(found.five)}\n four: ${JSON.stringify(found.four)}`);
  const tol = Math.max(20, found.five.r * 2);
  assert.ok(Math.hypot(found.five.cx - 89.2, found.five.cy - 197.1) <= tol,
    `five at (${found.five.cx.toFixed(0)},${found.five.cy.toFixed(0)}), expected ≈(89,197) ±${tol.toFixed(0)}`);
});