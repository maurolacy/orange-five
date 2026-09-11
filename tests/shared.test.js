/**
 * Guard the shared.js single-source-of-truth wiring: popup defaults stay a
 * subset of content defaults, TARGETS track DEFAULTS, and content.js no
 * longer embeds its own shader / defaults copy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, POPUP_DEFAULTS, DETECT, VERT, FRAG, TARGETS } =
  require('../shared.js');

test('POPUP_DEFAULTS keys are a known subset of DEFAULTS (plus sat overrides)', () => {
  for (const [k, v] of Object.entries(POPUP_DEFAULTS)) {
    assert.ok(k in DEFAULTS, `popup key ${k} missing from DEFAULTS`);
    // orangeSat / cyanSat are intentionally softer than the shader floors
    // so the slider's max() still has room below the floor.
    if (k === 'orangeSat' || k === 'cyanSat') continue;
    assert.equal(v, DEFAULTS[k], `popup ${k} drifted from DEFAULTS`);
  }
});

test('TARGETS mirror DEFAULTS remap floors / hues / lightness', () => {
  assert.equal(TARGETS.five.hue, DEFAULTS.orangeHue);
  assert.equal(TARGETS.five.satMin, DEFAULTS.orangeSat);
  assert.equal(TARGETS.five.boost, DEFAULTS.orangeSatBoost);
  assert.equal(TARGETS.five.l, DEFAULTS.orangeL);
  assert.equal(TARGETS.four.hue, DEFAULTS.purpleHue);
  assert.equal(TARGETS.four.satMin, DEFAULTS.pinkSat);
  assert.equal(TARGETS.four.l, DEFAULTS.pinkL);
  assert.equal(TARGETS.two.hue, DEFAULTS.blueHue);
  assert.equal(TARGETS.two.satMin, DEFAULTS.cyanSat);
  assert.equal(TARGETS.two.l, DEFAULTS.blueL);
});

test('DETECT / VERT / FRAG are present', () => {
  assert.ok(DETECT.MAUVE_RATIO > 0);
  assert.match(VERT, /a_pos/);
  assert.match(FRAG, /toOrange/);
  assert.match(FRAG, /u_five/);
});

test('content.js consumes shared.js (no inline FRAG / DEFAULTS block)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.match(src, /__orangeFiveShared/);
  assert.doesNotMatch(src, /const FRAG = `/);
  assert.doesNotMatch(src, /const DEFAULTS = \{/);
});

test('manifest loads shared.js before content.js', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('shared.js'));
  assert.ok(js.indexOf('shared.js') < js.indexOf('content.js'));
});
