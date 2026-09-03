/**
 * Player-welded-to-table regression — synthetic (no external data).
 *
 * Scenario (reproduces table_fail1's original failure): a grey-shirted
 * player stands at the table; a thin bridge of grey pixels welds the shirt
 * to the felt bed. Morphological opening + largest-component must sever the
 * neck so the shirt is not classified as cloth.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const table = require('../table.js');

function buildSynthetic() {
  const W = 480, H = 240;
  const data = new Uint8ClampedArray(W * H * 4);
  // Background: dark room.
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    data[p] = 25; data[p + 1] = 28; data[p + 2] = 34; data[p + 3] = 255;
  }
  // Felt bed: grey-blue, x 20..330.
  for (let y = 60; y < 200; y++) {
    for (let x = 20; x < 330; x++) {
      const p = (y * W + x) * 4;
      data[p] = 128; data[p + 1] = 138; data[p + 2] = 148; data[p + 3] = 255;
    }
  }
  // Player: dark grey shirt overlapping felt x 300..400.
  for (let y = 0; y < 150; y++) {
    for (let x = 300; x < 400; x++) {
      const p = (y * W + x) * 4;
      data[p] = 88; data[p + 1] = 92; data[p + 2] = 100; data[p + 3] = 255;
    }
  }
  // Thin mid-grey bridge welding shirt to felt (the neck to sever).
  for (let y = 148; y < 158; y++) {
    for (let x = 295; x < 330; x++) {
      const p = (y * W + x) * 4;
      data[p] = 118; data[p + 1] = 126; data[p + 2] = 134; data[p + 3] = 255;
    }
  }
  return { data, W, H };
}

test('synthetic player weld: shirt excluded, bed intact', () => {
  const { data, W, H } = buildSynthetic();
  const res = table.analyseData(data, W, H, 32);

  // Shirt region must contain (almost) no felt pixels.
  let shirtFelt = 0;
  for (let y = 0; y < 100; y++)
    for (let x = 340; x < 400; x++)
      if (res.felt[y * W + x]) shirtFelt++;

  // Bed must remain almost fully covered.
  let bedFelt = 0, bedTotal = 0;
  for (let y = 100; y < 180; y++)
    for (let x = 50; x < 250; x++) {
      bedTotal++;
      if (res.felt[y * W + x]) bedFelt++;
    }

  assert.ok(shirtFelt < 50, `shirt area has ${shirtFelt} felt px (want < 50)`);
  assert.ok(bedFelt / bedTotal > 0.9,
    `bed coverage ${(100 * bedFelt / bedTotal).toFixed(1)}% (want > 90%)`);
});