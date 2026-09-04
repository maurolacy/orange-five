#!/usr/bin/env node
/**
 * Run the table/cloth detector on an image and write the debug mask as PNG(s)
 * — the same palette the extension's debug view paints:
 *   green = felt · yellow = enclosed hole · orange = filled border hole ·
 *   grey = outside.
 *
 * Usage:
 *   node harness/tableview.js <image.png> [more.png ...] [--thresh 32] [--overlay] [--outdir DIR]
 *
 *   <image>       PNG under testdata/ (bare name ok) or any path
 *   --thresh N    classifier threshold (default 32, same as the extension)
 *   --overlay     additionally write <img>_overlay.png: mask painted 55% over
 *                 the downscaled photo — best for alignment eyeballing
 *   --outdir DIR  where to write (default: next to the input)
 *
 * Prints felt/filled fractions + the cloth anchor. Output files are
 * <basename>_mask.png / <basename>_overlay.png.
 *
 * Requires: npm install (pngjs).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const table = require('../table.js');
const { downscaleRgba, MAX_W } = require('../tests/helpers');

const THRESH = 32; // extension default classifier threshold

/** Load any PNG path + the same box-filter downscale the extension uses. */
function loadImage(file, maxW = MAX_W) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return downscaleRgba(png.data, png.width, png.height, maxW);
}

// Same palette as table.debugImage (which needs a DOM — unavailable here).
const PALETTE = {
  felt: [20, 102, 54],
  enclosed: [255, 212, 0],
  filled: [255, 140, 0],
  outside: [40, 40, 40],
};

function parseArgs(argv) {
  const opts = { thresh: THRESH, overlay: false, outdir: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--thresh') opts.thresh = Number(argv[++i]);
    else if (a === '--overlay') opts.overlay = true;
    else if (a === '--outdir') opts.outdir = argv[++i];
    else opts.files.push(a);
  }
  return opts;
}

/** Resolve "ref3" / "ref3.png" / any path → absolute path (testdata first). */
function resolveInput(name) {
  const candidates = [
    name,
    name.endsWith('.png') ? name : name + '.png',
    path.join(__dirname, '..', 'testdata', name.endsWith('.png') ? name : name + '.png'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  console.error(`input not found: ${name} (looked in . and testdata/)`);
  process.exitCode = 1;
  return null;
}

function run(file, opts) {
  const small = loadImage(file, MAX_W);
  const t0 = Date.now();
  const res = table.analyseData(small.data, small.w, small.h, opts.thresh);
  const ms = Date.now() - t0;
  const n = res.w * res.h;

  // Debug mask PNG (extension palette).
  const mask = new PNG({ width: res.w, height: res.h });
  for (let i = 0; i < n; i++) {
    const col = res.felt[i] ? PALETTE.felt
      : (res.filled[i] ? PALETTE.filled
        : (!res.fromBorder[i] ? PALETTE.enclosed : PALETTE.outside));
    const p = i * 4;
    mask.data[p] = col[0]; mask.data[p + 1] = col[1]; mask.data[p + 2] = col[2];
    mask.data[p + 3] = 255;
  }

  const base = path.basename(file).replace(/\.png$/i, '');
  const outdir = opts.outdir || path.dirname(path.resolve(file));
  fs.mkdirSync(outdir, { recursive: true });
  const maskPath = path.join(outdir, `${base}_mask.png`);
  fs.writeFileSync(maskPath, PNG.sync.write(mask));

  let overlayPath = null;
  if (opts.overlay) {
    const ov = new PNG({ width: res.w, height: res.h });
    const A = 0.55; // mask alpha over the photo
    for (let i = 0; i < n; i++) {
      const col = res.felt[i] ? PALETTE.felt
        : (res.filled[i] ? PALETTE.filled
          : (!res.fromBorder[i] ? PALETTE.enclosed : PALETTE.outside));
      const p = i * 4;
      for (let c = 0; c < 3; c++) {
        ov.data[p + c] = Math.round(col[c] * A + small.data[p + c] * (1 - A));
      }
      ov.data[p + 3] = 255;
    }
    overlayPath = path.join(outdir, `${base}_overlay.png`);
    fs.writeFileSync(overlayPath, PNG.sync.write(ov));
  }

  const pct = (v) => (v * 100).toFixed(1) + '%';
  console.log(`${path.basename(file)}  ${res.w}x${res.h}  ${ms}ms`);
  console.log(`  felt ${pct(res.feltFraction)}  filled ${res.filledCount}px ` +
    `(${pct(res.filledCount / n)})  anchor rgb=[${res.clothRgb.join(',')}]`);
  console.log(`  wrote ${maskPath}${opts.overlay ? ` + ${overlayPath}` : ''}`);
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.files.length) {
  console.log('usage: node harness/tableview.js <image.png> [more...] [--thresh 32] [--overlay] [--outdir DIR]');
  process.exit(1);
}
for (const f of opts.files) {
  const file = resolveInput(f);
  if (file) run(file, opts);
}

