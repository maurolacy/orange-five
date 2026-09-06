# Changelog

All notable changes to the **Orange Five** Chrome extension.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions
follow the extension's `manifest.json` (tags in git). The project remaps pool-ball
colours (mauve 5 → orange, pink 4 → purple, cyan 2 → blue) in WNT pool broadcast
video.

## [Unreleased]

### Removed

- **Selectivity sliders** (the "Sense" knobs) — retired from the popup. With
  the per-ball disk gating (#4) and the Arcos II saturation floors in place,
  detection strictness is no longer worth tuning per-event: the shader's
  detection thresholds (`mauveRatio`, `pinkSatMin`, `pinkBlueBias`,
  `pinkMinBlueRatio`, `cyanSatMin`) are now baked-in constants equal to the
  former slider defaults (orangeSense 0.75, pinkSense 0.50, cyanSense 0.55),
  so behaviour is unchanged. Per-remap **Saturation** sliders stay. Stale
  `orangeSense`/`pinkSense`/`cyanSense` keys are dropped from
  `chrome.storage.sync` on both popup and content-script load.

## [2.4.2] — 2026-09-06

### Changed

- **Remap targets from the official Predator Arcos II rack** (the "exact
  target tonalities" TODO; reference `docs/Predator_Arcos_II.webp`): hues
  sampled from the solid 5 / 4 / 2's lit body in the promo photo, sat floors
  treating the reference colours as FULLY saturated (the arena wash only
  lowered measured HSL sat — body tones measured 0.27–1.0 by lightness, so
  floors go to ~0.9). Orange (5): hue 32°→22°, sat floor 0.60→0.90.
  Purple (4): hue 258°→290°, sat floor 0.88 (unchanged), toPurple cap
  0.82→0.92 — the photo's warm cast reads the violet at 306°, which goes
  magenta at full sat; 290° (between the ball's cooler shadow side 296–300°
  and neutral Aramith-style 288°) matches the Arcos violet vividly. Blue (2): hue 220°→215°, sat floor 0.70→0.92 (measured ≈0.94
  even in the wash), toBlue cap 0.85→0.95. `popup.js` DEFAULTS updated to
  match — existing stored settings keep the old sats until a popup **Reset**.
  `harness/preview.js` TARGETS mirror all three plus an explicit per-class
  saturation `cap` so the CPU replica keeps matching the shader exactly.
  Live-watch: the reference was shot under warm arena light, so hues may sit
  ~5–10° red of brand-neutral — nudge `orangeHue`/`purpleHue`/`blueHue` if
  the live look drifts.

## [2.4.1] — 2026-09-05

### Added

- **Video-ingest harness** (`harness/ingest.js`): runs the full production
  pipeline (table mask + ball classifier) over a local clip or signed HLS
  rendition URL at a chosen fps/start, writing contact sheets (mask blended
  over the photo, classifier rings), per-frame `frames.jsonl` and a
  found/missing timeline per class. `harness/ballprobe.js` dumps every
  per-class candidate with blob gates + disk purity for single-frame forensics.
- **#4 — Bulk ball classifier** (`balls.js`): identifies balls on the detected
  table by colour (per-class connected components over the table region;
  biggest component wins each class slot). Classes: mauve 5 (desaturated rose,
  `B ≥ G` so the maroon 7 cannot leak), pink 4 (saturated rose, blue bias),
  cyan 2 (vivid — rail grey-blue rejected by a saturation floor). A small
  morphological close bridges the highlight/shadow fragments of one ball, and
  a phantom-5 guard discards a "five" whose centre falls inside the winning
  "four" (the 4's desaturated shadow side classifies as mauve).
- **Per-ball remap gating** (shader): the 5→orange, 4→purple and 2→blue
  remaps now apply only inside their ball's verified disk when that ball is
  found; classes without a detected ball are never remapped. This is the fix
  for colour spilling (dark pink on the 4 reading as orange on the 5).
- **#5 — Whole-ball tone remap** (shader + `balls.js`): inside a verified
  ball disk, EVERY pixel that isn't specular glare, the white number print /
  near-neutral grey, or blue-grey felt is remapped to the target hue — all
  tones and hues (highlight, body, shadow side) — while preserving each
  pixel's exact lightness, so the ball reads as a real ball of the
  target colour under the same lighting. Replaces the per-pixel hue-gated
  remaps (their un-bounded hue ranges were what #4's disk gating contained).
  Supporting pieces:
  - **Tight ball radius `br`** (stage 2): the mask-res blob can undershoot
    the visible ball by 2× (close fragments, washed edges), so `ballExtent`
    scans a wider native-res window and takes, per angular octant, the
    90th-percentile distance of the class's LOOSE-family pixels (`looseMatch`
    — like `classify` but admits shaded/washed ball tones; still never
    matches felt by channel ordering, near-neutrals, or the green 6). The
    disk radius is the max over octants + 2 px — it always covers the ball,
    even with a lit-side-biased centre. The shader receives `br/videoHeight`
    (px/h) as `u_five/u_four/u_two.z`; the debug rings hug the ball.
  - **In-disk felt exclusion by channel ordering**: this arena's washed felt
    (e.g. [164,179,191]) has the SAME chroma/saturation as the balls, so the
    old grey guards cannot separate them; felt is blue-grey (`G` and `B`
    both beat `R`) while the mauve/salmon balls keep `R ≥ G` — the ordering
    separates them. The turquoise 2 shares the ordering, so felt there must
    additionally be low-chroma/low-B−G. Outside all disks the strict generic
    guards still hold.

## [2.4.0] — 2026-09-05

### Added

- **#4 — Two-stage ball classifier** (`balls.js`): stage 1 proposes
  candidates on the 480-wide mask (classify → close r=2 → relaxed seed gates,
  top-4 per class + felt-detector bump-disc seeds); stage 2 scores each
  candidate's colour on the NATIVE-resolution frame (disk stats, purity,
  hot-pink fraction, speck guard `minArea·s²`, phantom-5 distance guard) via
  a padded crop of the table's bbox (`detectBallsFull`, wired into
  `table.js analyse()` with a legacy fallback). Fixes the real-footage
  orange-5 recall failure: 480-res purity 0.56–0.72 vs native 0.74–0.91;
  the previously missed real 5 now reads 100 % coverage on its segments
  (`node harness/ingest.js @3 --start 5956 …`). Results stay in mask space,
  so `content.js` and the shader are unchanged apart from the gates below.
- **Green-6 guard**: the 6 reads [106,204,177] under arena light — inside
  the cyan hue band and previously admitted by `b > 0.75·g`, so after the
  real 2 was potted the 6 could win the "two" slot (the "6 detected as the
  2" bug). The cyan gate now requires `b ≥ g − 12` in `balls.js classify`,
  as a native-disk mean check in `scoreFull`, and as `c.b > c.g − 0.05` in
  the shader's `looksCyan`: the absolute g−b gap survives white glare (it
  adds equally to G and B) where a B/G ratio drifts toward 1. Measured
  separation: real 2 g−b = −9…−2 (shaded/washed), 6 at g−b ≈ 27.
- Validated against the Rust-lab baseline: the five is detected on refs 1–4
  within 0–11 px of the known positions (480-wide mask space).
- New test suites `tests/balls.test.js` (classification order, biggest-wins,
  region gating, oversized-blob rejection, phantom-5 guard, ref2 real-frame
  position) and `tests/ballsfull.test.js` (mask-space coords, candidate
  traceability, speck rejection, crop-offset equivalence, legacy agreement,
  green-6 rejection).

### Fixed

- **6 detected as the 2 after the 2 is potted** (US Open DVR t≈1:40:32):
  stage-1 cyan gates admitted the green 6's colour; the g−b gap guard above
  rejects it in all three layers (classify, native disk scoring, shader).
  Verified on real footage: `two` tracks the real 2 until the pot and stays
  null afterwards, while the pre-pot tracking and the 5956 s five segment
  are unchanged.

### Performance

- Ball classifier adds ~14–18 ms per cycle (on the same downscaled frame as
  the mask; felt exits classification before any HSL math).

Planned next (see `TODO.md`):

- Table detection leftovers (accepted known limits): corner pockets unfilled,
  darkest bed under/behind players excluded, distant tables rejected by the 4%
  acceptance gate (fix would be scale-aware acceptance, not a lower floor).
- Temporal smoothing for ball disks (hold last disk across cycles; the mask
  already behaves this way via upload-skip).

## [2.3.3] — 2026-09-05

### Added

- Performance instrumentation: the table detector reports per-step timings in
  `res.timings` (seed / classify / morph / shadow / ballclose / flood / fill /
  bumps / mask).
- `npm run bench`: reference benchmark over all testdata frames (median-of-5
  per frame, per-step breakdown). Reference: ~33 ms per analyse at 480-wide.
- Performance regression test (median-based, ~4.5× headroom) so catastrophic
  regressions fail the suite while CI noise doesn't flake.

### Changed

- Test data rescaled to keep the repo small (~55 MB → 3.9 MB): 480-wide for
  the table pipeline, ≤2560-wide (Rust baseline space) for the frames the
  ball-detector tests need. Full-size originals live outside the repo.
- `table_fail4` regression test pins the distant-table NOWHERE behaviour
  (mask ~80% correct but under the 4% acceptance gate — accepted by design).

### Performance

- Internal scratch buffers pooled across runs (~13 MB → ~2 MB transient
  allocations per analyse, i.e. ~130 MB/s → ~20 MB/s of GC churn at 10 Hz);
  outputs (`felt`, `region`, `maskU8`, …) stay fresh per call.
- `keepLargestComponent` rewritten as a single labeling pass (no full-mask
  copies, no second flood).

## [2.3.2] — 2026-09-05

### Added

- **Shadow extension** for the table detector: broadcast arenas that light
  only a sliver of the bed (dark-arena frames, e.g. US Open 9-ball) annex the
  adjacent shaded bed using cloth *ordering* invariants (blue lean `b−r ≥ 12`,
  `B ≥ G`, modest saturation, loose chroma bound) with a deep lightness window.
  Only felt-adjacent components qualify, so shadowed crowd/shirt is not
  annexed. Regressed on `table_fail3` (US Open frame: 3.2% → 4.5%, NOWHERE →
  OK) and improves fail2's previously unreachable unlit bed.

## [2.3.1] — 2026-09-04

### Added

- **Border-hole fill**: border-reached, felt-adjacent, roundish non-felt
  components (balls cut by the frame edge) join the remap region as holes.
- **Ball-scale bite filling**: a morphological closing with a felt-size-derived
  radius (`ballR ≈ clamp(0.05·√felt, 12, 28)`) fills round *bites* out of the
  felt boundary — rail balls welded to the background component.
- **Ball completion (bumps)**: filled bites are completed into full balls
  (geometric placement from the bite chord), so the outer half of a rail ball
  remaps too. Debug view paints bumps magenta.
- `npm run table` / `harness/tableview.js`: run the detector on any frame from
  the CLI and write the debug mask / photo overlay for visual inspection.
- Synthetic tests for every fill mechanism, including tightness contracts
  (bumps must complete the ball without over-running it).

## [2.2.3] — 2026-09-03

### Changed

- Table mask detection frequency raised to 10 Hz with adaptive backoff
  (≥100 ms period, never more than ~⅓ wall time on the detector).

## [2.2.2] — 2026-09-03

### Added

- **Table/cloth detector** (`table.js`): grey-blue low-saturation felt seed →
  classification → morphological close/open → largest component → border
  flood. Colour remaps are gated to the detected table region (felt ∪
  enclosed pockets of non-felt, i.e. balls), fixing the "cheeks, arms and set
  dressing get repainted" problem of the global remapper.
- Test suite (`npm test`): structural assertions over reference frames
  (bright studio + lateral angles), synthetic player-weld regression, and
  agreement with the Rust-lab baseline (`orange-five-detect`) for the mauve
  5-ball.
- Bed-lighting fixes: better felt detector / median anchoring, lighting
  variance tolerance (spotlit bed L≈0.75–0.82 over darker rails).

## [2.1.1] — 2026-08-30

### Fixed

- Avoid breaking YouTube streams (extension is now WNT-only).

## [2.1.0] — 2026-08-30

### Changed

- Project / extension renamed to its final name.

## [2.0.3] — 2026-08-30

### Fixed

- WebGL context leak from Mux player remounts: single active processor,
  contexts disposed via `WEBGL_lose_context`, tiny non-stream videos ignored.

## [2.0.2] — 2026-08-30

### Changed

- Final global-remapper polish: settings sync only via `chrome.storage`,
  removed unused CSS-filter cleanup and popup→tab messaging.

## [2.0.1] — 2026-08-30

### Added

- Extension icon(s).

## [2.0.0] — 2026-08-30

### Changed

- Rebuilt as a best-effort **global WebGL remapper**: tuned purple→orange
  (mauve 5) and pink→purple (4) shaders with popup controls (per-colour
  on/off, sensitivity, saturation), optional cyan→blue (2).
- Dropped the first-generation table-region detector as too brittle — colour
  remap ran full-frame again (the table detector returned in 2.2.x, reborn
  from the `orange-five-detect` Rust experiments).

## [1.x] — 2026-08-29/30

The experimental road that got here:

- Initial 2D-canvas prototypes intercepting WNT video (mux-player / mux-video).
- 5 → orange colour replacement, then active per-pixel filtering (v1.5).
- **v1.7**: WebGL renderer / remapper (GPU per-pixel hue remap).
- **v1.10**: sensitivity / saturation sliders.
