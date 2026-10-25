# Project config

`.visual-diff/visual-diff.json`. A worked example carrying most of the
shapes described below — a static-dir state with sections and a local mask,
a driven state, and a clipped mobile state with a self-check budget and a
shared anchored mask:

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
    "menu": {
      "route": { "staticDir": "impl" },
      "comp": "app#02-menu",
      "viewport": { "width": 1502, "height": 818, "fullPage": true },
      "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
      "threshold": 1,
      "compDrive": [{ "click": "[data-comp-menu-button]" }],
      "drive": [{ "click": "[data-menu-button]" }, { "mouse": "away" }]
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

Whether a key enters the config hash decides what editing it costs: a
hashed key invalidates that state's pair through the provenance gate
(re-import with `--refresh` and re-capture), an unhashed one costs a
re-compare at most.

| key | scope | in config hash | detail |
|---|---|---|---|
| `browser` | top level | yes (semantic fields) | [The browser pin](browser-modes.md#the-browser-pin) |
| `states.<name>.route` | state | yes | [Routes and serving](#routes-and-serving) |
| `states.<name>.comp` | state | yes | `<comp-name>#<screen-id>` from the import manifest |
| `states.<name>.compTarget` | state | yes | [Unlabelled exports](setup-and-import.md#unlabelled-exports-no-data-screen-label) |
| `states.<name>.viewport` | state | yes | gated for unclipped states — [The provenance gate](provenance-gate.md#the-provenance-gate) |
| `states.<name>.clip` | state | yes | frames one element instead of the viewport |
| `states.<name>.readiness` | state | yes (policy/timeout/settle) | [Readiness](#readiness) |
| `states.<name>.threshold` | state | no | [Thresholds, units, and the noise floor](compare-results.md#thresholds-units-and-the-noise-floor) |
| `states.<name>.sections` | state | no | fractional rects scored separately beside the frame |
| `states.<name>.compDrive` / `.drive` | state | yes | [compDrive and drive](#compdrive-and-drive) |
| `states.<name>.selfCheck` | state | no | [selfCheck](#selfcheck) |
| `masks` / `states.<name>.masks` | top level, state | no | [Masks](#masks) |
| `capture` | top level | yes | [Capture fixtures](#capture-fixtures) |

`comp` is `<comp-name>#<screen-id>` from the import manifest
(`.visual-diff/references/manifest.json`). States without `comp` are
capture-only.

## Routes and serving

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

## Readiness

`readiness.selector` (optional) is the **implementation-side** readiness
signal: capture waits for it to become visible after the policy wait, and a
selector that never appears fails the capture loudly (exit 3) naming it —
a frame of the wrong state is worse than no frame. `readiness.compSelector`
is the comp-side equivalent, consumed by import's driven render (FR-37).
The two are side-bound by design: never point `selector` at comp markup.

## compDrive and drive

`compDrive` (reference side, FR-37) and `drive` (implementation side,
FR-39) put a page into a runtime state before its screenshot. **One
grammar, one validator, one error vocabulary** — the only difference is
which page each drives. The five step forms are the whole grammar:

```json
[
  { "click": "[data-menu-button]" },
  { "hover": ".row" },
  { "focus": ".field" },
  { "press": { "selector": ".field", "key": "Enter" } },
  { "mouse": "away" }
]
```

Each step waits for its target to become **visible**, acts, then settles.
`{ mouse: "away" }` parks the pointer outside the viewport (it clears
`:hover` where a full-viewport click-catcher keeps it set). A target that
never appears fails the run loudly (exit 3) naming
the step index, action, and selector — a screenshot of the wrong state is
worse than no screenshot.

Ordering on the capture side mirrors the comp side, settle for settle:
`route.setupScript` (page setup) → readiness policy wait → settle →
`drive` → `readiness.selector` → settle → screenshot, against the comp's
policy wait → settle → `compDrive` → `readiness.compSelector` → settle →
screenshot. Both sides therefore sample after the same number of settle
intervals for the same drive list — sampling a timer-driven UI at
different moments on the two sides would be a false pair no hash catches.
`drive` and `setupScript` coexist; `setupScript` is
arbitrary JS for seeding a page that has not reached readiness, `drive` is
declarative, validated interaction with a settled UI.

Both keys are **semantic configuration**: they enter the config hash, so
changing or reordering steps invalidates that state's pair through the
provenance gate (re-import with `--refresh` / re-capture). The steps a
capture executed are recorded in its provenance as `inputs.drive`.
`compDrive` requires an explicit `<comp>#<screen>` mapping (it drives a
reference surface) — or, for an unlabelled comp, a `compTarget` selector
([Unlabelled exports](setup-and-import.md#unlabelled-exports-no-data-screen-label));
`drive` requires nothing — a capture-only state may
drive freely.

## Masks

`masks` (FR-36) exclude **deliberate** divergences from scoring: named
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
— for device bezels a rectangle cannot express. Radius measurement supports
plain computed `px` and `%` components (horizontal percentages use the border
box width, vertical percentages its height). A computed `calc()` or other
unsupported component fails capture/import with a typed exit-3 error; it is
never treated as a zero-radius rectangular ring. A top-level `masks` block
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

`data-vd-mask` (comp-authored masks) let the **comp author** mark regions
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
space. A config mask of the same name wins — your explicit
declaration overrides the comp author's annotation. References imported
before this feature carry no `compAuthoredMasks`; the next re-import
re-probes the annotations and rewrites the record (pixels untouched), no
`--refresh` needed.

## selfCheck

`selfCheck` (optional, per state) bounds the FR-17 determinism re-capture:
by default the two captures must be byte-identical (any difference is exit
4); a state with a known-nondeterministic element (the blinking-caret
class) may declare `maxDiffPixels`, and a pixel difference within budget is
accepted and recorded in the capture's provenance instead of failing. A
dimension change fails regardless. Pair the budget with an anchored mask
on the caret element so the declared nondeterminism stays out of the
scored diff too.

## Capture fixtures

`capture` (optional, top level) injects capture-time fixtures so projects
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
