# Changelog

All notable changes to the **Orange Five** Chrome extension.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions
follow the extension's `manifest.json` (tags in git). The project remaps pool-ball
colours (mauve 5 → orange, pink 4 → purple, cyan 2 → blue) in WNT pool broadcast
video.

## [Unreleased]

Planned (see `TODO.md`):

- **#4 — Bulk ball classifier**: identify balls on the detected table by colour
  (connected components in hue ranges; biggest component wins each ball's slot),
  so each ball is remapped with its own target colour instead of global hue
  rules. This is the path to fixing colour spilling (dark pink on the 4 reading
  as orange on the 5) and to extending remapping to the 2 and the 4 with wider
  ranges.
- Table detection leftovers (accepted known limits): corner pockets unfilled,
  darkest bed under/behind players excluded, distant tables rejected by the 4%
  acceptance gate (fix would be scale-aware acceptance, not a lower floor).

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