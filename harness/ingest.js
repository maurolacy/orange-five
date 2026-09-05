#!/usr/bin/env node
/**
 * Video ingest for detector debugging (TODO #4 support tool).
 *
 * Samples frames from a video file or HLS stream URL through the FULL
 * production pipeline (table mask + ball classifier), and emits:
 *   - frames.jsonl      one record per frame (t, felt%, balls w/ purity)
 *   - overlay_*.png     mask debug colours + classifier rings (480-wide)
 *   - sheet_*.png       contact sheets (3x4 overlays each) — viewable grids
 *   - timeline summary  per-class found/missing runs
 *
 * Usage:
 *   node harness/ingest.js <url-or-file> [--start S] [--dur S] [--fps N]
 *                          [--outdir DIR] [--threshold 32]
 *
 * Requires ffmpeg/ffprobe on PATH. For WNT: use a rendition m3u8 URL from
 * DevTools (Network → m3u8). Signed URLs expire — re-grab when needed.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const table = require('../table.js');
const balls = require('../balls.js');

function parseArgs(argv) {
  const o = { start: 0, dur: 20, fps: 5, outdir: null, thresh: 32, blend: false, reuse: false, src: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--start') o.start = Number(argv[++i]);
    else if (argv[i] === '--dur') o.dur = Number(argv[++i]);
    else if (argv[i] === '--fps') o.fps = Number(argv[++i]);
    else if (argv[i] === '--outdir') o.outdir = argv[++i];
    else if (argv[i] === '--threshold') o.thresh = Number(argv[++i]);
    else if (argv[i] === '--blend') o.blend = true;
    else if (argv[i] === '--reuse') o.reuse = true;
    else o.src = argv[i];
  }

  return o;
}

const UA = 'Mozilla/5.0';

function extractFrames(src, o, dir) {
  execFileSync('ffmpeg', ['-v', 'error', '-user_agent', UA,
    '-ss', String(o.start), '-i', src, '-t', String(o.dur),
    '-vf', `fps=${o.fps},scale=480:-2`, '-q:v', 2,
    path.join(dir, 'f%05d.png')], { timeout: 300000, maxBuffer: 1e7 });
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
}

// Debug palette + rings, mirroring the shader's debug view.
// With --blend the mask is mixed over the photo so the scene stays visible.
function overlay(res, found, base, blend) {
  const { w, h } = res;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    let r, g, b;
    if (res.felt[i]) { r = 20; g = 102; b = 54; }
    else if (res.filled[i]) { r = 255; g = 140; b = 0; }
    else if (!res.fromBorder[i]) { r = 255; g = 212; b = 0; }
    else { r = 40; g = 40; b = 40; }
    if (blend && base) {
      const s = i * 4;
      r = Math.round(r * 0.55 + base[s] * 0.45);
      g = Math.round(g * 0.55 + base[s + 1] * 0.45);
      b = Math.round(b * 0.55 + base[s + 2] * 0.45);
    }
    png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b;
    png.data[p + 3] = 255;
  }
  const ring = (b, rgb) => {
    if (!b) return;
    const R = Math.round(b.r), R2 = (R + 1) * (R + 1);
    for (let y = Math.max(0, (b.cy - R - 1) | 0); y <= Math.min(h - 1, (b.cy + R + 1) | 0); y++) {
      for (let x = Math.max(0, (b.cx - R - 1) | 0); x <= Math.min(w - 1, (b.cx + R + 1) | 0); x++) {
        const dx = x - b.cx, dy = y - b.cy, d2 = dx * dx + dy * dy;
        if (d2 <= R2 && d2 >= (R - 1) * (R - 1)) {
          const p = (y * w + x) * 4;
          png.data[p] = rgb[0]; png.data[p + 1] = rgb[1]; png.data[p + 2] = rgb[2];
        }
      }
    }
  };
  ring(found.five, [255, 120, 0]);
  ring(found.four, [190, 0, 230]);
  ring(found.two, [0, 110, 255]);
  return png;
}

function contactSheets(overlays, dir) {
  const COLS = 3, ROWS = 4, PER = COLS * ROWS;
  const paths = Object.keys(overlays).sort();
  const sheets = [];
  for (let s = 0; s * PER < paths.length; s++) {
    const batch = paths.slice(s * PER, (s + 1) * PER);
    if (!batch.length) break;
    const w = overlays[batch[0]].width, h = overlays[batch[0]].height;
    const sheet = new PNG({ width: w * COLS, height: h * ROWS });
    sheet.data.fill(0);
    batch.forEach((name, k) => {
      const ox = (k % COLS) * w, oy = Math.floor(k / COLS) * h;
      const img = overlays[name];
      for (let y = 0; y < h; y++) {
        const src = y * w * 4, dst = ((oy + y) * w * COLS + ox) * 4;
        sheet.data.set(img.data.subarray(src, src + w * 4), dst);
      }
    });
    const file = path.join(dir, `sheet_${String(s + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(file, PNG.sync.write(sheet));
    sheets.push(file);
  }
  return sheets;
}

function runs(flags) {
  const out = [];
  let cur = null;
  for (const { t, ok } of flags) {
    if (cur && cur.ok === ok) cur.end = t;
    else {
      if (cur) out.push(cur);
      cur = { ok, start: t, end: t };
    }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.ok).map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.src) { console.log('usage: node harness/ingest.js <url-or-file|@N> [--start S] [--dur S] [--fps N] [--outdir DIR] [--threshold 32] [--blend] [--reuse]'); process.exit(1); }
  if (o.src.startsWith('@')) {
    const urls = fs.readFileSync(path.join(__dirname, 'urls.txt'), 'utf8')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    o.src = urls[Number(o.src.slice(1)) - 1];
    if (!o.src) { console.error('no such URL index in harness/urls.txt'); process.exit(1); }
  }
  const dir = o.outdir || path.join('/tmp', 'o5-ingest-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  console.log(`ingest: start=${o.start}s dur=${o.dur}s fps=${o.fps}`);
  const existing = fs.readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f));
  let frames;
  if (o.reuse && existing.length) {
    frames = existing.sort();
    console.log(`reusing ${frames.length} existing frames in ${dir}`);
  } else {
    frames = extractFrames(o.src, o, dir);
    console.log(`extracted ${frames.length} frames → ${dir}`);
  }

  const jsonl = [];
  const overlays = {};
  frames.forEach((f, idx) => {
    const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    const scale = Math.min(1, 480 / png.width);
    let data = png.data, w = png.width, h = png.height;
    if (scale < 1) {
      const d = require('../tests/helpers').downscaleRgba(png.data, png.width, png.height, 480);
      data = d.data; w = d.w; h = d.h;
    }
    const res = table.analyseData(data, w, h, o.thresh);
    const found = balls.detectBalls(data, w, h, res.region);
    const t = +(o.start + idx / o.fps).toFixed(2);
    const rec = {
      t, felt: +(res.feltFraction * 100).toFixed(1),
      five: found.five && { cx: +found.five.cx.toFixed(1), cy: +found.five.cy.toFixed(1), r: +found.five.r.toFixed(1), purity: +found.five.purity.toFixed(2), rgb: found.five.rgb },
      four: found.four && { cx: +found.four.cx.toFixed(1), cy: +found.four.cy.toFixed(1), r: +found.four.r.toFixed(1), purity: +found.four.purity.toFixed(2), rgb: found.four.rgb },
      two: found.two && { cx: +found.two.cx.toFixed(1), cy: +found.two.cy.toFixed(1), r: +found.two.r.toFixed(1), purity: +found.two.purity.toFixed(2), rgb: found.two.rgb },
    };
    jsonl.push(JSON.stringify(rec));
    if (idx % Math.max(1, Math.ceil(frames.length / 60)) === 0) {
      const ov = overlay(res, found, data, o.blend);
      overlays[`overlay_${String(idx).padStart(4, '0')}_t${t.toFixed(1)}`] = ov;
      fs.writeFileSync(path.join(dir, `overlay_${String(idx).padStart(4, '0')}_t${t.toFixed(1)}.png`), PNG.sync.write(ov));
    }
  });
  fs.writeFileSync(path.join(dir, 'frames.jsonl'), jsonl.join('\n') + '\n');

  const sheets = contactSheets(overlays, dir);

  const lines = ['--- timeline (raw, no hold) ---'];
  for (const cls of ['five', 'four', 'two']) {
    const flags = jsonl.map((j) => { const rec = JSON.parse(j); return { t: rec.t, ok: !!rec[cls] }; });
    const rs = runs(flags);
    const cov = flags.filter((f) => f.ok).length / Math.max(1, flags.length);
    lines.push(`${cls.padEnd(5)} coverage ${(cov * 100).toFixed(0)}%  present runs: ${rs.length ? rs.join(', ') : '—'}`);
  }
  lines.push(`overlays: ${Object.keys(overlays).length}  sheets: ${sheets.length}`);
  lines.push('sheets:\n  ' + sheets.join('\n  '));
  console.log(lines.join('\n'));
}

main();
