/**
 * Orange Five — bulk ball classifier (TODO.md #4, step 1).
 *
 * Colour-based, not shape-based: any connected component of pixels in a
 * ball-colour range is a potential ball; the biggest component wins the slot
 * for its colour. Components are seeded from the table region (balls sit in
 * enclosed pockets of non-felt, which analyseData already includes in the
 * region), so off-table look-alikes are structurally excluded. Size/shape
 * gates reject hands, arms and set dressing.
 *
 * Colour classes are ported from harness/detector.js (validated against the
 * orange-five-detect refs): the 5 is a DESATURATED rose (mauve), the 4 a
 * saturated rose with blue bias — saturation is the discriminator, checked
 * mauve-first. The cyan 2 has its own hue band.
 *
 * Known caveat (guarded): the 4's desaturated shadow side can classify as
 * mauve, creating a phantom 5 ON the 4. After picking winners per class, a
 * five whose centre falls inside the four's disk is discarded.
 *
 * Exposes window.__orangeFiveBalls for content.js; Node tests use
 * module.exports = { detectBalls, classify }.
 */
(function () {
  'use strict';

  // --- Colour classification (port of harness/detector.js) -------------------

  function rgbToHsl(r, g, b) {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    return { h: h / 6, s, l };
  }

  function quickReject(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    // chroma < 23: felt grey-blue sits at ~20 (e.g. [128,138,148]) — this is
    // the hot path, so felt must exit BEFORE any HSL math. Dimmest ball
    // colours measure ~24+.
    return (max - min) < 23 || max < 40 || min > 230;
  }

  /**
   * TV 5-ball mauve: DESATURATED rose (#865c65 s≈0.19, #996869 s≈0.26).
   * Saturation is the discriminator: the red 3 (~0.78), maroon 7 (~0.66) and
   * pink 4 share the rose hue band but are far more saturated. Skin tones sit
   * lower but fail the G,B ≥ 0.48·R floor and/or the chroma > 15 rule.
   */
  function looksMauve(r, g, b, hsl) {
    if (r < 26) return false;
    const inRose = hsl.h >= 0.90 || hsl.h < 0.12;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // b >= g − 6: the 5's rose keeps B ≥ G (G≈B); the maroon 7 [85,61,53]
    // (s=0.23, inside the sat band) leans yellow-brown (b < g) and must not
    // leak in. Small tolerance for shadowed mauve.
    if (b < g - 6) return false;
    return inRose && g / r >= 0.48 && b / r >= 0.48 && Math.abs(b - g) <= 30 &&
      hsl.s >= 0.06 && hsl.s < 0.32 && chroma > 15 &&
      hsl.l > 0.10 && hsl.l < 0.85;
  }

  /**
   * Classify a pixel. Mauve is checked first: the 5's desaturated rose shares
   * the hue band with the pink 4. Order matters (see color.rs).
   */
  function classify(r, g, b) {
    if (quickReject(r, g, b)) return null;
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s < 0.08 || l > 0.93 || l < 0.08) return null;
    if (looksMauve(r, g, b, { h, s, l })) return 'five';
    if (h >= 0.70 && h < 0.83 && s > 0.10 && r > 26 && r > b * 0.22) return 'five';
    if (h >= 0.83 && h < 0.97 && s >= 0.14) {
      if (b - g >= 5 && b / Math.max(r, 1) >= 0.55) return 'four';
    }
    if (h >= 0.45 && h < 0.58 && s >= 0.32) {
      // s ≥ 0.32: the cyan 2 is vivid (s≈0.5+); rail grey-blue [163,180,191]
      // sits at s≈0.2 in the same hue band and must not leak in.
      if (g > r + 10 && b > r + 10 && b > g * 0.75 && g > b * 0.55) return 'two';
    }
    return null;
  }

  // --- Blob detection ---------------------------------------------------------

  // Gates, tuned for the 480-wide mask space (ball radii ~3–13 px there).
  const GATES = {
    minArea: 12,        // below: specks/noise
    maxAreaFrac: 0.012, // a ball is never >1.2% of frame (hands/arms are)
    minFill: 0.35,      // area / bbox — fragmented ball masks are ~0.45 (solid
                        // disk 0.79); arms are elongated, slabs hit maxArea
    maxAspect: 2.0,     // bbox elongation (arms ≥ 3)
    maxR: 40,           // sanity cap on the derived radius
    phantomDist: 1.3,   // five-centre within 1.3×four-r → the four's shadow
    hotPinkFrac: 0.4,   // five blob whose area contains ≥40% saturated-rose
                        // pixels IS the 4 (its shadow side) → reject
    minPurity: 0.35,    // disk-level: ≥35% of the ball's disk must classify
                        // as the class, AND the disk mean must classify too
  };

  /**
   * Biggest-wins per class. Only pixels inside `region` (table felt ∪
   * enclosed/filled/bumped non-felt) participate.
   *
   * Pipeline: build per-class pixel masks → close(r=2) to bridge the
   * highlight/shadow fragments of one ball (a shadowed ball classifies as a
   * crescent: lit side too saturated, shadow side mauve — fragments alone
   * fail the blob gates) → label components → biggest valid wins per class.
   *
   * Returns { five, four, two } — each null or
   * { cx, cy, r, area, fill, aspect, rgb } in mask-space (r from area).
   */
  function detectBalls(data, w, h, region) {
    const n = w * h;
    const masks = { five: new Uint8Array(n), four: new Uint8Array(n), two: new Uint8Array(n), hot: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      if (!region[i]) continue;
      const p = i * 4;
      const R = data[p], G = data[p + 1], B = data[p + 2];
      const cls = classify(R, G, B);
      if (cls) masks[cls][i] = 1;
      // Hot-pink detector (for the phantom-5 guard): saturated rose pixels —
      // the 4's LIT side. The 5 never reaches this saturation. Built
      // un-gated by class because the 4's blob often fails the four gates.
      const { h: hh, s: ss, l: ll } = rgbToHsl(R, G, B);
      if (hh >= 0.80 && hh < 0.99 && ss >= 0.40 && ll > 0.15 && ll < 0.85) {
        masks.hot[i] = 1;
      }
    }

    const winners = { five: null, four: null, two: null };
    for (const cls of ['five', 'four', 'two']) {
      const m = morphClose(masks[cls], w, h, 2);
      const res = biggestBlob(m, data, w, h);
      if (!res) continue;
      // Stage-2 decision at the BALL level: the per-pixel gates are generous
      // (recall), so borderline pixels flip bands frame-to-frame — the
      // per-frame instability you saw. The ball's DISK mean colour (averaged
      // over ~100 px) is stable, and its purity (fraction of disk pixels
      // classifying as this class) separates look-alikes: the red 3's disk
      // is mostly red (purity ~0.1), the 5's disk mostly mauve (purity ~0.6+).
      const st = diskStats(cls, data, region, w, h, res.cx, res.cy, res.r);
      if (st.mean !== cls || st.purity < GATES.minPurity) continue;
      winners[cls] = { ...res, purity: st.purity, rgb: st.rgb };
    }

    // Phantom-5 guard #1: the four's desaturated shadow side classifies
    // mauve — if the five's centre falls inside the winning four, drop it.
    if (winners.five && winners.four) {
      const d = Math.hypot(winners.five.cx - winners.four.cx, winners.five.cy - winners.four.cy);
      if (d < winners.four.r * GATES.phantomDist) winners.five = null;
    }
    // Phantom-5 guard #2 (works even when the four blob isn't detected): if
    // the five's own area is peppered with hot-pink pixels, it's the 4's
    // shadow — a real 5 never reaches that saturation.
    if (winners.five) {
      const f = winners.five;
      let hot = 0, area = 0;
      for (let y = Math.max(0, (f.cy - f.r) | 0); y <= Math.min(h - 1, (f.cy + f.r) | 0); y++) {
        for (let x = Math.max(0, (f.cx - f.r) | 0); x <= Math.min(w - 1, (f.cx + f.r) | 0); x++) {
          const i = y * w + x;
          if (masks.hot[i]) hot++;
          area++;
        }
      }
      if (hot > GATES.hotPinkFrac * area) winners.five = null;
    }
    return winners;
  }

  /** Ball-level stats over the candidate's disk: mean colour + purity
   * (fraction of disk pixels — felt, highlight, shadow included — that
   * classify as `cls`). This is the STABLE signal; per-pixel classification
   * flickers, the disk mean does not. */
  function diskStats(cls, data, region, w, h, cx, cy, r) {
    let n = 0, match = 0, sr = 0, sg = 0, sb = 0;
    const R2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R2) continue;
        const i = y * w + x;
        if (!region[i]) continue;
        const p = i * 4;
        const R = data[p], G = data[p + 1], B = data[p + 2];
        n++;
        sr += R; sg += G; sb += B;
        if (classify(R, G, B) === cls) match++;
      }
    }
    const rgb = n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : [0, 0, 0];
    return { n, purity: n ? match / n : 0, rgb, mean: n ? classify(rgb[0], rgb[1], rgb[2]) : null };
  }

  /** Separable square close (r small — ball fragments, not felt bites):
   * dilate then erode, each as row+column passes. */
  function morphClose(src, w, h, r) {
    const n = w * h;
    const tmp = new Uint8Array(n);
    const out = new Uint8Array(n);
    // dilate: src → tmp (row pass), tmp → out (column pass)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let any = 0;
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          if (src[row + xx]) { any = 1; break; }
        }
        tmp[row + x] = any;
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let any = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          if (tmp[yy * w + x]) { any = 1; break; }
        }
        out[row + x] = any;
      }
    }
    // erode: out → tmp (row pass), tmp → out (column pass)
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let all = 1;
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          if (!out[row + xx]) { all = 0; break; }
        }
        tmp[row + x] = all;
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let all = 1;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          if (!tmp[yy * w + x]) { all = 0; break; }
        }
        out[row + x] = all;
      }
    }
    return out;
  }

  /** Biggest same-class component of a binary mask, with shape gates. */
  function biggestBlob(m, data, w, h) {
    const n = w * h;
    const comp = new Int32Array(n);
    const queue = new Int32Array(n);
    let best = null, nextId = 1;
    for (let start = 0; start < n; start++) {
      if (!m[start] || comp[start]) continue;
      let qh = 0, qt = 0;
      comp[start] = nextId;
      queue[qt++] = start;
      let area = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0;
      let minx = w, maxx = -1, miny = h, maxy = -1;
      while (qh < qt) {
        const i = queue[qh++];
        area++;
        const x = i % w, y = (i / w) | 0;
        sx += x; sy += y;
        const q = i * 4;
        sr += data[q]; sg += data[q + 1]; sb += data[q + 2];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && m[i - 1] && !comp[i - 1]) { comp[i - 1] = nextId; queue[qt++] = i - 1; }
        if (x < w - 1 && m[i + 1] && !comp[i + 1]) { comp[i + 1] = nextId; queue[qt++] = i + 1; }
        if (y > 0 && m[i - w] && !comp[i - w]) { comp[i - w] = nextId; queue[qt++] = i - w; }
        if (y < h - 1 && m[i + w] && !comp[i + w]) { comp[i + w] = nextId; queue[qt++] = i + w; }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      const hi = Math.max(bw, bh), lo = Math.min(bw, bh);
      const fill = area / (bw * bh);
      const ok = area >= GATES.minArea &&
        area <= GATES.maxAreaFrac * n &&
        fill >= GATES.minFill &&
        hi / lo <= GATES.maxAspect;
      if (ok && (!best || area > best.area)) {
        best = {
          cx: sx / area, cy: sy / area,
          r: Math.min(GATES.maxR, Math.sqrt(area / Math.PI)),
          area, fill, aspect: hi / lo,
          rgb: [Math.round(sr / area), Math.round(sg / area), Math.round(sb / area)],
        };
      }
      nextId++;
    }
    return best;
  }

  if (typeof window !== 'undefined') {
    window.__orangeFiveBalls = { detectBalls, classify };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectBalls, classify };
  }
})();