/**
 * Orange Five NG — JS port of the orange-five-detect Rust pipeline.
 *
 * Answers two questions per frame, each allowed to be "nowhere":
 *   1. Where is the table?  (one large grey-blue low-sat felt region)
 *   2. Where is the mauve 5? (at most one disk/arc inside that table)
 *
 * Ported from orange-five-detect/src/{cloth,color,blob,circle,split}.rs.
 * The generic every-ball path (peel, RANSAC racks) is intentionally NOT
 * ported: for the 5 the hue separation makes cluster splitting unnecessary.
 * A cluster hole still yields its mauve blob directly.
 */

'use strict';

// ---------------------------------------------------------------------------
// Colour classification (port of color.rs)
// ---------------------------------------------------------------------------

function rgbToHsl(r, g, b) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) * 0.5;
  if (Math.abs(max - min) < 1e-6) return { h: 0, s: 0, l };
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
  const chroma = max - min;
  return chroma < 20 || max < 40 || min > 230;
}

/**
 * TV 5-ball mauve: DESATURATED rose (#865c65 s≈0.19, #996869 s≈0.26).
 * Saturation is the discriminator: the red 3 (~0.78), maroon 7 (~0.66) and
 * pink 4 share the rose hue band but are far more saturated. Skin tones sit
 * lower but fail the G,B ≥ 0.48·R floor and/or the chroma > 15 rule.
 */
function looksMauve(r, g, b, hsl) {
  if (r < 26) return false;
  const rf = r;
  const gOverR = g / rf;
  const bOverR = b / rf;
  const gbGap = Math.abs(b - g);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const inRose = hsl.h >= 0.90 || hsl.h < 0.12;
  return inRose && gOverR >= 0.48 && bOverR >= 0.48 && gbGap <= 30 &&
    hsl.s >= 0.06 && hsl.s < 0.32 && chroma > 15 &&
    hsl.l > 0.10 && hsl.l < 0.85;
}

/**
 * Classify a pixel. Mauve is checked first: the 5's desaturated rose shares
 * the hue band with the pink 4. Order matters (see color.rs).
 */
function classify(r, g, b) {
  if (quickReject(r, g, b)) return null;
  const hsl = rgbToHsl(r, g, b);
  const { h, s, l } = hsl;
  if (s < 0.08 || l > 0.93 || l < 0.08) return null;
  if (looksMauve(r, g, b, hsl)) return 'purple';
  if (h >= 0.70 && h < 0.83 && s > 0.10 && r > 26 && r > b * 0.22) return 'purple';
  if (h >= 0.83 && h < 0.97 && s >= 0.14) {
    const blueBias = b - g;
    const br = b / Math.max(r, 1);
    if (blueBias >= 5 && br >= 0.55) return 'pink';
  }
  if (h >= 0.45 && h < 0.58 && s >= 0.18) {
    if (g > r + 10 && b > r + 10 && b > g * 0.75 && g > b * 0.55) return 'cyan';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cloth segmentation (port of cloth.rs)
// ---------------------------------------------------------------------------

/** Max per-channel chromaticity difference (both pixels normalised by own sum). */
function chromaDist(p, cloth) {
  const sp = p[0] + p[1] + p[2] + 1;
  const sc = cloth[0] + cloth[1] + cloth[2] + 1;
  return Math.max(
    Math.abs(p[0] / sp - cloth[0] / sc),
    Math.abs(p[1] / sp - cloth[1] / sc),
    Math.abs(p[2] / sp - cloth[2] / sc),
  );
}

/** Felt keeps grey-blue chromaticity; lightness band around the seed. */
function looksLikeCloth(p, cloth, clothHsl, thresh) {
  const hsl = rgbToHsl(p[0], p[1], p[2]);
  const chromaMax = 0.028 + thresh / 900;
  const lDown = 0.12 + thresh / 160;
  const lUp = 0.16;
  return hsl.s <= 0.28 &&
    chromaDist(p, cloth) <= chromaMax &&
    hsl.l >= Math.max(clothHsl.l - lDown, 0.12) &&
    hsl.l <= Math.min(clothHsl.l + lUp, 0.80);
}

/** Mid-grey, slightly blue — Tournament Black TV felt. */
function isFeltSeed(p) {
  const hsl = rgbToHsl(p[0], p[1], p[2]);
  return hsl.s <= 0.22 && hsl.l >= 0.38 && hsl.l <= 0.72 && (p[2] + 8) >= p[0];
}

function classifyCloth(data, w, h, cloth, thresh) {
  const clothHsl = rgbToHsl(cloth[0], cloth[1], cloth[2]);
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = looksLikeCloth([data[p], data[p + 1], data[p + 2]], cloth, clothHsl, thresh) ? 1 : 0;
  }
  return out;
}

function histMedian(hist, mid) {
  let acc = 0;
  for (let v = 0; v < hist.length; v++) {
    acc += hist[v];
    if (acc > mid) return v;
  }
  return 0;
}

/** Median RGB of the pixels where keep[i] is true (or all pixels). */
function medianRgb(data, w, h, keep) {
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  let n = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (keep && !keep[i]) continue;
    hr[data[p]]++; hg[data[p + 1]]++; hb[data[p + 2]]++;
    n++;
  }
  if (n === 0) return [128, 128, 128];
  const mid = Math.floor(n / 2);
  return [histMedian(hr, mid), histMedian(hg, mid), histMedian(hb, mid)];
}

function feltSeedMask(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = isFeltSeed([data[p], data[p + 1], data[p + 2]]) ? 1 : 0;
  }
  return out;
}

/** Square-kernel dilate/erode (naive, mirrors morph_op in cloth.rs). */
function morphOp(src, w, h, radius, dilate) {
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = false, all = true;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          const on = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? false : src[ny * w + nx];
          any = any || on;
          all = all && on;
        }
      }
      dst[y * w + x] = dilate ? (any ? 1 : 0) : (all ? 1 : 0);
    }
  }
  return dst;
}

function morphClose(mask, w, h, radius) {
  return morphOp(morphOp(mask, w, h, radius, true), w, h, radius, false);
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Keep only the largest 4-connected component (in place). */
function keepLargestComponent(fg, w, h) {
  const n = fg.length;
  const orig = fg.slice();
  const visited = new Uint8Array(n);
  let bestStart = -1, bestCount = 0;

  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!orig[start] || visited[start]) continue;
    let count = 0, sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      count++;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (orig[ni] && !visited[ni]) {
          visited[ni] = 1;
          stack[sp++] = ni;
        }
      }
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
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (orig[ni] && !fg[ni]) {
          fg[ni] = 1;
          stack[sp++] = ni;
        }
      }
    }
  }
}

/** Non-cloth reachable from the image border (rails, arms, open pockets). */
function floodFromBorder(isCloth, w, h) {
  const n = isCloth.length;
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;

  const push = (x, y) => {
    const i = y * w + x;
    if (!isCloth[i] && !reached[i]) { reached[i] = 1; queue[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!isCloth[ni] && !reached[ni]) { reached[ni] = 1; queue[qt++] = ni; }
    }
  }
  return reached;
}

/**
 * Hole on the slate (mostly cloth around it) vs a pocket / rail bite.
 * Port of hole_is_interior in cloth.rs.
 */
function holeIsInterior(boundary, isCloth, fromBorder, w, h, aspectRatio) {
  let cloth = 0, rail = 0;
  for (const [x, y] of boundary) {
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) { rail++; continue; }
      const ni = ny * w + nx;
      if (isCloth[ni]) cloth++;
      else if (fromBorder[ni]) rail++;
    }
  }
  const tot = cloth + rail;
  if (tot < 8) return aspectRatio >= 0.55;
  return aspectRatio >= 0.45 && cloth / tot >= 0.58;
}

// ---------------------------------------------------------------------------
// Connected components (port of blob.rs, binary 4-connected, BFS this time)
// ---------------------------------------------------------------------------

/**
 * Find connected components of fg (4-connectivity). Returns blobs with
 * pixel count, bbox, centroid sums and boundary pixel list.
 *
 * `categories` (optional Uint8Array, same length): a per-pixel category
 * id accumulated per blob into blob.catCounts — used to compute colour
 * purity of a blob without keeping pixel lists.
 */
function findBinaryBlobs(fg, w, h, minPixels, categories) {
  const n = fg.length;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const blobs = [];

  for (let start = 0; start < n; start++) {
    if (!fg[start] || visited[start]) continue;
    let qh = 0, qt = 0;
    queue[qt++] = start;
    visited[start] = 1;
    const b = {
      pixelCount: 0, minX: w, maxX: 0, minY: h, maxY: 0,
      sumX: 0, sumY: 0, boundary: [],
      catCounts: categories ? [0] : null,
    };
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w, y = (i / w) | 0;
      b.pixelCount++;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
      b.sumX += x; b.sumY += y;
      if (categories) {
        const cat = categories[i];
        while (b.catCounts.length <= cat) b.catCounts.push(0);
        b.catCounts[cat]++;
      }
      let isBoundary = false;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { isBoundary = true; continue; }
        const ni = ny * w + nx;
        if (!fg[ni]) isBoundary = true;
        else if (!visited[ni]) { visited[ni] = 1; queue[qt++] = ni; }
      }
      if (isBoundary) b.boundary.push([x, y]);
    }
    if (b.pixelCount >= minPixels) blobs.push(b);
  }
  return blobs;
}

// ---------------------------------------------------------------------------
// Circle fitting (port of circle.rs)
// ---------------------------------------------------------------------------

/** Algebraic circle fit (Kåsa): x² + y² = A x + B y + C. */
function fitKasa(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sx2 = 0, sy2 = 0, sxy = 0, sx3 = 0, sy3 = 0, sx2y = 0, sxy2 = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sx2 += x * x; sy2 += y * y; sxy += x * y;
    sx3 += x * x * x; sy3 += y * y * y; sx2y += x * x * y; sxy2 += x * y * y;
  }
  const nf = n;
  const a11 = sx2, a12 = sxy, a13 = sx;
  const a21 = sxy, a22 = sy2, a23 = sy;
  const a31 = sx, a32 = sy, a33 = nf;
  const b1 = sx3 + sxy2, b2 = sx2y + sy3, b3 = sx2 + sy2;
  const det = a11 * (a22 * a33 - a23 * a32) - a12 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * a32 - a22 * a31);
  if (Math.abs(det) < 1e-10) return null;
  const a = (b1 * (a22 * a33 - a23 * a32) - a12 * (b2 * a33 - a23 * b3) +
    a13 * (b2 * a32 - a22 * b3)) / det;
  const b = (a11 * (b2 * a33 - a23 * b3) - b1 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * b3 - b2 * a31)) / det;
  const c = (a11 * (a22 * b3 - b2 * a32) - a12 * (a21 * b3 - b2 * a31) +
    b1 * (a21 * a32 - a22 * a31)) / det;
  const cx = a / 2, cy = b / 2;
  const r2 = c + cx * cx + cy * cy;
  if (r2 <= 0) return null;
  return [cx, cy, Math.sqrt(r2)];
}

function residual(cx, cy, radius, x, y) {
  return Math.hypot(x - cx, y - cy) - radius;
}

/** Fraction of 36 angle bins with inlier support. */
function arcCoverage(cx, cy, radius, points) {
  const numBins = 36;
  const bins = new Uint8Array(numBins);
  const tolerance = radius * 0.25;
  for (const [x, y] of points) {
    if (Math.abs(residual(cx, cy, radius, x, y)) > tolerance) continue;
    const angle = Math.atan2(y - cy, x - cx);
    const norm = (angle + Math.PI) / (2 * Math.PI);
    const bin = Math.min(Math.floor(norm * numBins), numBins - 1);
    bins[bin] = 1;
  }
  let count = 0;
  for (let i = 0; i < bins.length; i++) count += bins[i];
  return count / numBins;
}

/** Kåsa fit, drop the occlusion chord, refit the surviving arc. */
function fitCircle(points) {
  if (points.length < 3) return null;
  const all = points;
  const first = fitKasa(all);
  if (!first) return null;
  const [cx0, cy0, r0] = first;
  const inlierTol = Math.max(r0 * 0.22, 2);
  const inliers = all.filter(([x, y]) => Math.abs(residual(cx0, cy0, r0, x, y)) <= inlierTol);
  let used, cx, cy, radius;
  if (inliers.length >= 3) {
    const refit = fitKasa(inliers);
    if (refit) { [cx, cy, radius] = refit; used = inliers; }
    else { [cx, cy, radius] = first; used = all; }
  } else {
    [cx, cy, radius] = first; used = all;
  }
  let mse = 0;
  for (const [x, y] of used) {
    const e = residual(cx, cy, radius, x, y);
    mse += e * e;
  }
  mse /= used.length;
  return {
    cx, cy, radius, mse,
    arcCoverage: arcCoverage(cx, cy, radius, used),
    diskFill: 0,
  };
}

const DEFAULT_CRITERIA = {
  minRadius: 8, maxRadius: 80,
  maxMseRatio: 0.15, minArcCoverage: 0.22,
  minDiskFill: 0.18, maxDiskFill: 1.35, minAspectRatio: 0.55,
};

/** Gate a blob through the arc-aware circle fit (circle.rs detect_balls). */
function detectBalls(blob, criteria) {
  const bw = blob.maxX - blob.minX + 1, bh = blob.maxY - blob.minY + 1;
  const aspect = Math.min(bw, bh) / Math.max(bw, bh);
  if (aspect < criteria.minAspectRatio) return null;
  const fit = fitCircle(blob.boundary);
  if (!fit) return null;
  if (fit.radius < criteria.minRadius || fit.radius > criteria.maxRadius) return null;
  const mseRatio = fit.mse / (fit.radius * fit.radius);
  if (mseRatio > criteria.maxMseRatio) return null;
  if (fit.arcCoverage < criteria.minArcCoverage) return null;
  const area = Math.PI * fit.radius * fit.radius;
  fit.diskFill = blob.pixelCount / area;
  if (fit.diskFill < criteria.minDiskFill || fit.diskFill > criteria.maxDiskFill) return null;
  return { fit, blobPixels: blob.pixelCount };
}

// ---------------------------------------------------------------------------
// Two-question detector (the product path agreed in docs/orange-five-ng.md)
// ---------------------------------------------------------------------------

/** Largest-enclosed-hole stats for "is this table real?" gates. */
function analyseTable(data, w, h, thresh, closeRadius) {
  // 1. Seed from grey-blue felt-like pixels (screenshots pull medians off).
  const seed = feltSeedMask(data, w, h);
  let seedN = 0;
  for (let i = 0; i < seed.length; i++) seedN += seed[i];
  const need = Math.max((w * h / 50) | 0, 200);
  const rough = seedN > need ? medianRgb(data, w, h, seed) : medianRgb(data, w, h, null);

  // 2. Classify twice, like cloth.rs (rough seed, then refined median).
  let isCloth = classifyCloth(data, w, h, rough, thresh);
  const clothRgb = medianRgb(data, w, h, isCloth);
  isCloth = classifyCloth(data, w, h, clothRgb, thresh);
  isCloth = morphClose(isCloth, w, h, closeRadius);
  keepLargestComponent(isCloth, w, h);

  // 3. Border flood → enclosed holes.
  const fromBorder = floodFromBorder(isCloth, w, h);
  const isHole = new Uint8Array(w * h);
  for (let i = 0; i < isCloth.length; i++) {
    isHole[i] = (!isCloth[i] && !fromBorder[i]) ? 1 : 0;
  }
  return { clothRgb, isCloth, isHole, fromBorder };
}

/** Sample a small pixel neighbourhood inside a fitted disk for a hue label. */
function maybeLabel(data, w, h, cx, cy, radius) {
  const offsets = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]];
  for (const [ox, oy] of offsets) {
    const x = Math.round(cx + ox * radius), y = Math.round(cy + oy * radius);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = (y * w + x) * 4;
    const c = classify(data[p], data[p + 1], data[p + 2]);
    if (c) return c;
  }
  return 'unknown';
}

/**
 * Mauve-pixel blobs inside interior holes. Key difference from the Rust
 * cloth path: we segment the MAUVE pixels (intersected with holes), not the
 * holes themselves. A packed rack is one hole but its 5-ball's mauve is its
 * own connected component — no peeling needed (docs/orange-five-ng.md: the
 * 5 is hue-separated from its neighbours, so clusters "usually do not
 * matter").
 *
 * Categories per pixel: 1 = mauve (rose band), 2 = violet band. Blobs keep
 * per-category counts so we can score purity — the pink 4 leaks pixels into
 * the rose band, but a real 5 is mostly mauve + violet.
 */
const CAT_MAUVE = 1, CAT_VIOLET = 2;

function buildMauveMask(data, w, h, isHole) {
  const mask = new Uint8Array(w * h);
  const cats = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (!isHole[i]) continue;
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const c = classify(r, g, b);
    if (c !== 'purple') continue;
    // Distinguish the two purple gates: rose-band mauve vs violet band.
    const hsl = rgbToHsl(r, g, b);
    cats[i] = (hsl.h >= 0.90 || hsl.h < 0.12) ? CAT_MAUVE : CAT_VIOLET;
    mask[i] = 1;
  }
  return { mask, cats };
}

/** Fraction of blob pixels that passed the strict mauve gates (rose band,
 * the TV 5's actual colour). Violet-band pixels count as neutral support. */
function mauvePurity(blob, cats) {
  if (!blob.catCounts || cats === null) return 1;
  const mauve = blob.catCounts[CAT_MAUVE] || 0;
  const violet = blob.catCounts[CAT_VIOLET] || 0;
  const support = mauve + violet;
  return support > 0 ? mauve / support : 0;
}

/**
 * Cluster heuristic (split.rs looks_like_cluster, light port): a hole that is
 * much larger than one ball, or clearly non-circular. Its circle fit would be
 * the cluster hull, not a ball — reject and let mauve blobs inside propose.
 */
function looksLikeCluster(hole, isHole, w, h, criteria) {
  const bw = hole.maxX - hole.minX + 1, bh = hole.maxY - hole.minY + 1;
  const aspect = Math.min(bw, bh) / Math.max(bw, bh);
  // Bigger than ~2.2 balls' area, or elongated → cluster.
  const ballArea = Math.PI * Math.pow((criteria.maxRadius * 0.45), 2);
  if (hole.pixelCount > ballArea * 2.2) return true;
  return aspect < 0.75;
}

/**
 * Detect the table and, inside it, at most one mauve 5.
 *
 * data: RGBA Uint8ClampedArray (canvas ImageData). Returns a result object:
 *   { table: {cx, cy, w, h, clothRgb, areaFraction, holes} | null,
 *     five: {cx, cy, radius, arcCoverage, diskFill, color} | null,
 *     debug: {isCloth, isHole} }
 * Each of table / five may be null ("nowhere").
 */
function detectFive(data, w, h, opts = {}) {
  const t0 = performance.now();
  const thresh = opts.thresh ?? 32;
  const closeRadius = opts.closeRadius ?? 2;
  const minPixels = Math.max(opts.minPixels ?? 24, 8);
  const criteria = { ...DEFAULT_CRITERIA, ...(opts.criteria || {}) };

  const { clothRgb, isCloth, isHole, fromBorder } =
    analyseTable(data, w, h, thresh, closeRadius);

  // --- Question 1: where is the table? --------------------------------
  const frameArea = w * h;
  let clothCount = 0;
  for (let i = 0; i < isCloth.length; i++) clothCount += isCloth[i];
  const areaFraction = clothCount / frameArea;

  const holes = findBinaryBlobs(isHole, w, h, minPixels);
  const interior = holes.filter((b) => {
    const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    return holeIsInterior(b.boundary, isCloth, fromBorder, w, h, aspect);
  });

  // Table gates: enough felt on screen, at least one interior hole candidate.
  // "Has enclosed holes" is the strongest cheap signal it is a slate, not a
  // grey wall / panel. (A panel with a logo could still pass — tune later.)
  const table = (areaFraction >= 0.04 && interior.length > 0) ? {
    areaFraction, clothRgb,
    minX: interior[0].minX, minY: interior[0].minY,
    maxX: interior[0].maxX, maxY: interior[0].maxY,
    holes: interior.length,
  } : null;
  // Use the union bbox of interior holes as the table's playing region.
  if (table) {
    for (const b of interior) {
      table.minX = Math.min(table.minX, b.minX);
      table.minY = Math.min(table.minY, b.minY);
      table.maxX = Math.max(table.maxX, b.maxX);
      table.maxY = Math.max(table.maxY, b.maxY);
    }
    table.w = table.maxX - table.minX + 1;
    table.h = table.maxY - table.minY + 1;
    table.cx = (table.minX + table.maxX) / 2;
    table.cy = (table.minY + table.maxY) / 2;
  }

  // --- Question 2: where is the mauve 5? ------------------------------
  // Hybrid of the Rust lab path and the product design:
  //   1. Fit each interior hole's boundary (the ball's physical rim — stable
  //      even when the ball's own colour is a ring: highlight, number, stripe).
  //   2. Verify colour INSIDE the fitted disk: a real 5 has ≥ 25% of its disk
  //      pixels in the purple bands. The pink 4 has ~0%.
  // For cluster holes (rack), the hole fit is the cluster hull — reject it and
  // fall back to mauve-blob fits inside the cluster hole instead.
  let five = null;
  const { mask: mauveMask, cats } = buildMauveMask(data, w, h, isHole);
  const mauveBlobs = findBinaryBlobs(mauveMask, w, h, minPixels, cats);

  // Fraction of purple-band pixels inside a fitted disk (colour verify).
  const purpleFraction = (cx, cy, r) => {
    let inDisk = 0, purple = 0;
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
        inDisk++;
        if (mauveMask[y * w + x]) purple++;
      }
    }
    return inDisk > 0 ? purple / inDisk : 0;
  };

  const scoreCandidate = (fit) => {
    const pf = purpleFraction(fit.cx, fit.cy, fit.radius);
    if (pf < 0.25) return null; // not enough mauve in this disk → not a 5
    const mseRatio = fit.mse / (fit.radius * fit.radius);
    return { fit: { ...fit, purpleFraction: pf }, score: pf * 2 + fit.arcCoverage - mseRatio };
  };

  for (const hole of interior) {
    const isCluster = looksLikeCluster(hole, isHole, w, h, criteria);
    if (!isCluster) {
      const holeDet = detectBalls(hole, criteria);
      if (holeDet) {
        const cand = scoreCandidate(holeDet.fit);
        if (cand && (!five || cand.score > five.score)) {
          five = { ...cand.fit, score: cand.score };
        }
      }
    }
    // Mauve blobs strictly inside this hole (cluster fallback + ring case).
    for (const mb of mauveBlobs) {
      if (mb.pixelCount < minPixels) continue;
      const mcx = mb.sumX / mb.pixelCount, mcy = mb.sumY / mb.pixelCount;
      const inHole = mcx >= hole.minX && mcx <= hole.maxX && mcy >= hole.minY && mcy <= hole.maxY;
      if (!inHole) continue;
      const det = detectBalls(mb, criteria);
      if (!det) continue;
      const cand = scoreCandidate(det.fit);
      if (cand && (!five || cand.score > five.score)) {
        five = { ...cand.fit, score: cand.score };
      }
    }
  }
  if (five) delete five.score;

  return {
    table, five,
    debug: {
      isCloth, isHole, clothRgb, allHoles: interior,
      mauveMask, mauveBlobs, timingMs: performance.now() - t0,
    },
  };
}

module.exports = { detectFive, rgbToHsl, classify, fitCircle, arcCoverage };
