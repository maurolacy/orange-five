# Test data

Everything the `tests/` suite reads. Files are checked in so `npm test`
works from a fresh clone.

The suite is **structural-only**: felt-fraction bands, anchor color classes,
synthetic regressions, and agreement with the Rust baseline. There are no
pixel hashes or hand-painted ground-truth masks — those proved too brittle
for a detector under active tuning. For visual review, load the frame in the
extension's debug view or check the ASCII masks the tests print on failure.

## Files

| file | size | what it is |
|---|---|---|
| `ref1.png` … `ref10.png` | ~1–5M each | Reference frames from WNT broadcast (bright studio). Copied from the `orange-five-detect` repo. refs 1–3: overhead/high angle, table fills frame; refs 4–7, 9, 10: higher/lateral; ref8: distant, table is a small top-band wedge. |
| `table_fail1.png` | 6.1M | **Failure frame 1**: dark arena. Bed felt at L≈0.12, spotlight gradient, player's grey shirt near the slate. Originally: player welded to the table mask. Known-limited: detector catches only a bed sliver (~5%). |
| `table_fail3.png` | — | **Failure frame 3**: US Open 9-ball broadcast, dark blue-lit arena. Bed lit only at the left sliver (~3.2%); rest in deep shadow ([16,22,29], L≈0.09). Needs the shadow-extension pass (table.js 3c) to cross the 4% gate. |
| `table_fail2.png` | 7.2M | **Failure frame 2**: bright spotlit bed (L≈0.75–0.82) with darker rails (L≈0.55). Originally: only the rails detected ("staircase" wedges). Fixed by raising bright-mode lightness caps; anchor must land on the lit bed. |
| `rust-baseline.txt` | 10K | Rust reference output (orange-five-detect, `--method cloth`, defaults) used by `tests/detector.test.js`. |

## Test expectations, per frame

- **refs 1–3**: felt ≥ 20% (table fills frame).
- **refs 4–7, 9, 10**: felt ≥ 10% (lateral angles).
- **ref8**: felt ≥ 2% (distant table wedge; flipped NOWHERE→OK when bright-mode
  lightness caps widened for fail2 — verified visually in the extension).
- **fail1**: anchor must be dark blue-bed felt (`b−r ≥ 12`, `b ≥ g`); felt ≥ 3%.
- **fail2**: anchor must be lit bed (L ≥ 0.70, blue lean); felt ≥ 6%.
- **detector vs Rust** (2560-wide space): JS 5-ball must land within
  `max(30px, 1.5×r)` of *any* Rust mauve-5 pick for refs 1–4; ref8 must
  produce no 5-ball.

## Regenerating the Rust baseline

From `orange-five-detect/` (kept as a sibling repo, untouched):

```
cargo run --release -- --method cloth <path to refN> ... > ../testdata/rust-baseline.txt
```

Only mauve-5 labels are used by the JS comparison.

## Extending

- New failure frame → drop the PNG here, add a `tests/table.test.js` case
  with explicit structural expectations (fraction band + anchor class),
  and note the failure mode in the table above.
- New ball colors: extend `tests/detector.test.js` expectations from the
  Rust baseline text.