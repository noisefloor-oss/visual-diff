# `noise visual-diff` — design specification

The normative requirements index for this tool. Source comments and tests
cite these identifiers (FR-nn, NFR-nn, DESIGN §n); behavior that carries one
is contract, not accident.

## 1. Purpose

The operator loop — design a UI in Claude Design, export the handoff zip,
have an agent implement it, then hill-climb screenshot diffs until the
implementation matches within a threshold — tends to be re-invented per
project, as a one-off comparator that hard-codes one design's geometry and
dies with it. `noise visual-diff` captures the loop as a
generic micro tool in the `noise` CLI suite: it imports design comps into
canonical reference renders, captures the implementation deterministically,
and reports a stable, section-level mismatch metric with threshold-gated
exit codes. The tool measures; the agent climbs.

## 2. Scope

In scope: the four verbs (`import`, `capture`, `compare`, `report`), two
browser modes (browser service, native discovery), project-local artifacts,
noise-suite plugin packaging. The suite-convention `version` meta command
(`noise visual-diff version` → `noise-visual-diff <semver>`, also `--version`)
is in scope; deployment gates compare its output verbatim against a pinned
`noise-visual-diff <semver>`.

Out of scope (non-goals): baseline-approval workflows, CI services,
dashboards, automatic hill-climbing, agent-protocol integration, MCP
servers, any hard-coded knowledge of a specific design or project
(including this suite's).

## 3. Definitions

- **Comp**: one `.dc.html` file in a Claude Design export.
- **Screen**: one `[data-screen-label="NN Name"]` element inside a comp; a
  comp holds 1–13 screens. Static screens are `<figure>` elements directly
  under `<body>`; dynamic screens may use any element directly under `<x-dc>`.
  Addressed `<comp>#<screen-label>`, sanitized to `[a-z0-9-]`; a driven-state
  reference (FR-37) adds one `@<state-name>` suffix, the state-name grammar
  `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`.
- **Reference**: the canonical render of a comp screen, produced by `import`.
- **Capture**: a deterministic screenshot of an implementation state.
- **State**: a named entry in `visual-diff.json` mapping a route/URL to a
  comp screen, viewport, readiness policy, threshold, and sections.
- **Provenance**: the immutable record of renderer identity and inputs for a
  reference or capture (browser build, client version, mode, viewport, DPR,
  policy, font list, config hash, content hash, vendored-dependency hashes).
- **Noise floor**: the measured mismatch between two independent renders of
  the same comp screen; the representational lower bound for any diff.
- **Mask**: a named region declared on a state whose pixels are
  excluded from mismatch scoring (numerator and denominator) in every unit
  that covers them; recorded in the report so exclusion is never silent.
  The region is a fractional rect, or (v0.6.0) an element anchor resolved
  at render time (`selector`/`compSelector`, `shape` box or ring).

## 4. Functional requirements

### 4.1 Host and standalone contract

- **FR-1** The tool is a single executable installable as
  `<libexec-root>/noise-visual-diff` and dispatchable as `noise visual-diff`
  per the `noise` suite host contract; it also runs standalone with
  identical behavior.
- **FR-2** It honors `NOISE_PROJECT_DIR` when launched through the host
  (exactly one value, inherited wins); otherwise the project root is the
  canonical CWD.
- **FR-3** Exit codes: 0 pass, 1 over threshold, 2 usage error,
  3 provenance/trust failure, 4 determinism self-check failure.
- **FR-4** Every read command supports `--json`; JSON output is stable and
  documented.

### 4.2 `import`

- **FR-5** `import <design-export.zip>` extracts the archive safely:
  path-traversal and symlink entries rejected, fixed decompressed byte and
  file-count limits, atomic extraction via staging directory + rename.
- **FR-6** It discovers every `.dc.html` comp in the archive, derives a
  sanitized comp name from the relative path, and resolves collisions
  deterministically. `--only <comp>...` restricts the import.
- **FR-7** It preserves the extracted project tree and serves it as a
  directory at render time (comps reference `_ds/`, `assets/`, `support.js`
  relatively); it validates every `<helmet>` `ext-resource-dependency`
  declaration resolves to an existing file before rendering.
- **FR-8** It discovers external runtime dependencies by rendering each comp
  under network isolation with aborted requests logged — using the FR-16
  hydration-aware readiness policy, since the dc-runtime hydrates `<x-dc>`
  after load — then fetches each external once at import time, verifies its declared SRI hash when present,
  and stores it in `.visual-diff/vendor/`. Vendor content hashes enter
  provenance. (Verified motivation: the dc-runtime injects React/ReactDOM/
  Babel from a CDN at hydration time with SRI hashes.)
- **FR-9** Every render — import and capture alike — runs with network
  isolation: `data:`/`blob:` schemes pass (they never touch the network),
  vendored URLs are fulfilled locally, all other non-loopback requests are
  aborted and logged. A render hitting a live external origin is a
  provenance defect.
- **FR-10** It enumerates each comp's screens via `[data-screen-label]` using
  the supported static (`<figure>` directly under `<body>`) and dynamic (any
  element directly under `<x-dc>`) shapes, then renders each screen frame as
  one reference PNG per screen. A static figure's caption row is excluded;
  caption-free dynamic elements use their whole frame.
- **FR-11** It renders each screen twice and records the disagreement as the
  measured noise floor in the reference manifest.
- **FR-12** Re-importing a zip revision replaces exactly the comps whose
  content hash changed; `--refresh` re-renders references (e.g. after a
  legitimate renderer change) with new provenance.

### 4.3 `capture`

- **FR-13** `capture [--state <name>...]` captures each state's route as a
  PNG under a new run-id, with a per-capture provenance record. Every
  capture — including verification re-captures — runs under the FR-9
  network-isolation machinery (interception, vendor fulfillment, abort
  logging); the capture verb depends on that machinery, not on a parallel
  implementation.
- **FR-14** Determinism stack: fixed viewport per state (default 1502×818;
  `full-page` mode for scrolling content), `deviceScaleFactor: 2`, frozen
  `Date.now`, anti-animation stylesheet, `document.fonts.ready` plus settle
  delay.
- **FR-15** Every state and every verification re-capture runs in a fresh
  browser context (never a re-navigated page).
- **FR-16** Readiness is declared per state: `networkidle`, or
  `domcontentloaded` + settle, with a configurable timeout after which the
  harness proceeds and records which path fired. Comp rendering always waits
  for dc-runtime hydration (`<x-dc>` replaced) before fonts + settle.
  Readiness may declare two optional, side-bound selectors: `selector`
  (implementation side — waited visible by `capture` after the policy wait
  and before settle) and `compSelector` (comp side — waited visible by
  `import`'s driven render after its FR-37 steps). A selector that never
  appears fails the render loudly (exit 3) naming it — proceeding would
  record a frame of the wrong state. Provenance records each declared
  selector and whether it fired (`selectorFired` / `compSelectorFired`,
  separate from `pathFired`, which keeps meaning the readiness-policy
  path); the FR-23 readiness predicate compares only `policy`, `timeout`,
  and `settle` (selectors are side-bound state-driving semantics, gated by
  `configHash` instead — with one refinement: `compSelector` drives only
  import's FR-37 driven render, so on a state without `compDrive` it is
  inert and excluded from `configHash`);
- **FR-17** Self-verification: every state is re-captured from a fresh
  context and must be pixel-identical to the first capture; any difference
  fails the run with exit 4 — unless the state declares
  `selfCheck.maxDiffPixels` (v0.6.0), in which case a pixel difference
  within the declared budget is accepted and recorded in the capture's
  provenance (`inputs.selfCheck`), and only an over-budget difference or a
  dimension change fails exit 4. Absent `selfCheck` ≡ byte-exact.
- **FR-18** Runs publish atomically: a run stages capture, comparison, and
  report artifacts under a new run-id directory, and `current-run` updates
  only after *all* run artifacts — including `report.json` — are complete,
  so an interrupted run never becomes "latest" and a published run is always
  consumable in full.

### 4.4 `compare` and `report`

- **FR-19** `compare` pixel-diffs each captured state against its reference
  with defined sensitivity options, mismatch denominator, alpha handling,
  and dimension-mismatch policy; it writes a diff-heatmap PNG per state.
  Sensitivity options are pinned contract (pixelmatch `threshold` 0.02 YIQ,
  `includeAA: false`, `alpha` 0.1, `checkerboard` blending): the metric must register
  low-luminance surface differences; a pair differing by a missing ~47%
  dark panel scores at least 0.40, and below 0.20 is a defect.
- **FR-20** It reports per-state and per-section mismatch percentages;
  sections are fractional regions of the reference frame named in config,
  scaled by the capture geometry ratio. `--section` scopes both reporting
  and exit-code evaluation. Screens may serve as pre-defined regions. It
  also emits an automatic diagnostic region rollup — 16px full-width row
  bands and full-height column bands, hottest bands reported per axis —
  which never changes the verdict.
- **FR-21** Thresholds are per state and per section, overridable with
  `--threshold`; exit 0/1 reflects threshold evaluation (scoped by
  `--state`/`--section` when given). `compare` accepts `--state`,
  `--section`, `--threshold`, `--force`, and `--json`.
- **FR-22** `compare` refuses a threshold below the measured noise floor
  unless `--force` is passed.
- **FR-23** `compare` fails closed (exit 3) on incompatible provenance via a
  **field-wise** predicate: renderer build, client version, mode,
  viewport/DPR, capture policy, config hash, and vendor hashes must each
  match. A content hash identity-protects its own artifact against its
  manifest; reference and capture content hashes are *expected to differ*
  and are never cross-compared.
- **FR-24** `report [--json]` prints the latest published run: per-state and
  per-section scores, thresholds, verdicts, and provenance summary. With no
  published run it prints an empty-state report and exits 0 — a missing run
  is operational state, not a usage error. Each per-state entry records the
  config-declared `configThreshold` alongside the effective threshold and
  any override.

### 4.5 Browser resolution (two modes)

- **FR-25** Service mode: when `NOISE_BROWSER_WS` is set, the tool connects
  to that Playwright browser service with the version-pinned client (asserted at
  startup). A set-but-refused variable exits 3 with a diagnostic; the tool
  never falls through to native mode in this case.
- **FR-26** Native mode resolves a browser explicitly. With
  `--auto-discover-browser` (FR-33), the tool probes a discovery ladder and
  uses the first working rung: (1) pinned client + managed browser cache
  (resolved to the concrete headless-shell executable), (2) pinned client +
  system browser channel or well-known executable, (3) `agent-browser` CLI
  install (distinct provenance backend tag). Without the flag, the tool
  uses the browser pin recorded in the project config (FR-34); with no pin
  it exits 3 naming the remedy, without probing. Every probe is logged.
- **FR-27** Every candidate is launch-verified (launch + close); file
  presence alone never counts.
- **FR-28** With no working rung, the tool exits 3 with a full probe report:
  locations checked, verbatim launch errors (including missing-library
  output), and the exact command that fixes the highest-preference rung. It
  never auto-downloads browsers or installs system packages during
  `import`/`capture`/`compare`.
- **FR-29** `--browser <ws|native>` overrides mode selection for one run;
  the override is recorded in provenance.
- **FR-33** `import` and `capture` accept `--auto-discover-browser`:
  walk the FR-26 ladder, launch-verify, and atomically persist the accepted
  rung as the project pin — a `browser` block in `visual-diff.json`
  carrying the ladder backend tag (`playwright-managed` | `system` |
  `agent-browser`), rung, locator (tagged union: exactly one of
  `executablePath` | `channel`), `browserRevision` (rung 1; null
  otherwise), and `discoveredAt`. Effective mode resolves `--browser`
  first, then `NOISE_BROWSER_WS`, then native; discovery with effective
  mode `ws` is a usage error (exit 2). A failed ladder writes nothing and
  leaves any existing config byte-identical; re-pinning preserves
  operator-authored states semantically. Discovery verifies, pins, and
  reuses the same concrete executable (rung 1 pins the resolved
  headless-shell path, never the client-default full-chromium entry).
- **FR-34** With a pin present and no `--auto-discover-browser`, the verb
  launches exactly the pinned locator (launch-verified per FR-27, logged).
  A pin that refuses to launch exits 3 with a probe report scoped to the
  pinned locator and the re-discovery remedy — never a silent ladder
  re-walk. Hand-written pins are honored identically. `compare`/`report`
  launch no browser and never resolve the pin.
- **FR-35** The config contract admits the `browser` block and validates it
  (tagged union, backend/rung coherence, absolute `executablePath`);
  malformed configuration is invalid wherever config is loaded, in any
  mode. `states` may be empty — the no-states usage error moves to
  `capture`/`compare`. `configHash` hashes the semantic pin fields
  (`backend`, `rung`, `locator`, `browserRevision`) and excludes
  `discoveredAt`, so locator/rung drift trips the FR-23 gate while
  re-discovery of an identical browser never churns. **Breaking change:**
  existing native-mode projects (no pin) exit 3 until migrated once with
  `--auto-discover-browser` plus `import --refresh`.

### 4.6 Artifacts and configuration

- **FR-30** All artifacts live under `<project>/.visual-diff/`:
  `visual-diff.json`, `references/<comp>.png` + provenance (driven-state
  references: `references/<comp>#<screen>@<state>.png` + provenance),
  `captures/<run-id>/`, `diffs/<run-id>/` + `report.json`, `vendor/`,
  `current-run`.
- **FR-37** A state mapped to a comp screen may declare `compDrive`: an
  ordered list of `{ click: selector }` / `{ hover: selector }` steps that
  `import` executes against the rendered comp — after hydration readiness,
  each step waiting for its target, before the reference screenshot — to
  produce a driven reference for a surface that exists only as runtime state
  (menus, dialogs, popovers, hovers). Driven references are double-rendered
  with their own measured noise floor, named `<screen>@<state>` in the
  manifest (`driven: true`, excluded from whole-comp resolution), resolved
  by `compare` under that id, rendered under `--refresh` (config changes do
  not alter the comp content hash), and pruned when the state disappears.
  `compDrive` is reference-side only (capture drives the implementation via
  `route.params`/`setupScript`) and is semantic configuration: it enters
  `configHash`. A capture-only state may not declare it.
- **FR-31** `visual-diff.json` maps each state to: route (URL, or static
  directory to serve on loopback, with optional URL params or setup script),
  comp/screen mapping (optional — a state may be capture-only), viewport or
  full-page, readiness policy, threshold, and named sections. Multiple
  states may share one comp.
- **FR-32** The tool opens only the URLs the config names; captures,
  renders, and diffs never leave the project directory.
- **FR-36** A state may declare `masks`: named regions excluded
  from the mismatch numerator and denominator of every scoring unit that
  covers them (frame, sections, region rollup). Two forms (v0.6.0):
  **fractional rects** (`x`/`y`/`width`/`height` — the fallback for subjects
  with no stable element) and **anchored masks** (`selector` +
  optional `compSelector` and `shape`), which name the excluded element and
  resolve to pixel geometry at capture/import render time, recorded in each
  side's provenance (`inputs.masks`); `shape: "ring"` masks the element's
  border band for device bezels, corners following the element's computed
  elliptical radii (`{ rx, ry }` per corner, percentages resolved at probe
  time). A top-level
  `masks` block declares masks shared by every state (state-local same-name
  overrides). Anchors must resolve to exactly one **visible** element at
  render time (exit 3 otherwise); only pixels masked on **both** sides of the
  1:1 compared area are excluded — a pixel masked on one side only still
  compares normally. An anchored mask whose resolution is missing or stale in
  provenance fails closed (exit 2) naming the remedy; staleness includes a
  recorded `selector`/`compSelector`/`shape` that no longer matches the
  config (masks never enter `configHash`, so the record is the only witness).
  Masks are **compare-time
  configuration: they never enter `configHash`** — they influence no
  rendered pixel, so editing a mask invalidates neither references nor
  captures (the same exclusion applies to `sections` and `thresholds`;
  *breaking change*, v0.5.0: hash semantics changed, existing projects
  re-align once via `import --refresh` + `capture`). The report records
  each mask's name, rect, and excluded pixel count, and — when a previous
  report for the state exists — the previous excluded count with a
  `maskDrift` flag when it changed by more than 25% (diagnostic warning,
  never verdict-changing). A mask whose rect excludes 0 pixels over the
  compared area is an error (exit 2): it covers nothing. Masking is
  visible, never silent.

## 5. Non-functional requirements

- **NFR-1 (determinism)** Two captures of the same state in one run are
  byte-identical (verified 2026-08-11: 0 differing bytes
  at 786×1774 DPR-2). Any regression is exit 4, not a warning.
- **NFR-2 (trust)** Imported zips, comp HTML, and CDN dependencies are
  untrusted input; the FR-5/FR-8/FR-9 boundaries are enforced mechanically.
- **NFR-3 (suite conformance)** Plugin contract per the `noise` suite host;
  distribution is one single-file executable (Node SEA or equivalent); the
  repo carries a contract test that dispatches the published entry through
  the real `noise` host. Release assembly: this repo ships a staged payload +
  manifest; the suite release process assembles the complete plugin root — all plugins together — into
  one immutable versioned tree published atomically through `noise-setup`.
  An independently released repo never writes into the live libexec root.
- **NFR-4 (dependencies)** Runtime dependencies limited to `playwright`
  (exact pin), `pngjs`, `pixelmatch`. Build-time-only devDependencies
  (exact-pinned; e.g. `esbuild` and `postject` for the SEA packaging step)
  are permitted outside this list: they never enter the shipped closure —
  the SEA blob carries only the NFR-4 runtime set.
- **NFR-5 (harness neutrality)** Drivable identically from any agent CLI:
  plain flags, `--json`, meaningful exit codes; no agent-specific protocol.
- **NFR-6 (process)** MIT-licensed; developed privately with
  Conventional-Commit squash PRs, a cross-model review gate, and CI running
  build/lint/test gates green at merge. Public releases are curated
  snapshots.
- **NFR-7 (performance)** A 10-state capture+compare run completes in under
  5 minutes on the reference environment.

## 6. Open items

- Node SEA feasibility with playwright — **resolved green** by a spike:
  SEA + asset materialization works with the pinned client; packaging
  proceeds on that strategy.
- Screen structure — **resolved**: real exports use both static
  `<body> > figure[data-screen-label]` stacks and dynamic
  `<x-dc> > [data-screen-label]` templates. Both direct-child shapes are
  supported; deeper or otherwise unrecognized nesting fails clearly.
- Anchor-based sections (find element, then crop) — documented follow-up,
  not v1.
- Selector-anchored masks (mask names an element per side; the bounding box
  is resolved at capture/import render time and recorded in per-side
  provenance) — **shipped in 0.6.0** (FR-36), motivated by field use:
  fractional masks drift silently when layout changes; anchoring removes
  the failure mode.

## 7. Rejected approaches

These were considered and rejected during design consensus; they must not
reappear as tasks or "fallbacks":

- **esbuild bundle + `.mjs` shebang as the distribution format.** esbuild
  bundles JS to JS — it does not produce an executable, and the host
  dispatches libexec entries via `exec` with no interpreter guarantee;
  ambient `node` contradicts the pinned-runtime doctrine. Only a genuine
  single-file executable (Node SEA or equivalent) is sanctioned.
- **Allowlisting the CDN at render time** instead of vendoring. Provenance
  would depend on a live third party's availability and content.
- **Hard-coding design geometry in code.** Retired-comparator failure mode;
  geometry is versioned config data, never source.
- **Falling back to a different browser when `NOISE_BROWSER_WS` is set
  but refused.** Set-but-dead means the deployment is broken; silently
  switching renderers poisons provenance.
- **Cross-comparing reference and capture content hashes** in the FR-23
  predicate (see FR-23 — they are expected to differ).
