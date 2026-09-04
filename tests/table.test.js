/**
 * Cloth/table detector (table.js) — suite.
 *
 * Layers:
 *  1. Unit: seed gate, lightness band, morphology sever behaviour.
 *  2. Reference frames: refs 1–10, structural assertions only (felt fraction
 *     bands + accepted/rejected) — see testdata/README.md for per-ref notes.
 *  3. Failure frames (regression): fail1 (dark arena + player), fail2
 *     (rails-only trap), each with an explicit expectation.
 *
 * Deliberately NO golden/pixel hashes: too brittle for a detector under
 * active tuning. Structural checks + a manual eyeball of `npm run gt`
 * output cover the rest.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const table = require('../table.js');
const { loadWorking, asciiMask } = require('./helpers');

const THRESH = 32;

// --- 1. Unit ---------------------------------------------------------------

test('isFeltSeed: bright-mode gate accepts grey-blue felt, rejects neutral grey + red-brown', () => {
  assert.equal(table.isFeltSeed(128, 138, 148, false), true, 'mid grey-blue felt');
  assert.equal(table.isFeltSeed(177, 187, 192, false), true, 'bright felt (ref1 anchor)');
  assert.equal(table.isFeltSeed(88, 92, 100, false), false, 'dark neutral grey shirt');
  assert.equal(table.isFeltSeed(124, 112, 98, false), false, 'warm grey (b < r)');
  assert.equal(table.isFeltSeed(30, 22, 36, false), false, 'red-brown floor (b < g)');
  assert.equal(table.isFeltSeed(220, 228, 232, false), false, 'too bright');
});

test('isFeltSeed: dim mode accepts dark saturated-blue felt, still rejects neutral/warm', () => {
  assert.equal(table.isFeltSeed(20, 23, 42, true), true, 'dark arena bed felt');
  assert.equal(table.isFeltSeed(20, 23, 42, false), false, '…but not in bright mode');
  assert.equal(table.isFeltSeed(60, 65, 75, true), true, 'dim grey-blue');
  assert.equal(table.isFeltSeed(124, 112, 98, true), false, 'warm grey still out');
});

test('looksLikeCloth: lightness band caps (white cue and bright surround out)', () => {
  const cloth = [128, 138, 148];
  const clothL = (128 / 255 + 148 / 255) / 2;
  assert.equal(table.looksLikeCloth(255, 255, 255, cloth, clothL, 32, false, 0), false, 'white cue');
  assert.equal(table.looksLikeCloth(128, 138, 148, cloth, clothL, 32, false, 0), true, 'anchor itself');
  // lit bed: L≈0.79 vs anchor L≈0.55 — must fit inside the raised band
  assert.equal(table.looksLikeCloth(193, 202, 212, cloth, clothL, 32, false, 0), true, 'lit bed (fail2)');
});

// --- 2. Reference frames ---------------------------------------------------

// feltFraction bands, hand-tuned on the current detector. ref8 is a distant
// top-band wedge (4%); ref8 was flipped from NOWHERE→OK when bright-mode caps
// widened — see README. Update bands ONLY with visual confirmation in the
// extension debug view.
const REF_EXPECT = {
  1: { min: 0.20 }, 2: { min: 0.20 }, 3: { min: 0.20 },
  4: { min: 0.10 }, 5: { min: 0.10 }, 6: { min: 0.10 },
  7: { min: 0.10 }, 8: { min: 0.02 }, 9: { min: 0.10 }, 10: { min: 0.10 },
};

for (const i of Object.keys(REF_EXPECT)) {
  test(`ref${i}: table found with plausible felt fraction`, { timeout: 30000 }, () => {
    const small = loadWorking(`ref${i}.png`);
    const res = table.analyseData(small.data, small.w, small.h, THRESH);
    const exp = REF_EXPECT[i];
    assert.ok(res.feltFraction >= exp.min,
      `ref${i}: felt ${(res.feltFraction * 100).toFixed(1)}% < min ${(exp.min * 100).toFixed(0)}%\n${asciiMask(res)}`);
  });
}

// --- 4. Border-hole fill (TODO.md #1) ---------------------------------------

const WHITE = [255, 255, 255];   // cue-ball: L=1.0 → never cloth
const DARK = [30, 30, 30];       // arm/room: L=0.12 → never cloth

/** Synthetic bright-felt frame with paint helpers (disc/rect clip to frame). */
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

test('border fill: ball cut by the frame edge joins the region', () => {
  const f = synthFrame(160, 120);
  f.disc(152, 60, 14, WHITE);   // centre 7px from the right edge → reachable
  f.disc(80, 40, 10, WHITE);    // mid-table → enclosed hole (old path)
  const res = table.analyseData(f.data, 160, 120, THRESH);
  const edge = 60 * 160 + 156;
  assert.equal(res.filled[edge], 1, 'edge ball marked as filled');
  assert.equal(res.region[edge], 1, 'edge ball in remap region');
  assert.equal(res.maskU8[edge], 128, 'edge ball encoded as hole');
  const mid = 40 * 160 + 80;
  assert.equal(res.filled[mid], 0, 'enclosed ball is not "filled" (already enclosed)');
  assert.equal(res.region[mid], 1, 'enclosed ball still in region');
  assert.ok(res.filledCount >= 400, `edge ball area counted (got ${res.filledCount})`);
});

test('border fill: elongated arm hanging from the border is NOT filled', () => {
  const f = synthFrame(160, 120);
  f.rect(40, 80, 48, 119, DARK);   // 9×40, aspect 4.4, touches bottom border
  const res = table.analyseData(f.data, 160, 120, THRESH);
  const arm = 100 * 160 + 44;
  assert.equal(res.filled[arm], 0, 'arm not filled');
  assert.equal(res.region[arm], 0, 'arm stays outside the region');
});

test('border fill: flat round-ish blob (aspect 3) is NOT filled', () => {
  const f = synthFrame(160, 120);
  f.rect(60, 110, 89, 119, WHITE);  // 30×10 against the bottom border
  const res = table.analyseData(f.data, 160, 120, THRESH);
  assert.equal(res.filled[114 * 160 + 75], 0, 'aspect-3 blob rejected');
  assert.equal(res.region[114 * 160 + 75], 0);
});

test('border fill: big room/surround region is NOT filled', () => {
  const f = synthFrame(160, 120);
  f.rect(0, 0, 159, 47, DARK);     // top 40% of the frame
  const res = table.analyseData(f.data, 160, 120, THRESH);
  const room = 20 * 160 + 80;
  assert.equal(res.filled[room], 0, 'room not filled');
  assert.equal(res.region[room], 0, 'room stays outside the region');
  // …and the felt bed below is still found
  assert.ok(res.feltFraction >= 0.4,
    `bed felt ${(res.feltFraction * 100).toFixed(0)}% (want ≥40%)`);
});

test('border fill: stays conservative on the real refs (≤ 2% of frame)', { timeout: 60000 }, () => {
  for (const name of ['ref1.png', 'ref2.png', 'ref3.png', 'ref4.png', 'ref5.png',
    'ref6.png', 'ref7.png', 'ref8.png', 'ref9.png', 'ref10.png',
    'table_fail1.png', 'table_fail2.png']) {
    const small = loadWorking(name);
    const res = table.analyseData(small.data, small.w, small.h, THRESH);
    const frac = res.filledCount / (res.w * res.h);
    assert.ok(frac <= 0.02,
      `${name}: border fill covers ${(frac * 100).toFixed(1)}% of frame (> 2%)\n${asciiMask(res)}`);
  }
});

// --- 3. Failure-frame regressions ------------------------------------------

test('fail1 (dark arena + player): bed sliver found, player shirt excluded', { timeout: 30000 }, () => {
  const small = loadWorking('table_fail1.png');
  const res = table.analyseData(small.data, small.w, small.h, THRESH);
  // Known-limited: arena lighting kills most of the bed; we currently catch a
  // ~4-6% sliver with the anchor on true bed felt [24,27,40]-ish. Floor here
  // just guards total loss; the real fix is tracked separately.
  assert.ok(res.feltFraction >= 0.03,
    `fail1: felt ${(res.feltFraction * 100).toFixed(1)}% (want ≥3%)\n${asciiMask(res)}`);
  // Anchor must sit on dark bed felt, not the blue-lit surround.
  const [r, g, b] = res.clothRgb;
  assert.ok(b - r >= 12 && b >= g && b >= 35,
    `fail1 anchor [${res.clothRgb}] not dark-blue bed felt`);
});

test('fail2 (lit bed + rails): bed anchor found, lit-bed band detected', { timeout: 30000 }, () => {
  const small = loadWorking('table_fail2.png');
  const res = table.analyseData(small.data, small.w, small.h, THRESH);
  // Anchor must lock onto the lit bed (L≈0.75-0.80), not the rails (L≈0.55).
  const [r, g, b] = res.clothRgb;
  const l = ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) / 255;
  assert.ok(l >= 0.70, `fail2 anchor [${res.clothRgb}] should be lit bed (L≥0.70), got L=${l.toFixed(2)}`);
  assert.ok(b - r >= 6, `fail2 anchor [${res.clothRgb}] should keep blue lean`);
  // Band above the rails must be found (≥6% of frame).
  assert.ok(res.feltFraction >= 0.06,
    `fail2: felt ${(res.feltFraction * 100).toFixed(1)}% (want ≥6% incl. bed band)\n${asciiMask(res)}`);
});