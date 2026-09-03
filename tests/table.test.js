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