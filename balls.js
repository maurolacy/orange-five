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
    // Salmon four (measured [222,141,128] h≈0.02 s≈0.59 l≈0.69, US Open main
    // camera): the broadcast 4 is a bright CORAL — r ≫ b ≈ g, hue in the rose
    // band — not the magenta rose of the Rust-lab fixture above, which is why
    // it produced zero four-class pixels (its shadow side even read "five").
    // Separators, all measured on the same frame: brown 7 [138,84,49] is dark
    // with b ≪ g (g/b ≈ 1.7); red 3 is dark (l ≤ ~0.5) with a blue lean
    // (b−g ≥ +20); the 5's rose is desaturated (mauve caps s < 0.32).
    if ((h >= 0.97 || h < 0.06) && s >= 0.40 && l >= 0.60 &&
        r > g + 50 && r > b + 50 && Math.abs(b - g) <= 18) return 'four';
    if (h >= 0.45 && h < 0.58 && s >= 0.32) {
      // s ≥ 0.32: the cyan 2 is vivid (s≈0.5+); rail grey-blue [163,180,191]
      // sits at s≈0.2 in the same hue band and must not leak in.
      // b >= g − 12: the green 6 reads [106,204,177] (g−b ≈ 27) under arena
      // light — inside this hue band and previously admitted by a mere
      // b > 0.75·g. The real 2 keeps B ≈ G or above (measured g−b = −9…−2,
      // both shaded and glare-washed), so gate on the ABSOLUTE g−b gap:
      // white glare adds ~equally to G and B, keeping the gap wash-invariant
      // (a ratio drifts toward 1 as the ball washes out).
      if (g > r + 10 && b > r + 10 && b >= g - 12 && g > b * 0.55) return 'two';
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

  // Stage-1 SEED gates (relaxed): the 480-wide pass only PROPOSES candidate
  // locations; the full-res colour scoring (scoreFull) makes the precision
  // decision. Relaxed so the shadowed real 5 (fragmented crescent, r≈4 mask
  // px) still gets a native-resolution chance.
  const SEED = {
    minArea: 6,       // mask px — strict GATES.minArea is 12
    minFill: 0.30,
    maxAspect: 2.6,
    maxPerClass: 4,   // candidates scored at full res, biggest first
    bumpMinPix: 2,    // felt-detector bump disc needs ≥2 classified px
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

  /** Loose per-family ball test for the extent scan only (never used for
   * detection): catches shaded/washed ball tones the strict classifier
   * drops, while never matching blue-grey felt, near-neutrals, glare or
   * near-black, and (for the 2) never the green 6 (G way ahead of B). */
  function looseMatch(cls, R, G, B) {
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    // Very permissive floors: deep ball-shadow tones must still match (the
    // disk should reach the ball's darkest edge). Felt cannot match anyway
    // — it fails the ordering test per family below.
    if (mx - mn < 12 || mx > 250 || mx < 30) return false;
    if (cls === 'five') {
      // Mauve: lit tones have red over green; the darkest bottom shades go
      // blue-dominant with G ≈ R (G−R ≤ 4 — lit felt sits at G−R ≥ 6 even
      // in shadow), so admit those too.
      return R > G || (B >= G && G - R <= 4);
    }
    if (cls === 'four') {
      const felt = G > R + 3 && B > R; // blue-grey felt at any lightness
      return !felt && R > G + 8 && R > B + 8; // salmon/rose
    }
    // two: turquoise; the felt clause's chroma/B−G caps also keep the ball
    // itself (B−G ≈ 15 but chroma ≈ 64) and the green 6 (B far below G)
    // from being treated as felt.
    const felt2 = G > R + 3 && B > R && B - G < 25 && mx - mn < 45;
    return !felt2 && G > R + 20 && B >= G - 12;
  }

  /** Ball extent (native px): per angular octant, the 90th-percentile
   * distance of this class's LOOSE-family pixels from the centre; the disk
   * radius is the max over octants, so the remap disk always covers the
   * whole ball even when the centre is biased toward the lit side or the
   * shadow side is sparsely matched. Scanned in a wider window (1.6× the
   * candidate radius): the mask-res blob — and therefore the candidate
   * disk — undershoots the visible ball. Felt/neutral never match loose,
   * so the extent grows to the true ball edge and no further. */
  function ballExtent(cls, data, region, w, h, cx, cy, fr) {
    // The candidate fr (mask blob) can undershoot the ball by 2× — the
    // window must scale past it: at least 40 px native, up to 2.4×fr, 64 cap.
    const R = Math.min(Math.max(Math.round(fr * 2.4), 40), 64);
    const R2 = R * R;
    const oct = [[], [], [], [], [], [], [], []];
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R2) continue;
        const i = y * w + x;
        if (!region[i]) continue;
        const p = i * 4;
        if (!looseMatch(cls, data[p], data[p + 1], data[p + 2])) continue;
        const k = Math.min(7, Math.max(0, ((Math.atan2(dy, dx) + Math.PI) / (Math.PI / 4)) | 0));
        oct[k].push(Math.sqrt(dx * dx + dy * dy));
      }
    }
    let ext = 0;
    for (const arr of oct) {
      if (!arr.length) continue;
      arr.sort((a, b) => a - b);
      ext = Math.max(ext, arr[Math.min(arr.length - 1, (arr.length * 0.9) | 0)]);
    }
    return ext;
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

  /**
   * Label every component of a binary mask; returns per-component blob stats,
   * biggest area first (stable sort → deterministic). Shared by biggestBlob
   * (strict gates) and candidates() (relaxed SEED gates).
   */
  function components(m, data, w, h) {
    const n = w * h;
    const comp = new Int32Array(n);
    const queue = new Int32Array(n);
    const out = [];
    let nextId = 1;
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
      out.push({
        cx: sx / area, cy: sy / area,
        r: Math.min(GATES.maxR, Math.sqrt(area / Math.PI)),
        area, fill: area / (bw * bh), aspect: hi / lo,
        rgb: [Math.round(sr / area), Math.round(sg / area), Math.round(sb / area)],
      });
      nextId++;
    }
    return out.sort((a, b) => b.area - a.area);
  }

  /** Biggest same-class component of a binary mask, with shape gates. */
  function biggestBlob(m, data, w, h) {
    const n = w * h;
    // components() is sorted by area desc → first gate-passing = biggest
    // passing, exactly the old single-winner semantics.
    for (const c of components(m, data, w, h)) {
      if (c.area >= GATES.minArea &&
          c.area <= GATES.maxAreaFrac * n &&
          c.fill >= GATES.minFill &&
          c.aspect <= GATES.maxAspect) return c;
    }
    return null;
  }

  // --- Two-stage resolution split --------------------------------------------
  // Stage 1 (mask res, candidates()): colour classify → close(r=2) → label,
  // relaxed SEED gates + the felt detector's ball-completion discs — proposes
  // candidate locations. Stage 2 (scoreFull()): COLOUR-ONLY scoring of each
  // candidate's small disk at native resolution (disk mean, purity, hot-pink
  // fraction, classified-pixel count). Morphology and BFS never leave the
  // mask resolution; full-res work is bounded by the candidate disks.

  /** Pool for the native-res region buffer (up to ~8 MB at 1080p — do not
   * allocate fresh every cycle). */
  const pool = new Map();
  function pooled(key, n) {
    let b = pool.get(key);
    if (!b || b.length !== n) { b = new Uint8Array(n); pool.set(key, b); }
    return b;
  }

  /** Bounding box of all set pixels in a mask (mask coords), or null. */
  function regionBBox(region, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (region[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /**
   * Stage 1 (mask space): coarse colour classify → close(r=2) → label.
   * Collects up to SEED.maxPerClass components per class passing the relaxed
   * SEED gates (biggest first), plus the felt detector's ball-completion
   * discs (`bumps`, from table.js analyseData) that contain classified
   * pixels — geometry-based seeds, colour-independent. All coords in MASK
   * space; `src` marks the origin ('blob' | 'bump').
   */
  function candidates(data, w, h, region, bumps) {
    const n = w * h;
    if (!region) return { five: [], four: [], two: [] };
    const masks = { five: new Uint8Array(n), four: new Uint8Array(n), two: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      if (!region[i]) continue;
      const p = i * 4;
      const cls = classify(data[p], data[p + 1], data[p + 2]);
      if (cls) masks[cls][i] = 1;
    }
    const out = { five: [], four: [], two: [] };
    for (const cls of ['five', 'four', 'two']) {
      const m = morphClose(masks[cls], w, h, 2);
      const list = [];
      for (const c of components(m, data, w, h)) {
        if (c.area < SEED.minArea || c.fill < SEED.minFill ||
            c.aspect > SEED.maxAspect || c.area > GATES.maxAreaFrac * n) continue;
        c.src = 'blob';
        list.push(c);
        if (list.length >= SEED.maxPerClass) break;
      }
      out[cls] = list;
    }
    if (bumps) addBumpSeeds(out, masks, bumps, data, w, h);
    return out;
  }

  /** Seed candidates from the felt detector's completed-ball discs: any bump
   * disc holding ≥ SEED.bumpMinPix classified mask pixels of a class joins
   * that class's candidate list (unless a blob candidate already covers it). */
  function addBumpSeeds(out, masks, bumps, data, w, h) {
    for (const b of components(bumps, data, w, h)) {
      if (b.area < 4 || b.r > GATES.maxR) continue;
      for (const cls of ['five', 'four', 'two']) {
        if (out[cls].some((c) => Math.hypot(c.cx - b.cx, c.cy - b.cy) < Math.max(2, c.r))) continue;
        let pix = 0;
        const R2 = b.r * b.r;
        for (let y = Math.max(0, Math.floor(b.cy - b.r)); y <= Math.min(h - 1, Math.ceil(b.cy + b.r)); y++) {
          for (let x = Math.max(0, Math.floor(b.cx - b.r)); x <= Math.min(w - 1, Math.ceil(b.cx + b.r)); x++) {
            const dx = x - b.cx, dy = y - b.cy;
            if (dx * dx + dy * dy <= R2 && masks[cls][y * w + x]) pix++;
          }
          if (pix >= SEED.bumpMinPix) break;
        }
        if (pix >= SEED.bumpMinPix) {
          out[cls].push({ cx: b.cx, cy: b.cy, r: b.r, area: b.area, fill: 0.79, aspect: 1, rgb: b.rgb, src: 'bump' });
        }
      }
    }
  }

  /** Fraction of a disk's pixels that classify as saturated "hot pink" (the
   * 4's lit side) — the phantom-5 discriminator, measured at native res. */
  function hotFrac(data, region, w, h, cx, cy, r) {
    let n = 0, hot = 0;
    const R2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R2) continue;
        const i = y * w + x;
        if (!region[i]) continue;
        n++;
        const p = i * 4;
        const { h: hh, s: ss, l: ll } = rgbToHsl(data[p], data[p + 1], data[p + 2]);
        if (hh >= 0.80 && hh < 0.99 && ss >= 0.40 && ll > 0.15 && ll < 0.85) hot++;
      }
    }
    return n ? hot / n : 0;
  }

  /**
   * The mask region at native resolution. Only the neighborhood of the given
   * mask-space rect is filled (full px (ox+x, oy+y) reads the mask at
   * ((ox+x)/sx, (oy+y)/sy) — nearest-neighbour down-map); the rest stays 0,
   * and diskStats only samples inside candidate disks anyway. POOLED buffer,
   * valid until the next call.
   */
  function upscaleRegion(region, mw, mh, fw, fh, sx, sy, ox, oy, mx0, my0, mx1, my1) {
    const reg = pooled('bReg', fw * fh);
    reg.fill(0);
    const lx0 = Math.max(0, Math.floor(mx0 * sx) - ox);
    const ly0 = Math.max(0, Math.floor(my0 * sy) - oy);
    const lx1 = Math.min(fw, Math.ceil((mx1 + 1) * sx) - ox);
    const ly1 = Math.min(fh, Math.ceil((my1 + 1) * sy) - oy);
    for (let y = ly0; y < ly1; y++) {
      const my = Math.min(mh - 1, ((oy + y) / sy) | 0);
      const mrow = my * mw;
      const orow = y * fw;
      for (let x = lx0; x < lx1; x++) {
        reg[orow + x] = region[mrow + Math.min(mw - 1, ((ox + x) / sx) | 0)];
      }
    }
    return reg;
  }

  /**
   * Stage 2: score stage-1 candidates at NATIVE resolution — colour counting
   * only (no morphology, no labeling). fullData is native-res RGBA; (ox, oy)
   * is the crop origin in native px when the caller cropped around the table
   * bbox; sx/sy the native-per-mask scale. Winners are returned in MASK
   * space — the exact contract detectBalls has always had — so content.js
   * and the shader need no changes. Biggest-area-first candidate that passes
   * all full-res gates wins (same biggest-wins semantics as detectBalls).
   */
  function scoreFull(cands, res, fullData, fw, fh, sx, sy, ox = 0, oy = 0) {
    const mw = res.w, mh = res.h, maskRegion = res.region;
    const winners = { five: null, four: null, two: null };
    if (!maskRegion || fw < 1 || fh < 1 || !(sx > 0) || !(sy > 0)) return winners;
    // Union neighborhood of all candidate disks in mask coords.
    let mx0 = mw, my0 = mh, mx1 = -1, my1 = -1;
    for (const cls of ['five', 'four', 'two']) {
      for (const c of cands[cls]) {
        const pad = c.r + 2;
        mx0 = Math.min(mx0, Math.max(0, Math.floor(c.cx - pad)));
        my0 = Math.min(my0, Math.max(0, Math.floor(c.cy - pad)));
        mx1 = Math.max(mx1, Math.min(mw - 1, Math.ceil(c.cx + pad)));
        my1 = Math.max(my1, Math.min(mh - 1, Math.ceil(c.cy + pad)));
      }
    }
    if (mx1 < 0) return winners;
    const identity = sx === 1 && sy === 1 && ox === 0 && oy === 0 && fw === mw && fh === mh;
    const reg = identity ? maskRegion
      : upscaleRegion(maskRegion, mw, mh, fw, fh, sx, sy, ox, oy, mx0, my0, mx1, my1);
    const minPix = GATES.minArea * sx * sy; // native-res speck guard
    for (const cls of ['five', 'four', 'two']) {
      for (const c of cands[cls]) {   // biggest-area first
        // candidate mask pos → native ABSOLUTE px (mx·sx) → crop-local (− ox)
        const fx = c.cx * sx - ox, fy = c.cy * sy - oy;
        const fr = Math.max(2, c.r * sx);
        const st = diskStats(cls, fullData, reg, fw, fh, fx, fy, fr);
        if (st.mean !== cls || st.purity < GATES.minPurity) continue;
        if (st.purity * st.n < minPix) continue;
        // Green-6 guard: the 6's arena-light green [106,204,177] classifies
        // cyan at mask res (g−b ≈ 27); the real 2 keeps g−b ≤ 0 (shaded or
        // glare-washed). Same absolute-gap gate as classify() — see there
        // for why the gap beats a B/G ratio.
        if (cls === 'two' && st.rgb && st.rgb[2] < st.rgb[1] - 12) continue;
        if (cls === 'five' && st.n &&
            hotFrac(fullData, reg, fw, fh, fx, fy, fr) > GATES.hotPinkFrac) continue;
        // Tight ball radius for the shader's whole-ball remap (native px):
        // 95th-percentile extent of the ball's own classified pixels in a
        // wider scan (see ballExtent), floored at 0.6·fr so a fragmented
        // crescent still covers the ball body.
        const tight = ballExtent(cls, fullData, reg, fw, fh, fx, fy, fr);
        const br = Math.max(tight + 2, fr * 0.6);
        winners[cls] = { ...c, purity: st.purity, rgb: st.rgb, br };
        break;
      }
    }
    // Phantom-5 guard #1 (mask space — same as detectBalls): the four's
    // desaturated shadow side classifies mauve; a five whose centre falls
    // inside the winning four is dropped.
    if (winners.five && winners.four) {
      const d = Math.hypot(winners.five.cx - winners.four.cx, winners.five.cy - winners.four.cy);
      if (d < winners.four.r * GATES.phantomDist) winners.five = null;
    }
    return winners;
  }

  /**
   * Full pipeline: stage-1 candidates on the mask-space frame (`res` from
   * table.analyseData, maskData the 480-wide RGBA), then native-res colour
   * scoring. When the "full" data IS the mask data (small video), everything
   * runs in mask space directly.
   */
  function detectBallsFull(maskData, res, fullData, fw, fh, sx, sy, ox = 0, oy = 0) {
    const cands = candidates(maskData, res.w, res.h, res.region, res.bumps);
    return scoreFull(cands, res, fullData, fw, fh, sx, sy, ox, oy);
  }

  if (typeof window !== 'undefined') {
    window.__orangeFiveBalls = { detectBalls, detectBallsFull, classify, candidates, regionBBox };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      detectBalls, detectBallsFull, classify, candidates, scoreFull, regionBBox,
      // debug/probe access (harness/ballprobe.js) — not for production use
      _internals: { morphClose, biggestBlob, components, diskStats, GATES, SEED, hotFrac, upscaleRegion, looksMauve, rgbToHsl, quickReject },
    };
  }
})();