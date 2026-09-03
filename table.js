/**
 * Orange Five — table detector (step 1 of Orange Five NG).
 *
 * Detects the playing surface: one large grey-blue, low-saturation felt
 * region, morphologically closed, largest component kept, then a flood from
 * the image border marks everything reachable from outside (rails, arms,
 * room). Felt + enclosed non-felt = "table region" — balls sit inside
 * enclosed pockets of non-felt, so the remap region is felt ∪ enclosed.
 *
 * Port of orange-five-detect/src/cloth.rs (seed, classify, close, largest
 * component, border flood). No circles, no ball logic yet — step 2
 * (docs/orange-five-ng.md).
 *
 * Runs on a downsampled copy (≤ 480 px wide); the mask is upsampled by the
 * GPU sampler in the shader. Cadence: every Nth video frame (~0.5 s), not
 * per vsync.
 *
 * Exposes window.__orangeFiveTable for content.js:
 *   { config, maskUniforms(), analyse(video), setDebug(on) }
 */
(function () {
  'use strict';

  const DEFAULTS = {
    tableEnabled: true,  // gate remaps to the table region
    tableDebug: false,   // visualize mask: felt green, enclosed yellow, outside grey
  };

  const config = { tableEnabled: true, tableDebug: false };

  // Offscreen canvas for downsampling the video frame. Created lazily: this
  // script also runs under Node for tests, where there is no DOM.
  let scratch = null, sctx = null;
  function ensureScratch() {
    if (!scratch) {
      scratch = document.createElement('canvas');
      sctx = scratch.getContext('2d', { willReadFrequently: true, alpha: false });
    }
  }
  const MASK_MAX_W = 480;

  // --- Colour helpers (port of cloth.rs / color.rs) ------------------------
  const HSL = [0, 0, 0];

  function rgbToHsl(r, g, b, out) {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const l = (max + min) * 0.5;
    if (max === min) { out[0] = 0; out[1] = 0; out[2] = l; return out; }
    const d = max - min;
    out[1] = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    out[0] = h / 6;
    out[2] = l;
    return out;
  }

  /** Mid-grey, slightly blue: felt seed (cloth.rs is_felt_seed). */
  function isFeltSeed(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 56) return false;         // s <= 0.22 worst-case bound
    if (b < r - 8) return false;              // blue not below red - 8
    rgbToHsl(r, g, b, HSL);
    return HSL[2] >= 0.38 && HSL[2] <= 0.72 && HSL[1] <= 0.22;
  }

  /** Chromaticity distance, both normalised by own sum (cloth.rs). */
  function chromaDist(r, g, b, cloth) {
    const sp = r + g + b + 1;
    const sc = cloth[0] + cloth[1] + cloth[2] + 1;
    return Math.max(
      Math.abs(r / sp - cloth[0] / sc),
      Math.abs(g / sp - cloth[1] / sc),
      Math.abs(b / sp - cloth[2] / sc),
    );
  }

  /** Felt keeps chromaticity; lightness band around the seed (lighting-tolerant
   * downward, capped upward so the white cue stays non-felt). */
  function looksLikeCloth(r, g, b, cloth, clothL, thresh) {
    rgbToHsl(r, g, b, HSL);
    const chromaMax = 0.028 + thresh / 900;
    const lDown = 0.12 + thresh / 160;
    const lUp = 0.16;
    return HSL[1] <= 0.28 &&
      chromaDist(r, g, b, cloth) <= chromaMax &&
      HSL[2] >= Math.max(clothL - lDown, 0.12) &&
      HSL[2] <= Math.min(clothL + lUp, 0.80);
  }

  // --- Mask pipeline (port of cloth.rs analyse) -----------------------------

  function medianRgb(data, keep, n) {
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    let count = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (keep && !keep[i]) continue;
      hr[data[p]]++; hg[data[p + 1]]++; hb[data[p + 2]]++;
      count++;
    }
    if (count === 0) return [128, 128, 128];
    const mid = count >> 1;
    return [histMed(hr, mid), histMed(hg, mid), histMed(hb, mid)];
  }

  /** Median RGB over pixels matching a predicate (single pass, no mask alloc). */
  function medianRgbMasked(data, w, h, pred) {
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    let count = 0;
    const n = w * h;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (!pred(i, r, g, b)) continue;
      hr[r]++; hg[g]++; hb[b]++;
      count++;
    }
    if (count === 0) return [128, 128, 128];
    const mid = count >> 1;
    return [histMed(hr, mid), histMed(hg, mid), histMed(hb, mid)];
  }

  function histMed(hist, mid) {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc > mid) return v;
    }
    return 0;
  }

  /** Square-kernel dilate/erode, radius 2 (cloth.rs morph_op + close). */
  function morphClose(src, w, h, radius) {
    const tmp = new Uint8Array(src.length);
    // dilate
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        let any = 0;
        for (let yy = y0; yy <= y1 && !any; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (src[row + xx]) { any = 1; break; }
          }
        }
        tmp[y * w + x] = any;
      }
    }
    // erode
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        let all = 1;
        for (let yy = y0; yy <= y1 && all; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (!tmp[row + xx]) { all = 0; break; }
          }
        }
        out[y * w + x] = all;
      }
    }
    return out;
  }

  /** Keep only the largest 4-connected component (in place). */
  function keepLargestComponent(fg, w, h) {
    const n = fg.length;
    const orig = fg.slice();
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    let bestStart = -1, bestCount = 0;

    for (let start = 0; start < n; start++) {
      if (!orig[start] || visited[start]) continue;
      let sp = 0, count = 0;
      stack[sp++] = start;
      visited[start] = 1;
      while (sp > 0) {
        const i = stack[--sp];
        count++;
        const x = i % w, y = (i / w) | 0;
        if (x > 0 && orig[i - 1] && !visited[i - 1]) { visited[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && orig[i + 1] && !visited[i + 1]) { visited[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && orig[i - w] && !visited[i - w]) { visited[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && orig[i + w] && !visited[i + w]) { visited[i + w] = 1; stack[sp++] = i + w; }
      }
      if (count > bestCount) { bestCount = count; bestStart = start; }
    }

    fg.fill(0);
    if (bestStart >= 0) {
      let sp = 0;
      stack[sp++] = bestStart;
      fg[bestStart] = 1;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % w, y = (i / w) | 0;
        if (x > 0 && orig[i - 1] && !fg[i - 1]) { fg[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && orig[i + 1] && !fg[i + 1]) { fg[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && orig[i - w] && !fg[i - w]) { fg[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && orig[i + w] && !fg[i + w]) { fg[i + w] = 1; stack[sp++] = i + w; }
      }
    }
    return bestCount;
  }

  /** Non-felt reachable from the frame border (rails, arms, room). */
  function floodFromBorder(isCloth, w, h) {
    const n = isCloth.length;
    const reached = new Uint8Array(n);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    const push = (i) => {
      if (!isCloth[i] && !reached[i]) { reached[i] = 1; queue[qt++] = i; }
    };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    return reached;
  }

  /**
   * Full cloth analysis on an RGBA buffer.
   * Returns { w, h, clothRgb, felt: Uint8Array, region: Uint8Array, feltFraction }
   * region = felt ∪ enclosed non-felt (the remap gate), 1 byte per pixel.
   */
  function analyseData(data, w, h, thresh) {
    const n = w * h;
    // 1. Seed: median of grey-blue felt-like pixels (falls back to global
    //    median when few — mirrors cloth.rs).
    let seedCount = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (isFeltSeed(data[p], data[p + 1], data[p + 2])) seedCount++;
    }
    const useSeed = seedCount > Math.max((n / 50) | 0, 200);
    const rough = useSeed
      ? medianRgbMasked(data, w, h, (i, r, g, b) => isFeltSeed(r, g, b))
      : medianRgb(data, null, n);

    // 2. Classify twice (rough, then refined median) — cloth.rs.
    let felt = classifyAll(data, w, h, rough, thresh);
    const clothRgb = medianRgb(data, felt, n);
    felt = classifyAll(data, w, h, clothRgb, thresh);

    // 3. Morph close, keep largest component.
    felt = morphClose(felt, w, h, 2);
    keepLargestComponent(felt, w, h);

    // 4. Border flood: reachable-from-outside vs enclosed.
    const fromBorder = floodFromBorder(felt, w, h);

    // 5. Remap region = felt OR enclosed non-felt.
    // maskU8 is the texture encoding: felt=255, enclosed hole=128, outside=0.
    // (LUMINANCE texture normalises byte/255; the shader gates on >=0.5 and
    // the debug view splits at 0.66/0.33 — holes at 0.502 fall in "yellow".)
    const region = new Uint8Array(n);
    const maskU8 = new Uint8Array(n);
    let feltCount = 0;
    for (let i = 0; i < n; i++) {
      if (felt[i]) { region[i] = 1; maskU8[i] = 255; feltCount++; }
      else if (!fromBorder[i]) { region[i] = 1; maskU8[i] = 128; }
    }
    return {
      w, h, clothRgb,
      felt, region, maskU8, fromBorder,
      feltFraction: feltCount / n,
    };
  }

  function classifyAll(data, w, h, cloth, thresh) {
    const out = new Uint8Array(w * h);
    // Felt HSL lightness — the anchor for the lightness band.
    const rf = cloth[0] / 255, gf = cloth[1] / 255, bf = cloth[2] / 255;
    const clothL = (Math.max(rf, gf, bf) + Math.min(rf, gf, bf)) / 2;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = looksLikeCloth(data[p], data[p + 1], data[p + 2], cloth, clothL, thresh) ? 1 : 0;
    }
    return out;
  }

  // --- Video plumbing -------------------------------------------------------

  /** Downsample the video into the scratch canvas, run analyseData.
   * Returns null if the video has no frame yet. */
  function analyse(video, thresh) {
    if (!video.videoWidth || !video.videoHeight) return null;
    ensureScratch();
    const scale = Math.min(1, MASK_MAX_W / video.videoWidth);
    const w = Math.max(16, Math.round(video.videoWidth * scale));
    const h = Math.max(16, Math.round(video.videoHeight * scale));
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    sctx.drawImage(video, 0, 0, w, h);
    const id = sctx.getImageData(0, 0, w, h);
    const res = analyseData(id.data, w, h, thresh ?? 32);
    // Accept/reject: a slate should occupy a plausible chunk of the frame.
    if (res.feltFraction < 0.04) return null;   // "nowhere"
    return res;
  }

  /** Debug paint: felt green, enclosed yellow, outside grey. */
  function debugImage(res) {
    const id = new ImageData(res.w, res.h);
    for (let i = 0; i < res.w * res.h; i++) {
      const p = i * 4;
      if (res.felt[i]) { id.data[p] = 20; id.data[p + 1] = 102; id.data[p + 2] = 54; }
      else if (!res.fromBorder[i]) { id.data[p] = 255; id.data[p + 1] = 212; id.data[p + 2] = 0; }
      else { id.data[p] = 40; id.data[p + 1] = 40; id.data[p + 2] = 40; }
      id.data[p + 3] = 255;
    }
    return id;
  }

  if (typeof window !== 'undefined') {
    window.__orangeFiveTable = { config, DEFAULTS, analyse, debugImage };
  }

  // Node test hook: exposes the pure pipeline for harness/ without a DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyseData, isFeltSeed, looksLikeCloth };
  }
})();
