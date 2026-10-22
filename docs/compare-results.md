# Reading compare results

## compare --json

What the agent parses.

Top level, beside `states`: `skipped` lists the selected states that were
not compared, each as `{ state, reason }` — `capture-only` (no comp
mapping) or `no-capture-in-run` (a subset run: `capture --state X`
publishes a run holding only the states it captured, and compare
evaluates what the run holds instead of refusing it; it fails closed only
when the run holds none of the selected states).

Per state:

| field | meaning |
|---|---|
| `frame.mismatch` | 0..1 fraction of differing pixels |
| `verdict` | `pass`/`fail` at the threshold |
| `sections` | per-section breakdown of the same measurement |
| `regions` | the automatic diagnostic rollup: the 8 hottest 16px full-width row bands and full-height column bands with rects and per-band mismatch — **diagnostic only**, it never changes the verdict |
| `attribution` | the mismatch attributed to its cause (see [Attribution](#attribution)) |
| `provenance` | gate details (`compatible`, `fields`) |
| `configThreshold` | the value declared in `visual-diff.json` |
| `threshold` / `thresholdUsed` | the effective, override-aware evaluation thresholds |
| `override` | the CLI `--threshold` value, or null |

The `--threshold <pct>` flag overrides the config threshold for the whole
run — this is the hill-climb knob.

Read `regions` to aim the next step: a missing panel shows as hot column
bands, a thin stray band as one hot row band — a single frame percentage
cannot tell those apart.

```sh
node src/cli.mjs compare --threshold 5 --json   # loop until exit 0
```

### Thresholds, units, and the noise floor

**Sensitivity is pinned contract** (docs/DESIGN.md §4.4, FR-19): the per-pixel tolerance registers equal-channel colour differences from
~6/255 per channel (the YIQ-weighted boundary varies with colour direction).
Dark-on-dark UIs — near-black cards on near-black surfaces — diff
truthfully; a missing half-screen panel scores ~0.48, not ~0.05. Mismatch
percentages measured by earlier versions under a looser tolerance are not
comparable; re-baseline expectations when adopting a pin that changes it.

**Units, stated once** (they are not interchangeable): config and CLI
thresholds are **percent** (0..100); `frame.mismatch`, section/region
`mismatch`, and `noiseFloor` are **0..1 fractions**; the pixel tolerance
inside `PIXEL_OPTIONS` is a unitless YIQ colour-distance bound, not a
percent. `noiseFloor` is measured strictly — any byte difference between two
independent renders of the same screen (FR-11) — and compare refuses a
threshold below it unless `--force` (FR-22). For a near-threshold result,
reason with the margin (both as fractions): `threshold / 100 − noiseFloor`.

### Attribution

`attribution` goes one step further than `regions` and names the cause. It
is present on FAILING states, and on PASSING states that qualify for the
**uniform-delta advisory**: exactly one distinct colour pair, a dominant
pair clearing its own floors, and at least 64 **attributed** pixels. That
combination is the signature of a wrong design token — a 1px border
repainted the wrong colour can never reach a usable mismatch threshold, so
the verdict stays `pass` while every border in the UI is wrong — while the
floors keep routine antialiasing from ever printing as a structural claim.
Any other state under its threshold carries `attribution: null` and prints
nothing. It is computed from exactly the scored pixels — masked pixels never
appear in a band or a pair:

- `rowBands` — rows with differing pixels coalesced into contiguous bands,
  top 3 by share: `[{ "y0": 0, "y1": 33, "share": 0.41 }]`
  (`y1` exclusive, `share` is the fraction of the total mismatch).
- `dominantColorPair` — the most frequent exact (reference → capture) RGBA
  pair as hex: `{ "ref": "#1a2c42", "cap": "#0e1b2c", "share": 0.78 }`, or
  `null` when no pair clears the dominance floors (at least 2 pixels and 10%
  of the mismatch) — an honest "no single cause".
- `distinctColorPairs` — how many distinct pairs the mismatch contains. `1`
  means a uniform delta (a wrong token everywhere); thousands means a
  structural shift.
- `attributedPixels` — the denominator every share above is computed
  against: differing pixels inside the **shared** region. When the two
  images differ in size this is smaller than `frame.differingPixels`, which
  also counts dimension overflow — overflow has no pixel location, so it can
  be neither banded nor paired.

The human output prints the same two lines after the region rollup, e.g.
`attribution (diagnostic): row bands: rows 0–32: 41.0% of mismatch` and
`uniform delta #1a2c42 vs #0e1b2c (78.0% of 4096 attributed pixels, 1
distinct color pair)`. Like `regions`, attribution is diagnostic only.

## Run-to-run diff

What did my change actually move. Two forms of the same question — per-state
deltas between two compare runs, state-name sorted and deterministic:

```sh
noise visual-diff compare --against 20260820-101500-a1b2c3   # compare this run, then diff vs the named earlier run
noise visual-diff report --diff 20260820-101500-a1b2c3 20260821-093000-d4e5f6   # pure report-to-report diff, no re-compare
```

`compare --against <runId>` runs the normal compare, then prints the delta
table against the named run's stored report and records the deltas in this
run's `report.json`. `report --diff <runIdA> <runIdB>` diffs two stored runs
without re-comparing (deltas are B − A, "what moved from A to B"). An unknown
run id is a loud exit-2 usage error naming the `diffs/<runId>/report.json`
that was looked for.

The table prints verdict flips first, then states whose score moved without
flipping (deltas are signed percent points), then states present on one side
only — added/removed are listed, never silently skipped. A zero-movement run
prints an explicit `no state moved` line rather than nothing:

```
diff 20260820-101500-a1b2c3 -> 20260821-093000-d4e5f6:
  verdict flip: home: fail -> pass (12.0000% -> 1.0000%, Δ -11.0000 pct)
  moved: list: Δ +0.5000 pct (1.0000% -> 1.5000%), still pass
  added in 20260821-093000-d4e5f6: checkout
```

With `--against`, `report.json` carries the same facts: per state both runs
hold, a `vs` field
`{ "runId": "<against>", "mismatchDelta": -0.11, "verdictFrom": "fail", "verdictTo": "pass" }`
(`mismatchDelta` is this run's `frame.mismatch` minus the against run's, as a
fraction), and a run-level `diff` summary
`{ "againstRunId": "<against>", "moved": 2, "added": ["checkout"], "removed": [] }`.
`report --diff --json` emits `{ schema, command: "report", diff: { from, to, states, flips, added, removed, moved } }`.
