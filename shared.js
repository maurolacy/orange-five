/**
 * Orange Five — shared single source of truth.
 *
 * Everything that was previously duplicated between content.js, popup.js,
 * harness/preview.js and harness/ext-test.html lives here ONCE:
 *   - DEFAULTS: full content-script config (remap targets + toggles)
 *   - POPUP_DEFAULTS: the popup's user-facing subset (toggles + sat sliders)
 *   - DETECT: baked-in detection thresholds (former "Selectivity" slider
 *     defaults — the sliders were removed in 2.5.0)
 *   - VERT / FRAG: the WebGL shader source
 *   - TARGETS: per-class Arcos II remap targets (hue/sat floors/lightness
 *     scales), mirroring DEFAULTS + toXxx in the shader — used by the
 *     harness CPU replica and documentation
 *
 * Loaded as a plain UMD module (same pattern as balls.js / table.js):
 *   - content script: window.__orangeFiveShared
 *   - popup: window.__orangeFiveShared
 *   - Node (tests, harness): module.exports
 */
(function () {
  'use strict';

  // Remap targets sampled from the official Predator Arcos II rack
  // (docs/Predator_Arcos_II.webp): hue = median of the ball's lit body.
  // Sat floors treat the reference colours as FULLY saturated (the promo
  // photo's arena wash only lowered measured HSL sat) — floors sit at
  // ~0.9 so the remapped balls read as vivid as the real balls.
  // Lightness scales per remap target (v2.6 tuning): the whole-ball remap
  // otherwise preserves pixel lightness exactly; these scale it so the
  // remapped balls read darker/brighter as a real ball of the target
  // colour would under the same light, and to separate look-alikes
  // (brighter orange vs the dark maroon 7; deeper blue/purple).
  const DEFAULTS = {
    enabled: true,
    orangeEnabled: true,
    pinkEnabled: true,
    cyanEnabled: true,
    tableEnabled: true, // gate remaps to the detected table region
    tableDebug: false,  // visualize the table mask instead of the video
    ballsEnabled: true, // per-ball colour gating (TODO #4)
    orangeHue: 30 / 360, // yellow-leaning amber: separates from the red 3 (~355°) and the maroon 7 (~20°), keeps a gap to the yellow 1 (~55–60°)
    orangeSat: 0.95,
    orangeSatBoost: 1.7,
    orangeLift: 0.06,
    orangeL: 1.06, // brighter → separates from the dark 7
    mauveSatMin: 0.05,
    mauveSatMax: 0.48,
    purpleHue: 276 / 360, // blue-leaning violet: 290° read too red/magenta on the remapped ball; 276° sits between blue-violet (270°) and the Arcos read, clearly "purple" not "pink"
    pinkSat: 0.88,
    pinkSatBoost: 1.15,
    pinkL: 0.94, // a bit darker / less neon
    blueHue: 215 / 360,
    cyanSat: 0.88,
    cyanSatBoost: 1.2,
    blueL: 0.90, // a bit darker
  };

  // The popup exposes only the toggles + per-remap saturation sliders.
  // orangeSat sits a bit under the 0.95 shader floor: the slider's max()
  // only matters for user-chosen values below the floor.
  const POPUP_DEFAULTS = {
    enabled: DEFAULTS.enabled,
    orangeEnabled: DEFAULTS.orangeEnabled,
    pinkEnabled: DEFAULTS.pinkEnabled,
    cyanEnabled: DEFAULTS.cyanEnabled,
    tableEnabled: DEFAULTS.tableEnabled,
    tableDebug: DEFAULTS.tableDebug,
    orangeSat: 0.78,
    pinkSat: DEFAULTS.pinkSat,
    cyanSat: 0.92,
  };

  // Detection thresholds as fixed constants. The old "Selectivity" sliders
  // were removed; these bake in their former default positions
  // (orangeSense 0.75, pinkSense 0.50, cyanSense 0.55).
  const DETECT = {
    MAUVE_RATIO: 0.30 + 0.75 * 0.35,         // 0.5625
    PINK_SAT_MIN: 0.12 + 0.50 * 0.20,        // 0.22
    PINK_MIN_BLUE_RATIO: 0.50 + 0.50 * 0.22, // 0.61
    PINK_BLUE_BIAS: 0.01 + 0.50 * 0.05,      // 0.035
    // Higher sat floor (spares green cloth / 6-ball)
    CYAN_SAT_MIN: 0.14 + 0.55 * 0.22,        // 0.261
  };

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform sampler2D u_mask;      // table region, R8, LINEAR upsampled
    uniform float u_hasMask;       // 1.0 = table gate active
    uniform float u_maskOk;        // 1.0 = table found in the last cycle
    uniform float u_debugMask;     // 1.0 = paint the mask instead of video
    uniform float u_orangeHue;
    uniform float u_orangeSat;
    uniform float u_orangeSatBoost;
    uniform float u_orangeLift;
    uniform float u_orangeL;
    uniform float u_purpleHue;
    uniform float u_pinkSat;
    uniform float u_pinkSatBoost;
    uniform float u_pinkL;
    uniform float u_mauveSatMin;
    uniform float u_mauveSatMax;
    uniform float u_mauveRatio;
    uniform float u_pinkSatMin;
    uniform float u_pinkBlueBias;
    uniform float u_pinkMinBlueRatio;
    uniform float u_orangeEnabled;
    uniform float u_pinkEnabled;
    uniform float u_cyanEnabled;
    uniform float u_blueHue;
    uniform float u_cyanSat;
    uniform float u_cyanSatBoost;
    uniform float u_blueL;
    uniform float u_cyanSatMin;
    uniform float u_aspect;        // videoWidth / videoHeight
    // Per-ball gating (balls.js classifier). xyz = centre (height-normalised)
    // + radius; r <= 0 → class not found → colour-only remap (fallback).
    uniform vec3 u_five;
    uniform vec3 u_four;
    uniform vec3 u_two;
    uniform float u_maskH;         // mask height in px (for px-sized overlays)

    vec3 rgb2hsl(vec3 c) {
      float maxc = max(max(c.r, c.g), c.b);
      float minc = min(min(c.r, c.g), c.b);
      float l = (maxc + minc) * 0.5;
      if (maxc == minc) return vec3(0.0, 0.0, l);
      float d = maxc - minc;
      float s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
      float h;
      if (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
      else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
      else h = (c.r - c.g) / d + 4.0;
      return vec3(h / 6.0, s, l);
    }

    float hue2rgb(float p, float q, float t) {
      if (t < 0.0) t += 1.0;
      if (t > 1.0) t -= 1.0;
      if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
      if (t < 0.5) return q;
      if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
      return p;
    }

    vec3 hsl2rgb(vec3 hsl) {
      float h = hsl.x, s = hsl.y, l = hsl.z;
      if (s == 0.0) return vec3(l);
      float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
      float p = 2.0 * l - q;
      return vec3(hue2rgb(p, q, h + 1.0/3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0/3.0));
    }

    // Whole-ball remap targets: preserve the pixel's EXACT lightness (l) —
    // highlights stay near-white, shadows stay dark, so the ball reads as a
    // real ball of the target colour under the same lighting. Only
    // saturation is modulated (less in deep shadow so the dark side doesn't
    // go neon). u_orangeLift stays in config/uniforms for compatibility but
    // the whole-ball remap deliberately ignores it (exact lightness).
    vec3 toOrange(float s, float l) {
      float shadow = smoothstep(0.03, 0.45, l);
      float sat = min(1.0, max(s * u_orangeSatBoost, u_orangeSat)) * mix(0.22, 1.0, shadow);
      return hsl2rgb(vec3(u_orangeHue, sat, min(1.0, l * u_orangeL)));
    }

    vec3 toPurple(float s, float l) {
      float shadow = smoothstep(0.03, 0.40, l);
      float sat = min(0.82, max(s * u_pinkSatBoost, u_pinkSat)) * mix(0.35, 1.0, shadow);
      return hsl2rgb(vec3(u_purpleHue, sat, min(1.0, l * u_pinkL)));
    }

    vec3 toBlue(float s, float l) {
      float shadow = smoothstep(0.03, 0.40, l);
      float sat = min(0.95, max(s * u_cyanSatBoost, u_cyanSat)) * mix(0.30, 1.0, shadow);
      return hsl2rgb(vec3(u_blueHue, sat, min(1.0, l * u_blueL)));
    }

    void main() {
      vec4 tex = texture2D(u_tex, v_uv);
      vec3 c = tex.rgb;
      // Aspect-corrected mask-space position (px/h) — shared by the per-ball
      // gating and the debug rings below.
      vec2 bp = vec2(v_uv.x * u_aspect, v_uv.y);

      // Table gate: outside the region, either passthrough or debug paint.
      // u_maskOk = 0 (no table found) → no remap anywhere; in debug view,
      // paint the whole frame black as an explicit "searching" signal.
      float inTable = 1.0;
      if (u_hasMask > 0.5 && u_maskOk < 0.5) {
        gl_FragColor = u_debugMask > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : tex;
        return;
      }
      if (u_hasMask > 0.5) {
        float m = texture2D(u_mask, v_uv).r;
        inTable = m;
        if (u_debugMask > 0.5) {
          // Mask debug view (independent of m's exact value):
          //   m >= 0.66 → felt (green) · 0.33–0.66 → enclosed hole (yellow)
          //   m < 0.33 → outside the table (dark grey, clearly visible)
          // Ball-classifier disks are drawn as rings on top:
          //   orange = five · purple = four · blue = two
          if (m >= 0.66) {
            gl_FragColor = vec4(0.08, 0.40, 0.21, 1.0);
          } else if (m >= 0.33) {
            gl_FragColor = vec4(1.0, 0.83, 0.0, 1.0);
          } else {
            gl_FragColor = vec4(0.16, 0.16, 0.16, 1.0);
          }
          float ringW = 1.5 / u_maskH; // 1.5 mask px, in px/h units
          if (u_five.z > 0.0 && abs(distance(bp, u_five.xy) - u_five.z) < ringW) {
            gl_FragColor = vec4(1.0, 0.55, 0.0, 1.0);
          } else if (u_four.z > 0.0 && abs(distance(bp, u_four.xy) - u_four.z) < ringW) {
            gl_FragColor = vec4(0.75, 0.0, 0.95, 1.0);
          } else if (u_two.z > 0.0 && abs(distance(bp, u_two.xy) - u_two.z) < ringW) {
            gl_FragColor = vec4(0.0, 0.45, 1.0, 1.0);
          }
          return;
        }
        if (inTable < 0.5) {
          gl_FragColor = tex;
          return;
        }
      }

      vec3 hsl = rgb2hsl(c);
      float s = hsl.y;
      float l = hsl.z;
      float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);

      if (s < 0.06 || chroma < 0.10 || l > 0.93) {
        gl_FragColor = tex;
        return;
      }
      if (l < 0.16 && (s < 0.22 || chroma < 0.14)) {
        gl_FragColor = tex;
        return;
      }

      bool inFive = u_five.z > 0.0 && distance(bp, u_five.xy) <= u_five.z;
      bool inFour = u_four.z > 0.0 && distance(bp, u_four.xy) <= u_four.z;
      bool inTwo = u_two.z > 0.0 && distance(bp, u_two.xy) <= u_two.z;
      bool inBall = inFive || inFour || inTwo;
      vec3 outc = c;

      // Outside every disk the strict generic guards still hold (nothing is
      // remapped out there anyway — this keeps felt/grey speckle handling
      // identical to the pre-disk behaviour).
      if (!inBall && (s < 0.06 || chroma < 0.10 || l > 0.93)) {
        gl_FragColor = tex;
        return;
      }
      if (!inBall && l < 0.16 && (s < 0.22 || chroma < 0.14)) {
        gl_FragColor = tex;
        return;
      }

      // Whole-ball tone remap: inside a verified disk, remap EVERY pixel
      // that isn't specular glare, the white number print / near-neutral
      // grey, or blue-grey FELT — all tones and hues (highlight, body,
      // shadow side) — preserving each pixel's exact lightness (toXxx keeps
      // l). Felt is blue-grey (G and B both beat R); the mauve/salmon balls
      // keep R ≥ G, so the ordering separates them where chroma cannot
      // (this arena's felt chroma ≈ the ball's). The turquoise 2 shares the
      // felt's channel ordering, so felt there must additionally be
      // low-chroma and low B−G. Classes without a verified ball are never
      // remapped.
      if (u_orangeEnabled > 0.5 && inFive) {
        // Mauve's darkest bottom shades are blue-dominant with G ≈ R
        // (G−R ≈ 4/255) — only felt at G−R ≥ 5 is excluded (lit felt sits
        // at G−R ≥ 6 even shadowed).
        // Brown spare (g − b > 20): the maroon 7 [138,84,49] leans
        // yellow-brown (g−b ≈ 35) while the 5's rose keeps B ≥ G−6 —
        // protects the 7 when an oversized remap disk reaches it.
        if (!(l > 0.94 || chroma < 0.06 || (c.g > c.r + 0.02 && c.b > c.r) ||
            c.g > c.b + 0.078)) {
          outc = toOrange(s, l);
        }
      } else if (u_pinkEnabled > 0.5 && inFour) {
        // Brown spare (g − b > 20): the salmon 4 keeps |b − g| ≤ 18 (its
        // rose has G ≈ B) while the brown 7 reads g−b ≈ 35 — the absolute
        // gap is wash-invariant (glare adds equally to G and B). Spares
        // the 7 / dark reds when the remap disk overshoots onto them.
        if (!(l > 0.94 || chroma < 0.06 || (c.g > c.r + 0.012 && c.b > c.r) ||
            c.g > c.b + 0.078)) {
          outc = toPurple(s, l);
        }
      } else if (u_cyanEnabled > 0.5 && inTwo) {
        bool feltLike = c.g > c.r + 0.012 && c.b > c.r
          && (c.b - c.g) < 0.098 && chroma < 0.176;
        if (!(l > 0.94 || chroma < 0.06 || feltLike)) {
          outc = toBlue(s, l);
        }
      }

      gl_FragColor = vec4(outc, tex.a);
    }
  `;

  // Per-class Arcos remap targets — mirrors DEFAULTS + the shader's toXxx
  // transforms, for the harness CPU replica (harness/preview.js) and docs.
  // `l` is the lightness scale; sh is the toXxx smoothstep window; cap the
  // per-class saturation ceiling.
  const TARGETS = {
    five: { hue: DEFAULTS.orangeHue, satMin: DEFAULTS.orangeSat, boost: DEFAULTS.orangeSatBoost, cap: 1.0, sLo: 0.22, sh: [0.03, 0.45], l: DEFAULTS.orangeL },
    four: { hue: DEFAULTS.purpleHue, satMin: DEFAULTS.pinkSat, boost: DEFAULTS.pinkSatBoost, cap: 0.82, sLo: 0.35, sh: [0.03, 0.40], l: DEFAULTS.pinkL },
    two: { hue: DEFAULTS.blueHue, satMin: DEFAULTS.cyanSat, boost: DEFAULTS.cyanSatBoost, cap: 0.95, sLo: 0.30, sh: [0.03, 0.40], l: DEFAULTS.blueL },
  };

  if (typeof window !== 'undefined') {
    window.__orangeFiveShared = { DEFAULTS, POPUP_DEFAULTS, DETECT, VERT, FRAG, TARGETS };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULTS, POPUP_DEFAULTS, DETECT, VERT, FRAG, TARGETS };
  }
})();