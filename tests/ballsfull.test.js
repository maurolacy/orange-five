/**
 * Two-stage ball classifier (balls.js detectBallsFull) — suite.
 *
 * Stage 1 runs on the 480-wide mask (classify + close + labeling, relaxed
 * SEED gates) and proposes candidates; stage 2 scores each candidate's small
 * disk with the COLOUR classifier at native resolution and returns winners
 * translated back to mask space (the contract content.js consumes).
 *
 * Synthetic frames: 960×540 felt (scale 2 over the 480-wide mask) with balls
 * at native radius 12 (mask radius ≈ 6).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const table = require('../table.js');
const balls = require('../balls.js');
const { downscaleRgba } = require('./helpers');

const THRESH = 32;
const MAUVE = [134, 92, 101];
const PINK = [214, 96, 142];
const CYAN = [88, 165, 174];
const GREEN6 = [106, 204, 177]; // the 6 under arena light — inside the cyan band
const FELT = [128, 138, 148];

function synthFrame(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = FELT[0]; data[i * 4 + 1] = FELT[1]; data[i * 4 + 2] = FELT[2];
    data[i * 4 + 3] = 255;
  }
  const paint = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
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
  return { data, paint, disc, w, h };
}

/** 960×540 (2× mask scale) with one ball of each class at native r=12. */
function fullFrame() {
  const f = synthFrame(960, 540);
  f.disc(600, 300, 12, MAUVE); // mask (300,150)
  f.disc(300, 200, 12, PINK);  // mask (150,100)
  f.disc(700, 420, 12, CYAN);  // mask (350,210)
  return f;
}

function analyseFull(f) {
  const d = downscaleRgba(f.data, f.w, f.h, 480);
  const res = table.analyseData(d.data, d.w, d.h, THRESH);
  const found = balls.detectBallsFull(d.data, res, f.data, f.w, f.h, f.w / d.w, f.h / d.h);
  return { res, found, d };
}

test('green 6 on the felt is never detected as the two (g−b gap guard)', () => {
  // The 6's arena-light green [106,204,177] used to pass the cyan gates
  // (b > 0.75·g) — the "6 detected as the 2 after the 2 is potted" bug.
  const f = synthFrame(960, 540);
  f.disc(600, 300, 12, GREEN6); // mask (300,150)
  const { found } = analyseFull(f);
  assert.equal(found.two, null, 'the 6 must not win the two class');
  assert.equal(found.five, null, 'and it is not the five either');
  assert.equal(found.four, null, 'nor the four');
});

test('stage 2 finds balls scored at native res, coords back in mask space', () => {
  const f = fullFrame();
  const { found } = analyseFull(f);
  assert.ok(found.five, 'five found');
  assert.ok(found.four, 'four found');
  assert.ok(found.two, 'two found');
  assert.ok(Math.abs(found.five.cx - 300) <= 2 && Math.abs(found.five.cy - 150) <= 2,
    `five at mask (300,150), got (${found.five.cx.toFixed(1)},${found.five.cy.toFixed(1)})`);
  assert.ok(Math.abs(found.four.cx - 150) <= 2 && Math.abs(found.four.cy - 100) <= 2);
  assert.ok(Math.abs(found.two.cx - 350) <= 2 && Math.abs(found.two.cy - 210) <= 2);
  assert.ok(found.five.purity >= 0.5, `purity ${found.five.purity.toFixed(2)}`);
});

test('winners trace back to a stage-1 candidate (no hallucinated disks)', () => {
  const f = fullFrame();
  const d = downscaleRgba(f.data, f.w, f.h, 480);
  const res = table.analyseData(d.data, d.w, d.h, THRESH);
  const found = balls.detectBallsFull(d.data, res, f.data, f.w, f.h, 2, 2);
  const cands = balls.candidates(d.data, d.w, d.h, res.region, res.bumps);
  for (const cls of ['five', 'four', 'two']) {
    if (!found[cls]) continue;
    assert.ok(cands[cls].some((c) =>
      Math.hypot(c.cx - found[cls].cx, c.cy - found[cls].cy) < Math.max(2, c.r)),
      `${cls} winner must be one of the stage-1 candidates`);
  }
});

test('specks below the physical area gate are not detected at full res', () => {
  const f = synthFrame(960, 540);
  f.disc(600, 300, 2, MAUVE); // ~12 native px — far below minArea·s² = 48
  const d = downscaleRgba(f.data, f.w, f.h, 480);
  const res = table.analyseData(d.data, d.w, d.h, THRESH);
  const found = balls.detectBallsFull(d.data, res, f.data, f.w, f.h, 2, 2);
  assert.equal(found.five, null);
});

test('crop + offset scoring (ox/oy) yields identical mask-space winners', () => {
  const f = fullFrame();
  const d = downscaleRgba(f.data, f.w, f.h, 480);
  const res = table.analyseData(d.data, d.w, d.h, THRESH);
  // Crop the native frame to a 160×160 window around the mauve ball.
  const ox = 520, oy = 220, fw = 160, fh = 160;
  const crop = new Uint8ClampedArray(fw * fh * 4);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const s = ((oy + y) * f.w + (ox + x)) * 4, t = (y * fw + x) * 4;
      crop[t] = f.data[s]; crop[t + 1] = f.data[s + 1];
      crop[t + 2] = f.data[s + 2]; crop[t + 3] = 255;
    }
  }
  const full = balls.detectBallsFull(d.data, res, f.data, f.w, f.h, 2, 2);
  const cropped = balls.detectBallsFull(d.data, res, crop, fw, fh, 2, 2, ox, oy);
  assert.ok(cropped.five, 'five found in the cropped data');
  assert.ok(Math.abs(cropped.five.cx - full.five.cx) <= 1 &&
    Math.abs(cropped.five.cy - full.five.cy) <= 1,
    `crop path diverged: (${cropped.five.cx.toFixed(1)},${cropped.five.cy.toFixed(1)})` +
    ` vs (${full.five.cx.toFixed(1)},${full.five.cy.toFixed(1)})`);
});

test('two-stage winners agree with the legacy 480-only detector on easy balls', () => {
  const f = fullFrame();
  const d = downscaleRgba(f.data, f.w, f.h, 480);
  const res = table.analyseData(d.data, d.w, d.h, THRESH);
  const legacy = balls.detectBalls(d.data, d.w, d.h, res.region);
  const twoStage = balls.detectBallsFull(d.data, res, f.data, f.w, f.h, 2, 2);
  for (const cls of ['five', 'four', 'two']) {
    if (!legacy[cls]) continue;
    assert.ok(twoStage[cls], `${cls}: legacy found, two-stage must too`);
    assert.ok(Math.abs(twoStage[cls].cx - legacy[cls].cx) <= 1.5 &&
      Math.abs(twoStage[cls].cy - legacy[cls].cy) <= 1.5,
      `${cls} position drift`);
  }
});

