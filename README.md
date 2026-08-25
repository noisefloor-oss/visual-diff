# noise visual-diff

> Deterministic design-to-implementation pixel comparison, built to be
> driven by coding agents.

**Status: experimental.** Daily-driven by its author against real projects;
interfaces, file formats, and exit codes may change between releases without
a deprecation cycle. This repository is a curated release mirror — see
[DEVELOPMENT.md](DEVELOPMENT.md) for the development model (snapshot
releases, pull requests closed, issues open) and [SECURITY.md](SECURITY.md)
for vulnerability reporting. Part of the Noisefloor suite
([noisefloor.sh](https://noisefloor.sh)); works standalone, no other suite
tool required.

A `noise`-suite micro tool **built for agentic use**. It exists to close the
loop an orchestrating agent runs every day:

1. a design is exported from Claude Design as a `.zip` of `.dc.html` comps;
2. an agent implements the UI;
3. the agent must prove, with pixels, that the implementation matches the
   design — and hill-climb on the diffs until they do.

visual-diff is the ground-truth harness for step 3. It renders the design
comps into reference screenshots (`import`), takes deterministic screenshots
of the running implementation (`capture`), and pixel-compares the two under
a strict provenance gate (`compare`, `report`). Every verb is scriptable:
stable exit codes, `--json` on read verbs, deterministic artifact layout, no
interactive prompts, no hidden state outside `.visual-diff/`.

It is designed to be driven by an agent, not a human: the agent reads exit
codes and JSON, edits code between rounds, and archives per-round artifacts
as visual proof (implemented vs reference) for a PR.

The CLI is self-documenting: `noise visual-diff help` (or `--help`) prints
the full flag/exit-code/env-var/artifact reference to stdout, and
`noise visual-diff help <verb>` prints per-verb detail. Both exit 0 and are
safe to call in any directory. This README remains the prose documentation
(config schema, report.json fields, playbooks); the help text is the terse
scripting reference.

## How to work with this tool (the agent playbook)

### One-time setup

```sh
# 1. Import the design export — renders every comp screen into
#    .visual-diff/references/ with provenance. First import has no config
#    yet, so references record the hydration default.
#    Native hosts: --auto-discover-browser walks the discovery ladder ONCE
#    and atomically pins the accepted browser into the config (see "Browser
#    modes" below). Service hosts (NOISE_BROWSER_WS set): omit the flag —
#    discovery is a native-mode act and exits 2 there.
noise visual-diff import --auto-discover-browser design-export.zip

# 2. Author .visual-diff/visual-diff.json — one state per screen you intend
#    to verify, each mapping a route to a comp#screen (config schema below).
#    Read .visual-diff/references/manifest.json for the exact comp/screen ids.
#    (The browser pin written in step 1 stays untouched — edit states only.)

# 3. Re-align references to the config (readiness policy + config hash), so
#    the FR-23 provenance gate matches what capture will record.
noise visual-diff import --refresh design-export.zip
```

### The hill-climb round (repeat until compare exits 0)

```sh
noise visual-diff capture                      # exit 0 = verified run staged
noise visual-diff compare --threshold 2 --json # exit 0 = pass, 1 = over threshold
# parse the JSON, fix the implementation, archive the round, repeat
```

Capture **stages** its verified run and clears `.visual-diff/current-run`;
the next successful **compare** is what publishes the staged run (it flips
the pointer atomically after writing the diffs and report). A fresh,
fully verified capture therefore supersedes the published pointer
automatically — **never delete `.visual-diff/current-run` by hand**, and
never hand-edit provenance records. Both were once manual workarounds; the
tool now does them itself, and doing them by hand masks real problems.

A minimal round driver looks like this (it is the pattern the tool's own
development runs — copy it, don't reinvent it):

```bash
#!/bin/bash
set -u
round="round-$(date +%s)"
mkdir -p "rounds/$round"

noise visual-diff capture > "rounds/$round/capture.log" 2>&1 || {
  code=$?
  [ $code -eq 4 ] && echo "nondeterministic — safe to retry" || echo "real failure, stop"
  exit $code
}
noise visual-diff compare --threshold 2 --json > "rounds/$round/compare.json"
code=$?
run=$(jq -r .runId "rounds/$round/compare.json")
cp -r ".visual-diff/diffs/$run" "rounds/$round/diffs"
cp -r ".visual-diff/captures/$run" "rounds/$round/captures"
exit $code   # 0 = converged, 1 = keep climbing, 3 = STOP (gate)
```

### Recovery playbook (what to do on each failure)

| exit | meaning | recovery |
|---|---|---|
| 1 | over threshold | normal loop iteration — parse `states.<name>.frame.mismatch`, look at `diffs/<run>/<state>.png`, fix the implementation, re-capture |
| 2 | usage | bad flags or broken config — read stderr, fix, re-run; never retried blindly |
| 3 (compare) | provenance gate | read the named fields in stderr. Almost always: config written/edited after import without `--refresh` → run `import --refresh`. Otherwise: renderer mismatch (imported and captured under different browsers/modes) → redo both in the same mode |
| 3 (browser) | no working browser | native: no pin yet → run any import/capture once with `--auto-discover-browser`; stale pin (binary moved/upgraded) → re-run with `--auto-discover-browser` to re-pin. If every ladder rung fails, read the probe report on stderr and run the printed fix command. On a service host, check `NOISE_BROWSER_WS` is set and the browser service is up — it never falls back silently |
| 4 | capture nondeterministic | discard and re-capture from a fresh context — transient load can cause this. If the SAME state fails repeatedly when the host is quiet, the page itself is nondeterministic: freeze clocks/animations, await webfonts, raise `readiness.settle` |

### Operating rules learned from dogfooding

- **One runner per browser sidecar.** Concurrent captures against the same
  `NOISE_BROWSER_WS` endpoint can flake the determinism self-check
  (exit 4). Serialize rounds; don't share the sidecar with another agent's
  live test suite.
- **Threshold is a knob, not a verdict on quality.** Start loose
  (`--threshold 5`), tighten as you converge. `report --json` reads the last
  published verdict without re-comparing.
- **Archive every round.** Copy `captures/<run>/`, `diffs/<run>/`, and the
  compare JSON into a `rounds/` dir before the next capture. Side-by-side
  composites (reference | diff | implementation) per state are the proof a
  PR reviewer actually wants to see.
- **A pass is only meaningful through the gate.** Exit 0 means the pixels
  matched AND the reference/capture were provably rendered under the same
  browser, viewport, DPR, readiness, fonts, and config. If you find yourself
  wanting to bypass the gate, the correct move is `import --refresh`, never
  an edit to `.provenance.json`.

## Exit codes (the agent contract)

The recovery playbook above is the actionable version; the codes themselves
are stable API:

- `0` — success (compare: under threshold)
- `1` — compare: over threshold
- `2` — usage error (bad flags, bad config, missing zip)
- `3` — trust failure (provenance gate, browser resolution, archive trust)
- `4` — capture determinism self-check failed

`capture` re-renders every state from a fresh context and byte-compares the
two passes before staging a run. A run that fails this self-check is
never staged and never disturbs the last compare verdict.

## compare --json (what the agent parses)

Top level, beside `states`: `skipped` lists the selected states that were
not compared, each as `{ state, reason }` — `capture-only` (no comp
mapping) or `no-capture-in-run` (a subset run: `capture --state X`
publishes a run holding only the states it captured, and compare
evaluates what the run holds instead of refusing it; it fails closed only
when the run holds none of the selected states).

Per state: `frame.mismatch` (0..1 fraction of differing pixels), `verdict`
(`pass`/`fail` at the threshold), section breakdowns, `regions` (the
automatic diagnostic rollup: the 8 hottest 16px full-width row bands and
full-height column bands with rects and per-band mismatch — **diagnostic
only**, it never changes the verdict), `attribution` (the mismatch
attributed to its cause — see below), and `provenance` gate
details (`compatible`, `fields`). Threshold provenance per state:
`configThreshold` is the value declared in `visual-diff.json`;
`threshold`/`thresholdUsed` are the effective, override-aware evaluation
thresholds; `override` is the CLI `--threshold` value or null. The
`--threshold <pct>` flag overrides the config threshold for the whole run —
this is the hill-climb knob:

**Sensitivity is pinned contract** (docs/DESIGN.md §4.4, FR-19): the per-pixel tolerance registers equal-channel colour differences from
~6/255 per channel (the YIQ-weighted boundary varies with colour direction).
Dark-on-dark UIs — near-black cards on near-black surfaces — diff
truthfully; a missing half-screen panel scores ~0.48, not ~0.05. Mismatch
percentages measured by earlier versions under a looser tolerance are not
comparable; re-baseline expectations when adopting a pin that changes it.

Read `regions` to aim the next step: a missing panel shows as hot column
bands, a thin stray band as one hot row band — a single frame percentage
cannot tell those apart.

`attribution` goes one step further and names the cause. It is present only
on FAILING states — a state under its threshold carries `attribution: null`
and prints nothing, however many pixels differ — and it is computed from
exactly the scored pixels — masked pixels never appear in a band or a pair:

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

The human output prints the same two lines after the region rollup, e.g.
`attribution (diagnostic): row bands: rows 0–32: 41.0% of mismatch` and
`uniform delta #1a2c42 vs #0e1b2c (78.0% of mismatched pixels, 1 distinct
color pair)`. Like `regions`, attribution is diagnostic only.

**Units, stated once** (they are not interchangeable): config and CLI
thresholds are **percent** (0..100); `frame.mismatch`, section/region
`mismatch`, and `noiseFloor` are **0..1 fractions**; the pixel tolerance
inside `PIXEL_OPTIONS` is a unitless YIQ colour-distance bound, not a
percent. `noiseFloor` is measured strictly — any byte difference between two
independent renders of the same screen (FR-11) — and compare refuses a
threshold below it unless `--force` (FR-22). For a near-threshold result,
reason with the margin (both as fractions): `threshold / 100 − noiseFloor`.

```sh
node src/cli.mjs compare --threshold 5 --json   # loop until exit 0
```

## Run-to-run diff (what did my change actually move)

Two forms of the same question — per-state deltas between two compare runs,
state-name sorted and deterministic:

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

## Project config (`.visual-diff/visual-diff.json`)

```json
{
  "version": 1,
  "browser": {
    "backend": "playwright-managed",
    "rung": 1,
    "locator": { "executablePath": "/abs/path/to/chromium-headless-shell" },
    "browserRevision": "1234",
    "discoveredAt": "2026-08-12T16:00:00Z"
  },
  "states": {
    "01-main": {
      "route": { "staticDir": "impl/01-main" },
      "comp": "app#01-main",
      "viewport": { "width": 1502, "height": 818, "fullPage": true },
      "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
      "threshold": 1,
      "sections": { "canvas": { "x": 0.22, "y": 0.05, "width": 0.78, "height": 0.9 } },
      "masks": { "info-bar": { "x": 0, "y": 0, "width": 1, "height": 0.04 } }
    },
    "mobile-01": {
      "route": "http://127.0.0.1:3000/",
      "comp": "atlas-5-mobile#01-canvas",
      "viewport": { "width": 393, "height": 864 },
      "clip": "[data-phone-frame]",
      "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
      "threshold": 0.5,
      "selfCheck": { "maxDiffPixels": 64 }
    }
  },
  "masks": {
    "device-bezel": {
      "selector": "[data-phone-frame]",
      "compSelector": "[data-phone-frame]",
      "shape": "ring",
      "reason": "the comp draws device chrome the app cannot paint"
    }
  }
}
```

- `browser` is the **tool-managed pin** (native mode) written by
  `--auto-discover-browser` — you can read it, diff it, and hand-author it,
  but you normally never edit it; re-run the flag to re-pin. Its semantic
  fields feed the config hash; `discoveredAt` is observational only.
  Absent in service-only projects.

- `route.staticDir` serves a local directory over a throwaway HTTP server;
  `route.url` points at an already-running app. `route.setupScript` runs
  before capture for seeding.

- `capture --serve <distDir>` makes the tool serve the build itself: one
  ephemeral-port loopback server rooted at `distDir` for the whole run, so a
  stale server on the configured port (or another worktree's preview) can
  never silently answer for the capture, and worktrees never contend for a
  port. Under `--serve`, a `route.url` state pointing at a loopback http(s)
  origin (`127.0.0.1`, `localhost`, `[::1]`) has its origin rewritten onto
  that server — path and query survive — and a `route.staticDir` state must
  equal or nest inside `distDir` and is served at its relative path
  (`--serve` roots the whole run; a staticDir outside the dist tree is a
  usage error). `file:` URLs and non-loopback http(s) URLs are usage errors
  (exit 2): serving something else for a remote URL would be the same bug
  class. The dist tree's content hash — sha256 over a canonical, sorted
  listing of `per-file-sha256 + relative path` lines, following the same
  symlink policy as the static server — is computed once per run and
  recorded in every captured state's provenance as
  `inputs.serve: { root, sha256 }` (informational; the provenance gate never
  gates on it). The server shuts down at the end of the run, success or
  failure.

- `readiness.selector` (optional) is the **implementation-side** readiness
  signal: capture waits for it to become visible after the policy wait, and a
  selector that never appears fails the capture loudly (exit 3) naming it —
  a frame of the wrong state is worse than no frame. `readiness.compSelector`
  is the comp-side equivalent, consumed by import's driven render (FR-37).
  The two are side-bound by design: never point `selector` at comp markup.
- `comp` is `<comp-name>#<screen-id>` from the import manifest
  (`.visual-diff/references/manifest.json`). States without `comp` are
  capture-only.
- The provenance gate (exit 3) requires reference and capture to agree on
  viewport, device scale factor, readiness, fonts, vendor hashes, and the
  config hash. This is what makes a "pass" mean "same renderer, same
  conditions" rather than a coincidence. Keep the state viewport at the
  reference default (1502×818, fullPage, DSF 2). The config hash is compared
  **per state**: every record carries `inputs.stateConfigHash`, the
  hash of the whole-config projection minus the *other* states, so editing
  one state's route — or adding a state — invalidates only that state's
  references and captures, never the rest. The browser pin is shared, so
  re-pinning still moves every state's hash. The whole-config
  `inputs.configHash` is still recorded as the run-level fingerprint, and it
  remains the gate's **fallback**: a record written before the per-state
  field existed (or a reference record for a screen shared by several
  states, which cannot honestly name one state's hash) is compared on the
  whole-config hash, exactly as before — old records neither pass silently
  nor invalidate en masse.

- `masks` (FR-36) exclude **deliberate** divergences from scoring: named
  regions whose pixels leave the mismatch numerator **and** denominator of
  every unit covering them — frame, sections, and the region rollup. Two
  forms: a **fractional rect** (`{ x, y, width, height }`, same shape as
  sections, no threshold — the fallback for subjects with no stable element),
  or an **anchored mask** (`{ selector, compSelector?, shape? }`) that names
  what it excludes: `selector` resolves against the capture page at capture
  time, `compSelector` against the comp render at import time (both must
  match exactly one visible element, fail-loud), and the resolved geometry is
  recorded in each side's provenance. Without `compSelector` the
  capture-resolved rect maps onto the reference by the geometry ratio.
  `shape: "ring"` masks the element's border band — rounded corners included
  — for device bezels a rectangle cannot express. A top-level `masks` block
  declares shared masks once (device chrome is a category); a state-local
  mask of the same name overrides. Masks are **compare-time
  configuration**: they never enter the config hash, so editing a mask
  invalidates neither references nor captures — a mask retarget after a
  layout change costs a re-compare, nothing else. Masking is never silent:
  the report lists each mask's name and excluded pixel count, warns (and
  flags `maskDrift` in the report) when that count changed materially since
  the previous report — a mask drifting off (or onto) its subject — and a
  mask whose rect excludes 0 pixels over the compared area is an error
  (exit 2), not a silent no-op. An anchored mask whose resolution is missing
  or stale in provenance fails closed (exit 2) naming the remedy (re-capture
  / re-import): an anchor never fails open the way a hand-computed fraction
  can.

- `data-vd-mask` (comp-authored masks) let the **comp author** mark regions
  a browser capture can never render — device/OS chrome drawn into the design
  itself, like an on-screen OS keyboard. Any element inside a screen carrying
  `data-vd-mask="<name>"` becomes a mask automatically at import: no config
  entry needed. The attribute value is the mask name and must name exactly
  one visible element per screen (an empty value or a duplicate visible name
  fails the import, exit 3). Import records the element's rect as fractions
  of the screen frame in the reference provenance (`inputs.compAuthoredMasks`,
  clamped into the frame; the field is always present after import — empty
  when the screen has no annotations, so "probed, none found" is
  distinguishable from "never probed"); compare merges them exactly like
  fractional config masks, mapping the fractions onto each side's own pixel
  space. A config mask of the same name wins — the operator's explicit
  declaration overrides the comp author's annotation. References imported
  before this feature carry no `compAuthoredMasks`; the next re-import
  re-probes the annotations and rewrites the record (pixels untouched), no
  `--refresh` needed.

- `selfCheck` (optional, per state) bounds the FR-17 determinism re-capture:
  by default the two captures must be byte-identical (any difference is exit
  4); a state with a known-nondeterministic element (the blinking-caret
  class) may declare `maxDiffPixels`, and a pixel difference within budget is
  accepted and recorded in the capture's provenance instead of failing. A
  dimension change fails regardless. Pair the budget with an anchored mask
  on the caret element so the declared nondeterminism stays out of the
  scored diff too.

- `capture` (optional, top level) injects capture-time fixtures so projects
  stop carrying capture scaffolding in their markup:
  `"capture": { "suppressCaret": true, "pinAnimationPhase": true }`.
  `suppressCaret` hides the browser-native caret (which CSS animation
  freezing cannot reach) via injected `caret-color: transparent`;
  `pinAnimationPhase` re-asserts the anti-animation stylesheet immediately
  before the screenshot so nodes an app bootstrap added (or a stripped
  init-style node) cannot animate mid-capture. Both ride the context init
  script AND are re-asserted in the screenshot's own task. The flags change
  rendered pixels, so they enter `configHash`: flipping one requires a
  re-capture (and re-import), exactly like a viewport change.

## Browser modes — two, no silent fallback

- **Service mode (remote browser service):** set `NOISE_BROWSER_WS` to the
  `ws://` endpoint of any Playwright browser server — for example,
  `npx playwright@1.62.1 run-server` prints one (the server's Playwright
  version must match the tool's pinned client version). visual-diff connects
  to that WebSocket endpoint and only that one. If it is set but refused,
  the verb exits 3 — it never falls back to a local browser, and it never
  runs `npx playwright install` on a service host. A config pin is never
  *used* in service mode (but a malformed one still fails config
  validation, exit 2).
- **Native mode (any other host):** the browser is **pinned, not searched
  for**. Discovery is explicit: `import --auto-discover-browser` (or
  `capture --auto-discover-browser`) walks the launch-verified ladder —
  playwright managed cache → system channel → agent-browser CLI — accepts
  the first working rung, and **atomically writes a `browser` pin** into
  `.visual-diff/visual-diff.json` (backend, rung, locator, browserRevision).
  Every later run launch-verifies **exactly the pinned locator** — the
  ladder never re-walks implicitly:
  - no pin and no flag → exit 3, zero probes, with the remedy spelled out;
  - a stale pin (binary deleted/upgraded) → exit 3 with a probe report
    scoped to the pinned locator and `re-run with --auto-discover-browser`;
  - `--auto-discover-browser` under service mode → exit 2 (discovery is a
    native-mode act).
- `--browser <ws|native>` forces the mode for one run (wins over
  `NOISE_BROWSER_WS`); it selects the mode only — it never implies
  discovery. `--browser ws --auto-discover-browser` is a usage error.

The pin is inspectable, diffable, and hand-authorable JSON. Because the
semantic pin fields feed the config hash (and therefore every state's
per-state hash), swapping the pinned browser invalidates references
deliberately: compare exits 3 naming `inputs.stateConfigHash` (or
`inputs.configHash` for legacy records), and one `import --refresh`
realigns.

The renderer identity (browser build, client version, mode) is recorded in
every provenance record; references imported under one renderer will not
gate-match captures under another. Import and capture in the same mode.

## Artifacts (the PR proof)

Everything lives under `.visual-diff/` (gitignore it in the host project):

```
.visual-diff/
  references/<comp>#<screen>.png + .provenance.json + manifest.json
  captures/<run-id>/<state>.png + .provenance.json
  diffs/<run-id>/<state>.png
  current-run                 # published pointer — managed by the tool
```

An orchestrating agent archives `captures/<run>/`, `diffs/<run>/`, and the
compare JSON per hill-climb round (plus side-by-side composites) so a PR can
show implemented-vs-reference visually, round by round.

## Running it

**From a release artifact** (recommended): download the single-file
`noise-visual-diff` executable from the GitHub release, verify it against
the `SHA256SUMS` file attached to the same release, mark it executable, and
run it directly — it bundles Node and every npm dependency (a browser is
still required; see Dependencies below).

```sh
sha256sum -c SHA256SUMS          # verify the download
chmod +x noise-visual-diff
./noise-visual-diff help
```

**From a checkout:**

```sh
# from a checkout (Node pinned in .nvmrc)
npm ci
node src/cli.mjs <verb> ...

# or build the single-file SEA executable yourself (dist/noise-visual-diff)
npm run build:sea

# suite version (deployment gates compare this verbatim)
noise visual-diff version    # -> noise-visual-diff 0.8.0
```

**Uninstall / data retention:** the tool writes `.visual-diff/` inside the
project it runs in, and the packaged binary additionally materializes its
embedded Playwright client to
`$XDG_CACHE_HOME/noise-visual-diff-sea/` (default
`~/.cache/noise-visual-diff-sea/`) on first use. Delete `.visual-diff/`,
that cache directory, and the binary to remove every trace the tool
created. Browsers installed by your discovery rung (Playwright's managed
cache, a system browser, agent-browser) belong to those tools and are
never installed or removed by this one.

## Dependencies

- **Using the distributed binary:** the SEA build bundles Node and every npm
  dependency into one file — but a **browser is always required**, and it is
  NOT bundled. In service mode the remote browser service provides it (nothing local
  to install); in native mode a local chromium comes from the discovery
  ladder (playwright managed cache, system Chrome/Edge/Chromium, or
  agent-browser) the first time you pass `--auto-discover-browser`, and is
  pinned in the config from then on — see the two modes above. If nothing
  works, the tool exits 3 with a probe report and the exact fix command.
- **Developing from a checkout:** Node exact-pinned in `.nvmrc`; `npm ci`
  installs the exact-pinned deps (`playwright`, `pngjs`, `pixelmatch`). No
  caret ranges, and no new dependencies without a DESIGN note — CI enforces the
  pins. The authoritative list is `package.json` + the lockfile.

## Development

- `npm test` — full suite. Offline by default; set
  `NOISE_BROWSER_WS` to include the live browser-service tests. Test
  scratch lives under the gitignored in-tree `.tmp/` (per-process
  `run-<pid>` roots via `test/helpers/tmp.mjs`, removed on exit; stale
  roots from killed runs are swept on the next run) — never in `/tmp`.
- Ground truth: `docs/DESIGN.md` (the FR/NFR requirement index cited
  throughout the source and tests).

## License

MIT © 2026 Doug Doan. Built at Noisefloor.
