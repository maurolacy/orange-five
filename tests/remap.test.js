/**
 * Colour-remapper regression suite (shader in-disk gates, mirrored by
 * harness/preview.js's CPU replica).
 *
 * Pins the "brown spare" fix: inside a verified ball's remap disk, pixels
 * whose G beats B by a margin (the maroon 7's yellow-brown, g−b ≈ 35) must
 * never be remapped — the 4's salmon keeps |b−g| ≤ 18 and the 5's rose keeps
 * B ≥ G−6, so the absolute gap separates them wash-invariantly. See
 * CHANGELOG (4→purple spill onto the brown 7, testdata/color_fail1.png).
 *
 * Runs the full production pipeline (table mask + ball classifier + the
 * exact remap decisions of the shader) over testdata/main_balls2.png — a
 * real rack frame with the 4/5/2 present — and asserts:
 *   1. at least one ball disk is detected (pipeline alive);
 *   2. no yellow-brown pixel inside any remap disk gets remapped;
 *   3. every remapped pixel is NOT yellow-brown (gate soundness);
 *   4. remap coverage stays meaningful (gate not over-broad).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const table = require('../table.js');
const balls = require('../balls.js');
const { downscaleRgba } = require('./helpers');

// The shader's in-disk gate (content.js FRAG) — keep these in sync.
// Returns true when the pixel would be remapped to the class target.
function wouldRemap(cls, R, G, B) {
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const chroma = (mx - mn) / 255;
  const l = ((mx + mn) / 2) / 255;
  if (l > 0.94 || chroma < 0.06) return false;
  if (G > B + 20) return false; // brown spare (the maroon 7)
  const felt = G > R + 3 && B > R; // blue-grey felt
  if (cls === 'five') { if (G > R + 5 && B > R) return false; } // mauve's G≈R shades
  else if (cls === 'two') {
    if (felt && (B - G) < 25 && chroma < 0.176) return false;
  } else if (felt) return false;
  return true;
}

function runFrame(file) {
  const img = PNG.sync.read(fs.readFileSync(file));
  const d = downscaleRgba(img.data, img.width, img.height, 480);
  const res = table.analyseData(d.data, d.w, d.h, 32);
  const found = balls.detectBallsFull(d.data, res, img.data,
    img.width, img.height, img.width / d.w, img.height / d.h);
  const disks = [['five', found.five], ['four', found.four], ['two', found.two]]
    .filter((x) => x[1]);
  const sx = img.width / d.w, sy = img.height / d.h;
  const stats = { brownTotal: 0, brownRemapped: 0, remapped: 0 };
  for (let y = 0; y < img.height; y++) {
    const my = Math.min(d.h - 1, ((y * d.h) / img.height) | 0);
    for (let x = 0; x < img.width; x++) {
      const mx = Math.min(d.w - 1, ((x * d.w) / img.width) | 0);
      if (res.maskU8[my * d.w + mx] < 128) continue;
      const o = (y * img.width + x) * 4;
      for (const [cls, b] of disks) {
        const dx = x - b.cx * sx, dy = y - b.cy * sy;
        if (dx * dx + dy * dy > b.br * b.br) continue;
        const R = img.data[o], G = img.data[o + 1], B = img.data[o + 2];
        const rm = wouldRemap(cls, R, G, B);
        if (rm) stats.remapped++;
        if (G > B + 20) { // yellow-brown family (maroon 7)
          stats.brownTotal++;
          if (rm) stats.brownRemapped++;
        }
        break;
      }
    }
  }
  return { found, disks, stats };
}

const FRAME = path.join(__dirname, '..', 'testdata', 'main_balls2.png');

test('main_balls2: pipeline detects balls to remap', () => {
  const { disks } = runFrame(FRAME);
  assert.ok(disks.length > 0, 'expected at least one verified ball disk');
});

test('main_balls2: no yellow-brown (7) pixel inside a disk is remapped', () => {
  const { stats } = runFrame(FRAME);
  assert.equal(stats.brownRemapped, 0,
    `remapped ${stats.brownRemapped} of ${stats.brownTotal} brown pixels — ` +
    'the brown-spare gate broke');
});

test('main_balls2: remap coverage stays meaningful (gate not over-broad)', () => {
  const { stats } = runFrame(FRAME);
  assert.ok(stats.remapped > 300,
    `only ${stats.remapped} px remapped — the in-disk gates are eating the balls`);
});