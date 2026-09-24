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
stable exit codes, a stable error code on the first line of every failure
report, `--json` on read verbs, deterministic artifact layout, no
interactive prompts, no hidden state outside `.visual-diff/`.

It is designed to be driven by an agent, not a human: the agent reads exit
codes and JSON, edits code between rounds, and archives per-round artifacts
as visual proof (implemented vs reference) for a PR.

## The whole loop in five commands

```sh
noise visual-diff import --auto-discover-browser design-export.zip  # 1. references
# 2. author .visual-diff/visual-diff.json (one state per screen)
noise visual-diff import --refresh design-export.zip                # 3. re-align
noise visual-diff capture                                           # 4. stage a run
noise visual-diff compare --threshold 2 --json                      # 5. verdict
```

Install: download the single-file binary for your platform from the GitHub
release, or run from a checkout — see [Install and run](#install-and-run).
A browser is always required and is never bundled; see
[Browser modes](#browser-modes--two-no-silent-fallback).

Each step is explained under [Setup and import](#setup-and-import) and
[The hill-climb round](#the-hill-climb-round); the
[task map](#task-map) below routes any other question.

The CLI is self-documenting: `noise visual-diff help` (or `--help`) prints
the full flag/exit-code/env-var/artifact reference to stdout, and
`noise visual-diff help <verb>` prints per-verb detail. Both exit 0 and are
safe to call in any directory. This README remains the prose documentation
(config schema, report.json fields, playbooks); the help text is the terse
scripting reference.

## Task map

| I want to … | section |
|---|---|
| set up a project for the first time | [One-time setup](#one-time-setup) |
| import a multi-screen SPA export, or understand why screens were skipped | [Multi-screen SPA exports](#multi-screen-spa-exports) |
| run a verification round and iterate | [The hill-climb round](#the-hill-climb-round) |
| drive a UI state (open a menu, select a tab) on the comp side, the implementation side, or both | [compDrive and drive](#compdrive-and-drive) |
| exclude a deliberate divergence — a clock, a device bezel — from scoring | [Masks](#masks) |
| parse the compare verdict, region rollup, or attribution | [compare --json](#compare---json) |
| reason about thresholds, noise floors, and units | [Thresholds, units, and the noise floor](#thresholds-units-and-the-noise-floor) |
| see what my last change actually moved | [Run-to-run diff](#run-to-run-diff) |
| write or change the config | [Project config](#project-config) |
| understand why a pass is trustworthy | [The provenance gate](#the-provenance-gate) |
| act on exit 1 (over threshold) | [Recovery playbook](#recovery-playbook) |
| act on exit 2 (usage / config error) | [Recovery playbook](#recovery-playbook) |
| act on exit 3 (trust failure: gate, browser, frame, drive) | [Recovery playbook](#recovery-playbook) |
| act on exit 4 (capture determinism self-check) | [Recovery playbook](#recovery-playbook) |
| look up the code the CLI printed on stderr, or work out what a failure message means | [Named errors](#named-errors) |
| choose or pin a browser, or fix browser resolution | [Browser modes](#browser-modes--two-no-silent-fallback) |
| find the artifacts and archive round proof for a PR | [Artifacts](#artifacts-the-pr-proof) |
| install the tool, or remove every trace of it | [Install and run](#install-and-run) |
| read the terse flag reference | `noise visual-diff help` |

## Setup and import

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

### Multi-screen SPA exports

Runtime-conditional screens. A real multi-screen SPA export is often **one
app shell**: every `data-screen-label` screen sits under a runtime
conditional (`sc-if`), and only the default screen (the one whose condition
holds undriven) renders at a visible size — the other screens exist only
after an interaction. Import handles this without modifying the export:

- The **first import** renders the visible screen's reference, **skips**
  each screen that renders empty undriven with a logged warning, and records
  it in the manifest as `{ "skipped": "empty-undriven" }` (no artifacts).
  The import succeeds as long as at least one screen produced a reference;
  every screen empty is a hard error.
- To reference a conditional screen, map it with a state that declares
  `compDrive` steps driving the comp into it (open the menu, click the tab),
  then `import --refresh`. The screen becomes **driven-only**: no base
  reference — the driven `@state` reference is the reference, its manifest
  entry records `drivenOnly: true`, and its noise floor is measured from the
  driven double render. Compare resolves it only through `compDrive` states;
  mapping it without `compDrive` fails loudly with the remedy named (see
  [Named errors](#named-errors) for both messages).

Concretely, for an export with one visible screen and six conditional ones:
import once (one reference, six warnings), read the manifest for the screen
ids, author one `compDrive` state per conditional screen you intend to
verify, and `import --refresh`.

The implementation usually has the same shape: an SPA where every screen is
a **nav click**, not a distinct URL. Drive both sides from the one state —
`compDrive` opens the surface on the comp, `drive` navigates to it in the
app, in the same language:

```json
"menu": {
  "route": { "staticDir": "impl" },
  "comp": "app#02-menu",
  "viewport": { "width": 1502, "height": 818, "fullPage": true },
  "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
  "threshold": 1,
  "compDrive": [{ "click": "[data-comp-menu-button]" }],
  "drive": [{ "click": "[data-menu-button]" }, { "mouse": "away" }]
}
```

Read that state as one unit: one state, one screen id
(`app#02-menu@menu`), both sides driven and both sides gated by the same
per-state config hash.

### Unlabelled exports (no `data-screen-label`)

Some valid Claude Design exports contain a **complete interactive app** in a
`.dc.html` file but no labelled screen elements at all. Import discovers
such a comp but has nothing to enumerate — earlier versions skipped it
(`comp … has no [data-screen-label] screens — skipping`) and, when it was
the only comp, failed with `import [no-comps]`. The comp is importable
through **explicit mappings** (FR-40): each state names the *whole* comp and
declares a `compTarget` selector whose element frame is the reference,
paired with a `clip` selector framing the corresponding element on the
implementation side. The tool never guesses which element is the screen —
a mapping without `compTarget` fails import with `comp-has-no-screens`,
and a `compTarget` on a comp that *has* labelled screens fails with
`comp-target-invalid` (map `<comp>#<screen>` instead).

```json
"states": {
  "home": {
    "route": { "staticDir": "dist" },
    "comp": "app",
    "compTarget": "#app",
    "clip": "#app",
    "viewport": { "width": 1502, "height": 818, "fullPage": true },
    "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
    "threshold": 1
  },
  "menu-open": {
    "route": { "staticDir": "dist" },
    "comp": "app",
    "compTarget": "#app",
    "clip": "#app",
    "viewport": { "width": 1502, "height": 818, "fullPage": true },
    "readiness": { "policy": "networkidle", "timeout": 10000, "settle": 250 },
    "threshold": 1,
    "compDrive": [{ "click": "#menu-button" }],
    "drive": [{ "click": "#menu-button" }]
  }
}
```

Each mapping state gets its **own state-scoped reference**
(`references/<comp>@<state>.png`), rendered under that state's readiness
and `compDrive` and double-rendered for its own measured noise floor —
exactly like a driven reference. There is no base reference, so **author
the config before the import that must see it** (or `import --refresh`
afterwards — a config change never alters the comp content hash, so an
incremental import skips the comp and compare fails with `no-reference`
naming the remedy):

```sh
# 1. author .visual-diff/visual-diff.json with the compTarget states
noise visual-diff import design-export.zip --auto-discover-browser   # omit the flag in service mode
noise visual-diff capture
noise visual-diff compare                # per-state thresholds from config
noise visual-diff compare --threshold 1  # enforce a 1% frame ceiling over config
```

The 1% ceiling above is the per-state `threshold: 1` in config (percent of
the frame's pixels; enforced per state and per section) — or a run-wide
override with `compare --threshold 1`. A threshold below the measured noise
floor is refused (exit 2) unless `--force`: two renders of the comp must
agree at least that well before the tool lets you demand it of the
implementation.

Notes and limits:

- Both targets are fail-loud: `compTarget` must resolve to exactly one
  visible element at import (`comp-target-missing`, exit 3), `clip` to
  exactly one at capture. Undriven reference renders await the `compTarget`
  element itself as the readiness witness, so an asynchronously hydrating
  app is measured when its frame target exists; driven renders await it
  after the `compDrive` steps.
- `compTarget` enters the config hash: retargeting it invalidates the
  state's pair through the provenance gate — `import --refresh` and
  re-capture.
- The reference renders at the shared default viewport (1502x818, DPR 2)
  and clips to the `compTarget` frame; because the state is clipped, the
  provenance gate compares readiness policy/timeout/settle but not the
  viewport (the documented clipped-state exemption). Keep the state
  viewport at the default unless the design is viewport-insensitive.
- Comp-authored `data-vd-mask` annotations do not apply (no screen element
  scopes them); config masks — fractional or `compSelector`-anchored —
  work unchanged.
- The zip and the comp HTML are never modified: references render from a
  throwaway extraction under `.visual-diff/imports/`.

## The hill-climb round

Repeat until compare exits 0:

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
development runs — copy it, don't reinvent it). Note what it does with each
exit code, and that it archives the run's artifacts before the next capture
can overwrite them:

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

### Operating rules

Learned from dogfooding:

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
  browser, DPR, readiness policy, vendored dependencies, and config (plus
  viewport, for unclipped states). If you find yourself
  wanting to bypass the gate, the correct move is `import --refresh`, never
  an edit to `.provenance.json`.

## Recovery playbook

What to do on each failure. Every failure surfaces as an exit code and a
report on stderr whose first line carries the failure's stable code
(FR-4a):

```
noise visual-diff <verb> [<code>]: <message>
```

The code sits **inside** the prefix, before the colon that introduces the
message, and every line of a report after the first is indented by the
renderer. Those two facts are what make the token trustworthy: the message
begins after `: `, and no line of it starts at column 0, so no message —
however worded, newlines included — can produce a line that parses as a
coded head.

Match the **anchored head**, never the bare token. There are two head
forms, and a lookup that only knows the first will miss whole families:

```
^noise visual-diff <verb> \[<code>\]:      # a verb reporting its own failure
^noise visual-diff \[<code>\]:             # no verb name — see below
```

Both are anchored at column 0 and end with the bracketed code plus the
colon-space that closes the prefix. A fixed-string search for
`[frame-truncated]` is not column-anchored, so it also hits that token
quoted inside a message body. Grep a head and the code is a reliable branch
key; grep the substring and it is not.

The verbless form covers two different situations, worth telling apart:

- **Dispatch refusals, by design.** The argument parser and the
  host-contract check run *before* any verb is chosen, so their failures
  cannot name one: every [invocation](#named-errors) code
  (`no-verb`, `unknown-verb`, `unknown-flag`, `flag-missing-value`,
  `flag-unexpected-value`, `bad-project-dir`) prints verbless at exit 2,
  followed by the usage block. `unknown-help-topic` uses the same verbless
  prefix deliberately. These are the normal shape for that family, not an
  escape.
- **Verb failures that escape their own catches** — described below — which
  print verbless at exit 3 with no usage block.

Three further shapes depart from the coded head, all deliberately:

- **A failure that carries no code** heads its report
  `<prefix>: <message>` — byte for byte the line it printed before codes
  existed. Only an unexpected internal failure lands here.
- **Browser resolution reports are deliberately multiline**: a coded first
  line, then a blank line, then the per-rung probe report and the fix
  command, every non-empty continuation line indented. Read the whole
  block.
- **A failure a verb does not handle falls through to the outer boundary**,
  which prints `noise visual-diff [<code>]: <message>` — the code, but no
  verb name — and exits 3, with no usage block (that is what separates it
  from a dispatch refusal). Which failures those are follows from each
  verb's catches, not from the error itself: import maps every typed error
  it can raise and so always keeps its prefix; capture and compare catch
  `ConfigError` at config load plus their own error types; report and
  verify-neutral catch `LayoutError` around the layout, `RunError` around
  the pointer, and `ReportError` around the report loaders. Everything else
  arrives verbless. Reachable today: `PATH_ESCAPE` from a `.visual-diff`
  symlink pointing outside the project (capture, compare, report, and
  verify-neutral all resolve artifact paths lazily, after those catches),
  `manifest-invalid` from compare (raised by the import module compare
  shares), and `RUN_INCOMPLETE` from compare's publish step. Each has a row
  below; the missing verb name is the only difference.

Two indexes over the same ground: by exit code, when all you have is the
status; by code and message text, when you have the report. **The names in
the first column of the tables below are the codes the CLI prints**, so the
fastest route from a failure to its row is to read the code out of the
head. The *stderr says* column stays useful for the same reason it always
was: it is the message text itself, so it tells you what the failure will
actually say and which values it names.

### By exit code

| exit | meaning | recovery |
|---|---|---|
| 1 | over threshold | normal loop iteration — parse `states.<name>.frame.mismatch`, look at `diffs/<run>/<state>.png`, fix the implementation, re-capture |
| 2 | usage | bad flags or broken config — read stderr, fix, re-run; never retried blindly. The config-shaped exit-2 failures are listed, with their messages, under [Named errors](#named-errors) |
| 2 (import locked) | another import holds the project lock | wait for it, or — if no import is running — the lock is stale from a killed run: remove the named `.visual-diff/import.lock` and re-run. A killed import cannot unwind itself, so its reference set may be left half-written under the previous manifest; `import --refresh` republishes the whole set |
| 3 (compare) | provenance gate | read the named fields in stderr. Almost always: config written/edited after import without `--refresh` → run `import --refresh`. Otherwise: renderer mismatch (imported and captured under different browsers/modes) → redo both in the same mode; or `inputs.effectiveViewport` (the reference's canvas was grown to fit its frame, FR-38, and the capture rendered under different effective conditions) → make both sides render under matching conditions (typically: let the implementation's document scroll, or clip the state so its element frames identically). See [The provenance gate](#the-provenance-gate) |
| 3 (frame) | the rendered frame could not be trusted | stderr says the clip was `clamped to the document scroll box`, that the frame `measured … after the viewport was grown`, or that a `double render … disagreed on the canvas accommodation` — see [Named errors](#named-errors) |
| 3 (drive or readiness) | a target never appeared, so the page never entered the state | stderr says a `drive step`, `compDrive step`, `readiness selector`, or `readiness compSelector` `never became visible within <t>ms` — fix the selector or raise `readiness.timeout`/`settle`; see [Named errors](#named-errors) |
| 3 (browser) | no working browser | native: no pin yet → run any import/capture once with `--auto-discover-browser`; stale pin (binary moved/upgraded) → re-run with `--auto-discover-browser` to re-pin. If every ladder rung fails, read the probe report on stderr and run the printed fix command. On a service host, check `NOISE_BROWSER_WS` is set and the browser service is up — it never falls back silently. See [Browser modes](#browser-modes--two-no-silent-fallback) |
| 4 | capture nondeterministic | discard and re-capture from a fresh context — transient load can cause this. If the SAME state fails repeatedly when the host is quiet, the page itself is nondeterministic: freeze clocks/animations, await webfonts, raise `readiness.settle`. A state with a known-nondeterministic element can declare a `selfCheck` budget instead |

### Named errors

Every row is read off its throw site: the verb that raises it, its exit
code, the distinctive part of the real stderr message (variable parts
elided) and the condition it fires under. The first column is the code the
CLI prints in the report head, so a failure is looked up by matching
`^noise visual-diff <verb> \[<code>\]: ` and reading the code out of it.
The table is maintained against the throw sites in the source, row by row;
a companion test enforces that correspondence mechanically — every code a
row, every row a real code (test/error-codes.test.mjs).

**invocation** — the argument parser refuses before any verb runs, so these
reach you from whichever verb you typed (and `no-verb` from none):

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `no-verb` | 2 | `missing verb` | no verb was given. Run `noise visual-diff help` |
| `unknown-verb` | 2 | `unknown verb: <verb>` | the verb does not exist. `help` lists them |
| `unknown-flag` | 2 | `unknown flag for <verb>: --<name>` | the flag is not accepted by that verb — flags are per-verb. `help <verb>` lists them |
| `flag-missing-value` | 2 | `flag --<name> requires a value` | a value flag was passed bare |
| `flag-unexpected-value` | 2 | `flag --<name> takes no value` | a boolean flag was given `=value` |
| `bad-project-dir` | 2 | `NOISE_PROJECT_DIR must be an absolute directory: <path>`, `NOISE_PROJECT_DIR does not exist: <path>`, `cannot resolve current directory: <path>`, or `is not a directory` | the project directory — `NOISE_PROJECT_DIR` when set, otherwise the working directory — is not an existing absolute directory |
| `unknown-help-topic` | 2 | `unknown help topic: <topic>` | `help <topic>` named something that is not a verb |

**every verb** — artifact-path guarding runs in import, capture, compare,
report, and verify-neutral alike. Config validation runs in the first three
only: `report` and `verify-neutral` deliberately never load the config, so
neither can fail on a malformed config or a browser flag:

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `CONFIG_ERROR` (not report) | 2 | a message naming the offending config path and reason, e.g. `comp must contain at most one "#" (got <n>)` | `.visual-diff/visual-diff.json` is missing a required key, malformed, or holds a value the schema refuses. Raised by import, capture, and compare — never by report. See [Project config](#project-config) |
| `LAYOUT_ERROR` | 2 | `project directory does not exist: <dir>`, or `invalid <what>: "<value>" (must match <re>)` | the project directory or an artifact name (run id, state, comp, screen) does not satisfy the FR-30 grammar. Run the verb from the project root, and keep state/comp names within `[a-z0-9-]` |
| `PATH_ESCAPE` | 3 | `path escapes the project directory: <parts>`, or `path component is a symlink resolving outside the project: <path> -> <target>` | an artifact path, or a symlink on its way, leaves the project directory — typically `.visual-diff/` (or a directory inside it) symlinked elsewhere. Nothing is written. Remove the symlink, or fix the name that composed the path. Artifact paths resolve lazily, so in capture, compare, and report this arrives **without** the verb prefix; import maps it itself |
| `PROVENANCE_SCHEMA` | 3 | `unsupported provenance schema version <v> (supported: <v>)`, or a message naming the malformed record field | a `.provenance.json` was written by an incompatible version or hand-edited. Re-import / re-capture the artifact rather than repairing the record |
| `PROVENANCE_TAMPER` | 3 | `artifact content hash mismatch: record says <hash>, artifact computes <hash>` | a PNG and its record disagree — the artifact or the record changed after it was written. Re-import / re-capture. (Compare re-labels its own copy of this check as `provenance-tamper`) |
| `PROVENANCE_ARGUMENT` | 2 | a message naming the invalid argument, e.g. `artifact path must be relative to the project directory` | an internal misuse of the provenance API — it should never reach an operator; if it does, it is a bug worth reporting |

**import and capture** — the two verbs that launch a browser and render.
Compare never resolves a browser (it reads artifacts), so none of these can
come from it:

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `NO_BROWSER_PIN` | 3 | `no browser pinned — re-run with --auto-discover-browser, or set browser in .visual-diff/visual-diff.json` | native host, no pin in the config and no discovery flag. Zero probes are run — the ladder never walks implicitly |
| `PIN_LAUNCH_REFUSED` | 3 | `pinned browser refused launch (rung <n> <backend>): …`, then `A stale pin never silently re-walks the discovery ladder` and `re-run with --auto-discover-browser to re-discover and re-pin` | the pinned binary moved, was upgraded, or lost a shared library. The probe report is scoped to the pinned locator; re-pin as the message says |
| `NO_NATIVE_RUNG` | 3 | `native browser resolution failed: no discovery rung produced a working browser`, followed by the per-rung probe report | `--auto-discover-browser` walked the whole ladder and every rung failed launch verification. Run the fix command the report prints |
| `SERVICE_NO_ENDPOINT`, `SERVICE_ENDPOINT_REFUSED`, `SERVICE_ENDPOINT_UNRESPONSIVE` | 3 | `--browser ws requested but NOISE_BROWSER_WS is not set`; `NOISE_BROWSER_WS is set (<ep>) but the service endpoint refused the connection`; `service endpoint <ep> connected but did not respond (browser.version() failed)` | service mode is selected but the endpoint is unset, dead, or wedged. Start/fix the browser service — it never falls back to a local browser |
| `CLIENT_VERSION_MISMATCH` | 3 | `playwright client version mismatch: expected <v> (pinned), got <v>` | the installed Playwright client is not the pinned version. Reinstall dependencies; the service's Playwright must match it too |
| `CONFIG_ERROR` (discovery) | 2 | `--auto-discover-browser is a native-mode act; discovery never applies in service mode (re-run without it, or pass --browser native to force native discovery)` | the discovery flag was passed on a host resolving to service mode. Drop the flag, or force `--browser native` |
| `NAVIGATION_FAILED` | 3 | `render navigation failed: <url>: <reason>` | the page never loaded — nothing is listening on that route, or it errored before load. Start the app (or use `capture --serve <distDir>`), check `route.url`/`route.staticDir`. A navigation *timeout* is not this: FR-16 proceeds and the readiness policy decides |
| `ENTRY_REDIRECT_REFUSED` | 3 | `render entry redirect refused: <url> redirected to <landing>` | the entry URL redirected to a different origin, path, or query. Isolation fails closed rather than screenshotting whatever answered. Point the route at the landing URL itself |
| `VENDOR_MANIFEST_INVALID` | 3 | `<vendor.json path>: <reason>` | `.visual-diff/vendor/vendor.json` is malformed. Clear the vendor directory and re-import so discovery rewrites it |

**import**

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `zip-traversal`, `zip-symlink`, `zip-limit` | 3 | `entry name traverses outside the staging directory: …`, `entry "…" is a symlink`, `archive has <n> file entries, exceeding the <n>-file limit` | the export tripped the extraction trust boundary (FR-5): a path that escapes the staging root, a symlink entry, or the byte/file budget. The zip is malformed or hostile — re-export it |
| `zip-input`, `zip-format`, `zip-unsupported`, `zip-integrity`, `zip-publish` | 2 | `cannot read zip file "<path>": …`; `not a zip archive: end-of-central-directory record not found`; `entry "…" is encrypted` / `zip64 archives are not supported`; `entry "…": stored entry size mismatch`; `staging target already exists: <dir>` | the archive is unreadable, truncated, encrypted, uses an unsupported feature, fails its own checksums, or a previous run left staging behind. Re-export the zip; for a stale staging directory, remove it and re-run |
| `no-zip` | 2 | `missing design-export.zip argument` | the verb was called with no positional argument |
| `too-many-args` | 2 | `expected exactly one design-export.zip argument (got <n>)` | import takes exactly one zip; comps are selected with `--only`, not with extra positionals |
| `comp-tree`, `comp-screen-structure`, `comp-missing-dependency` | 2 | `extracted tree root is not a directory: …`; `<file>: <tag data-screen-label> is nested inside another screen`; `<file>: declared dependency "…" does not exist in the extracted tree (searched from export root … — a wrong-directory-level zip is the usual cause)` | the export's structure is unsupported: unreadable tree, nested screens, or a `<helmet>` dependency that does not resolve inside the export. Re-export, or re-zip from the directory level the message names |
| `comp-not-found` | 2 | `no discovered comp named "<name>"` (every unknown name listed, sorted) | an `--only` value matches no comp in the export. This fires during discovery, **before** any filtering — a mistyped `--only` lands here, not in `no-comps`. Check the spelling against the comp file names |
| `comp-error` | 2 | any other export-structure message, verbatim | defensive fallback for an export-discovery failure that declares no code of its own. Treat it as the rows above |
| `no-comps` | 2 | `no .dc.html comps found in the export`, or `no discovered comp matches --only …` | nothing survived discovery: the zip holds no `.dc.html` comp at all, or — for the `--only` wording — every comp the flag named was dropped as screenless-and-unreferenced. An `--only` name that matches nothing never reaches here (`comp-not-found` fires first) |
| `comp-has-no-screens` | 2 | `declares no [data-screen-label] screens, but state(s) … map it as <comp>#<screen>`, or `declares no [data-screen-label] screens, but state(s) … map it without a compTarget` | a config state maps a comp whose markup has no screens at all. There are no labelled screens to name: map the **whole** comp and give each mapping state an explicit `compTarget` selector (paired with `clip`), or add screens to the comp — see [Unlabelled exports](#unlabelled-exports-no-data-screen-label). An *unreferenced* screenless comp is only a logged warning |
| `comp-target-invalid` | 2 | `state(s) … declare compTarget, but comp <name> (<file>) HAS [data-screen-label] screens` | `compTarget` frames an unlabelled comp only. The comp has real screens — map `<comp>#<screen>` instead and drop `compTarget` |
| `comp-target-missing` | 3 | `compTarget "<selector>" matched <n> elements — it must match exactly one`; `compTarget "<selector>" matched an element with no layout box (display:none or detached)`; `compTarget "<selector>" never became visible within <t>ms` | the explicit frame selector resolved to zero or several elements, a hidden element, or never appeared (post-drive, if the state drives). Fix the selector — the reference frame must be a stated fact. See [Unlabelled exports](#unlabelled-exports-no-data-screen-label) |
| `screen-missing` | 2 | `screen "<id>" not found in <comp file> after hydration` | the screen is in the comp's markup but absent from the hydrated DOM. The first render of a base screen triages absence instead (skip / driven-only), so this fires on a later render of the same screen — a driven render, the second pass, or a record repair — which makes a nondeterministic or drive-sensitive comp the usual cause. Fix or re-export the comp. It is not a config mistake: a `comp` value naming a screen the manifest does not hold fails in compare as `no-screen` |
| `empty-frame` (undriven) | 2 | `renders empty undriven, but state(s) "…" map it without compDrive` | a runtime-conditional screen is mapped by a state with no `compDrive`, so no undriven reference can exist for it. Give that state a `compDrive` that makes the screen visible (it becomes driven-only), or fix the comp so the screen renders undriven. See [Multi-screen SPA exports](#multi-screen-spa-exports) |
| `empty-frame` (driven render) | 2 | `has an empty frame (caption only?)` | a `compDrive` render measured a zero-size frame: the steps ran but did not put the comp into that screen. Fix the `compDrive` steps (or the selectors they target) |
| `empty-frame` (second pass) | 2 | the same `has an empty frame (caption only?)`, on a screen that rendered fine a moment earlier | only the FIRST render of a base screen tolerates an empty frame; pass 2 of 2 does not. A screen that was non-empty on pass 1 and empty on pass 2 has no `compDrive` to fix — the comp itself is nondeterministic (a timer, an animation, a late conditional). Re-run import; if it repeats, make the comp render the screen deterministically |
| `all-screens-empty` | 2 | `every screen of comp … renders empty undriven` | every screen of the comp sits behind a runtime condition, so it can produce no reference at all. Map at least one screen with a `compDrive` state (driven-only) and re-run import |
| `screen-dimension-mismatch` | 2 | `screens of one comp must share device dimensions` | two screens of one comp rendered at different sizes. If the difference is intentional, annotate that screen with `data-screen-variable-size` in the comp |
| `comp-mask-conflict` | 2 | `mask "…" is declared differently for <comp>#<screen>` | two states declare the same mask name for one screen with a different `compSelector` or `shape`; the screen's shared reference record cannot name both. Make them identical, or rename one |
| `drive-target-missing` | 3 | `compDrive step <i> (<action> "<selector>") never became visible within <t>ms — the comp cannot be driven into this state` | a `compDrive` step's target never appeared, so the comp never entered the state. Fix the selector, or raise `readiness.timeout`/`settle`. See [compDrive and drive](#compdrive-and-drive) |
| `comp-selector-missing` | 3 | `readiness compSelector "…" never became visible within <t>ms — refusing to record a reference of the wrong state` | the comp-side readiness selector never appeared. Fix `readiness.compSelector`, or raise the timeout. See [Readiness](#readiness) |
| `frame-unstable` | 3 | `measured <rect> at the declared viewport but <rect> after the viewport was grown to <w>x<h> to fit it`, or `disappeared after the viewport was grown` | the frame extended past the document canvas, the tool grew the viewport to fit it, and the re-measured frame changed — the comp reflows responsively with viewport size, so extending the canvas would change the very pixels being referenced. Fix the comp to a static frame (dimensions independent of viewport), or let the document itself scroll instead of an inner container, then re-import. Stderr names both measured rects (FR-38, [docs/DESIGN.md](docs/DESIGN.md)) |
| `frame-truncated` | 3 | `the render delivered <w>x<h> device px but the screen frame requires <w>x<h> — the screenshot clip was clamped to the document scroll box` | the browser clamped the requested frame to the document scroll box, so the delivered PNG is short. The tool grows the canvas automatically for the common inner-scroll case (`html,body` at `height:100%` with an `overflow:auto` region), so this is the residual failure: the grow could not bring the frame inside the document canvas. Let the document itself scroll, or size the scroll container to its content, then re-import. Provenance `inputs.frame` + `inputs.delivered` carry both dimensions (FR-38) |
| `canvas-divergent` | 3 | `double render of <comp>#<screen> disagreed on the canvas accommodation` | the two passes of the reference's double render made different structural decisions (one grew the viewport, the other did not, or they grew differently). That is a canvas race, not pixel jitter, so no noise floor may absorb it and the reference is refused. Re-run import on a quiet host; if it repeats, give the comp a static frame so no grow is needed |
| `comp-mask-missing` | 3 | `mask "…" compSelector "…" matched <n> elements (<m> visible) … it must match exactly one visible element` | an anchored mask's `compSelector` does not resolve to exactly one visible element in that screen. Retarget it. See [Masks](#masks) |
| `comp-mask-invalid` | 3 | `data-vd-mask="…" matched <n> elements (<m> visible)`, or `a data-vd-mask annotation … has an empty value` | a comp-authored annotation names zero or several visible elements, or carries an empty value. Fix the annotation in the comp. See [Masks](#masks) |
| `render-defect` | 3 | `aborted requests — unvendored external or isolation failure`, `aborted requests after load — … re-run import so discovery can vendor it`, or `isolation trust defect while discovering …` | the comp render reached for something the isolation layer refused. Re-run import so discovery vendors it, or drop the external reference from the comp |
| `vendor-fetch` | 3 | `failed to fetch external dependency <url>: <reason>`, `… : HTTP <status> <text>`, or `fetcher for <url> did not return a body Buffer` | vendoring could not download an external the comp declares — the host is offline or the URL is dead. Restore network access to that origin, or remove the external reference from the comp, then re-import |
| `sri-mismatch` | 3 | fresh fetch: `external dependency <url> failed its declared SRI hash: <integrity> — the CDN served different bytes than the runtime declares`; vendored copy: `declares SRI <integrity> but its vendored copy does not match — the vendored bytes are stale or tampered` | on a fresh fetch the origin served bytes the comp does not declare (fix or re-pin the declaration, or drop the dependency); on a vendored copy the cached bytes drifted — clear the vendor directory and re-import |
| `vendor-file-missing` | 3 | `declares SRI <integrity> but its vendored copy cannot be read: <file>` | the vendored file was deleted or is unreadable. Clear the vendor directory and re-import |
| `manifest-invalid` | 3 | `reference manifest is not valid JSON: <file>: …`, `… has an unsupported schema`, or `… entry for "<comp>" is malformed` | `.visual-diff/references/manifest.json` was hand-edited or written by an incompatible version, so import refuses to plan incrementally against it. Remove `.visual-diff/references/` and re-import from the zip — a full import rewrites the artifacts and the manifest together |
| `png-decode` | 3 | `not a PNG file (bad signature)`, `interlaced PNG is not supported`, or `cannot decode PNG: …` | import decodes its own renders to measure the noise floor, so this means the browser delivered a buffer that is not a usable PNG. Re-run import; if it repeats, re-pin the browser with `--auto-discover-browser` |
| `import-locked` | 2 | `another import is already running for this project (…) — concurrent imports of one project are refused, never merged` | a live or stale import lock. If no import is running, the lock is stale (a killed run cannot unwind itself): remove it and re-run; `--refresh` republishes a half-written reference set |
| `commit-incomplete` | 3 | `could not remove the stale reference <file> while publishing the reference set: … — the manifest was NOT republished` | a stale reference could not be unlinked inside the commit window, so the old manifest still describes the old set. Fix the filesystem problem and re-run with `--refresh` |
| `staged-cleanup` | 3 | `could not remove every staged reference file: … — no committed artifact was touched` | rollback after a failed import could not unlink a staged temp. The leftovers are unreferenced and the next import sweeps them |
| `lock-release` | 3 | `the import committed, but its lock could not be released: … — the leftover lock refuses later imports as import-locked` | the import finished but its lock file could not be removed. Remove the leftover lock and re-run |
| `sweep-failed` | 3 | `could not sweep every <family> an interrupted run left behind: … — the import stops here rather than claim a cleanup it did not perform` | the startup sweep of leftover temps hit an unlink failure. Remove the named leftovers by hand and re-run |
| `scratch-prune` | 3 | `the reference set was committed, but scratch left by earlier runs could not be removed: …` | the committed set is good; leftover temp bytes under `.visual-diff/imports/` need manual removal |

**capture**

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `drive-target-missing` | 3 | `drive step <i> (<action> "<selector>") never became visible within <t>ms — the implementation cannot be driven into this state; refusing to record a frame of the wrong state (FR-39)` | the implementation never entered the state. Fix the selector, or raise `readiness.timeout`/`settle`. See [compDrive and drive](#compdrive-and-drive) |
| `READINESS_SELECTOR_TIMEOUT` | 3 | `readiness selector "…" never became visible within <t>ms — refusing to record a frame of the wrong state (FR-16)` | `readiness.selector` never became visible. Fix the selector, or raise the timeout. See [Readiness](#readiness) |
| `MASK_SELECTOR_MATCH` | 3 | `mask "…" selector "…" matched <n> elements (<m> visible) — it must match exactly one visible element` | an anchored mask does not resolve to exactly one visible element on the capture page. Retarget it. See [Masks](#masks) |
| `unknown-state` | 2 | `unknown state(s): <names> (valid: <names>)` | `--state` named a state the config does not define. The valid list is printed |
| `no-states` | 2 | `no states defined — author .visual-diff/visual-diff.json` | the config has no `states` at all. See [One-time setup](#one-time-setup) |
| `CAPTURE_FAILED` | 3 | `state <name>: setupScript <path> must export an async default function (page) => Promise<void>`, or any other untyped capture failure verbatim | the class default, carried by capture failures that declare no more specific code — chiefly a `route.setupScript` module with no usable `default`/`setup` export. Anything the script itself throws is reported verbatim and lands in the same trust bucket: nothing is staged or published |
| `render-defect` | 3 | `aborted external font request(s) — the capture would record fallback glyphs, not the design's ground truth` | an external font was refused, so the capture would compare fallback glyphs. Re-run import so discovery vendors the font, or drop the external `@font-face` |
| `frame-unstable` | 3 | `clip "<selector>" framed <rect> at the declared viewport but <rect> after the viewport was grown to <w>x<h> to fit it` | the capture-side twin of the import row above: the page reflows under the grown viewport. Fix the page to a static frame, or let the document itself scroll, then re-capture |
| `frame-truncated` | 3 | `the clipped capture delivered <w>x<h> … but the clip rect requires <w>x<h> — the screenshot clip was clamped to the document scroll box` | the capture-side twin of the import row above. Let the document itself scroll, or size the scroll container to its content, then re-capture |
| `determinism-failed` | 4 | `determinism self-check FAILED for <state> (…) — re-capture from a fresh context differed (FR-17/NFR-1)`, plus `The capture is not trusted and the run is not published` | the two passes differed (or diverged on the canvas accommodation, which no `selfCheck` budget may absorb). Re-capture; if the same state fails on a quiet host the page is nondeterministic — see the exit-4 row above and [selfCheck](#selfcheck) |

**compare**

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `no-manifest` | 2 | `reference manifest not found at … — run import before compare` | nothing has been imported into this project yet |
| `unknown-state`, `no-states` | 2 | as in the capture rows above | compare refuses the same two selection mistakes, under its own verb name |
| `no-captured-run` | 2 | `no captured run to compare — run capture first` | nothing has been captured in this project yet |
| `bad-threshold`, `bad-run-id`, `no-section` | 2 | `--threshold must be between 0 and 100 (got <n>)` / `--threshold requires a numeric percentage`; `invalid run-id: "<id>"` (run selection) and `invalid run-id for diffing: "<id>" (must match <re>)` (`--against` / `report --diff` — the malformed-id case, distinct from `no-such-run` above); `state <name> has no section "<id>" (have: <ids>)` | flag values the verb refuses before doing any work. Each message states the constraint it enforces |
| `no-comp` | 2 | `state maps to comp "…" but no such comp has imported references` | the `comp` mapping's comp name has no imported references — a typo, or a comp left out by `--only`. Read `.visual-diff/references/manifest.json` for the imported names |
| `no-screen` | 2 | `comp <name> has no imported screen <id> (have: <ids>)`; for an unlabelled comp, `comp <name> has no [data-screen-label] screens (unlabelled export) — a <comp>#<screen> mapping cannot resolve` | the `comp` mapping names a screen id no manifest entry for that comp holds — a typo, or a screen added to the export since the last import (re-run import). Two subtleties in the `have:` list, which prints every entry the comp has: (1) skipped and driven-only **base** ids are in it and *are* addressable, so naming one resolves here and fails one step later as `screen-skipped` or `driven-only`; (2) driven `<id>@<state>` entries are printed but **cannot be named from the config** — `comp` values are sanitized to `[a-z0-9-]`, so `app#01-main@menu` is looked up as `01-main-menu` and lands right back here. Map the **base** id and give the state a `compDrive`; import and compare pair the `@state` reference for you. The unlabelled-comp wording means the comp has no screens at all: map the whole comp with a `compTarget` selector instead |
| `comp-target-missing` | 2 | `state <name> maps unlabelled comp <name> but declares no compTarget` | the config drifted from what import rendered: the comp's references are state-scoped and require the explicit `compTarget` selector. Restore it and `import --refresh` |
| `multi-screen` | 2 | `comp <name> has <n> screens — a whole-comp mapping must name one: …` | a whole-comp mapping is ambiguous. Name `<comp>#<screen>`. Only base screens count here — driven, driven-only, and skipped entries never resolve through a whole-comp mapping |
| `screen-skipped` | 2 | `but import skipped that screen (<reason>: it renders empty undriven and no state mapped it at import time)` | the id is in the manifest but has no artifacts: it rendered empty when it was imported and nothing drove it. Give the state a `compDrive` if it has none, then `import --refresh`. See [Multi-screen SPA exports](#multi-screen-spa-exports) |
| `driven-only` | 2 | `without compDrive, but that screen is driven-only (it renders empty undriven, so no undriven reference exists)` | the id is in the manifest as driven-only and this state has no `compDrive`, so there is no undriven reference to compare against. Declare a `compDrive` on the state. (This guard and `screen-skipped` test the `drivenOnly` and `skipped` flags only — a driven `<id>@<state>` entry would trip neither, and is kept out of reach by the sanitization noted under `no-screen`.) See [Multi-screen SPA exports](#multi-screen-spa-exports) |
| `no-reference` | 2 | `no reference PNG at reference <comp>#<screen> — run import before compare`; for a driven state the remedy reads `driven references render only under import --refresh (a config change does not alter the comp content hash)`; for an unlabelled comp, `maps unlabelled comp <name>, but the reference manifest holds no <comp>@<state> reference` | the manifest names the screen but its PNG is absent (or, for an unlabelled comp, no state-scoped reference was ever rendered for this state). Run the import the message names |
| `capture-only` | 2 | `state(s) … are capture-only (no comp mapping) and cannot be compared` | `--state` explicitly selected a state with no `comp`. Drop it from the selection, or give it a mapping |
| `no-comparable` | 2 | `no selected state maps to a comp — compare needs comp mappings (FR-31)` | nothing in the selection has a `comp` mapping |
| `no-such-run` | 2 | `no stored report for run "<id>" — looked for diffs/<id>/report.json (compare that run first)` | `--against` / `report --diff` named a well-formed run id whose `report.json` is absent. Compare that run first, or name one that has been compared. See [Run-to-run diff](#run-to-run-diff) |
| `threshold-below-noise-floor` | 2 | `threshold below the measured noise floor — pass --force to override: <state>: threshold <p>% < noise floor <p>%` | the threshold asks for more precision than two renders of the same screen agree on. Raise it above the floor, make the state deterministic, or pass `--force` if you accept the noise. See [Thresholds, units, and the noise floor](#thresholds-units-and-the-noise-floor) |
| `mask-covers-nothing` | 2 | `mask "…" excludes 0 pixels — its rect covers none of the compared area` | the mask measures nothing, so scoring would report a number with a mask that does nothing. Fix the rect/selector, or remove the mask. See [Masks](#masks) |
| `mask-anchor-unresolved` | 2 | `anchors to "…" but the capture's provenance carries no resolution for it — re-capture the state`, or `names compSelector "…" but the reference's provenance carries no resolution for it — re-import the comp` | the anchor was never resolved on that side (anchors resolve at capture time, comp anchors at import time). Do what the message says. See [Masks](#masks) |
| `mask-anchor-stale` | 2 | capture side: `was captured as shape "<recorded>" but config now says "<configured>" — re-capture the state`, or `was captured against selector "…" but config now anchors to "…" — re-capture the state`. Reference side (only for a mask that declares `compSelector`): `was imported as shape "<recorded>" but config now says "<configured>" — re-import the comp`, or `was imported against compSelector "…" but config now names "…" — re-import the comp` | an anchored mask was retargeted or reshaped after the artifacts were written, so the recorded geometry belongs to another element or shape. The capture side is checked **first** and the reference side only after it passes, so a **shape** change on a mask that declares `compSelector` fails twice in a row: do **both** — re-capture *and* re-import — before the next compare, or the reference check fires as soon as the capture check stops. A `selector`-only change needs the re-capture; a `compSelector`-only change needs the re-import. Masks never enter the config hash, so nothing else is invalidated. See [Masks](#masks) |
| `provenance-mismatch` | 3 | `provenance gate failed for state <name>: incompatible fields: <fields> — re-import references or re-capture under matching conditions` | the reference and the capture disagree on a gated field; stderr names them. Almost always `import --refresh`. See the exit-3 (compare) row above and [The provenance gate](#the-provenance-gate) |
| `capture-missing` | 3 | `capture artifact missing at <artifact label>`, or `run <id> holds no capture for the selected state(s) …` | the published run holds no capture for what you selected. Re-capture, or select states the run holds |
| `provenance-unreadable`, `provenance-tamper` | 3 | `<artifact> provenance cannot be trusted: …`, or `artifact content hash mismatch — the artifact or its record was tampered` | a record is unreadable, or does not match its PNG. Never repair a record by hand: re-import / re-capture |
| `png-decode` | 3 | `cannot decode PNG: …` | a reference or capture PNG cannot be decoded for comparison. Re-import / re-capture |
| `RUN_INCOMPLETE` | 3 | `run <id> is not complete (missing <artifacts>) — current-run was not updated` | the scoring finished but the run could not be published: an artifact of the staged set is missing. The previous published pointer is left untouched. Re-capture and compare again. Compare does not catch this one, so it prints **without** the verb prefix |

**verify-neutral** — the upgrade check: it re-compares the published run
with the binary you are holding and exits 0 only on zero numeric drift
(1 on drift, baseline restored either way). `help verify-neutral` covers
the verb.

Most of what it can report is not its own: reading the pointer and the
published report is the same work `report` does, so `LAYOUT_ERROR`
(the layout), `RUN_POINTER_INVALID` (the pointer) and every
`REPORT_JSON_*` failure (the baseline) reach you under the
`noise visual-diff verify-neutral` prefix, with the conditions and remedies
in the [every verb](#named-errors) and [report](#named-errors) rows above.
A `PATH_ESCAPE` behaves as it does everywhere else: artifact paths resolve
lazily, after the typed catches, so it arrives verbless. The two rows below
are the refusals that belong to this verb alone:

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `no-published-run` | 2 | `no published run — run capture and compare first; there is nothing to verify neutrality against` | nothing has been published in this project, so there is no baseline to reproduce |
| `recompare-refused` | 3 | `re-compare of run <id> refused (exit <n>) — the project no longer satisfies compare’s gates; the published baseline was restored untouched` | the re-compare could not run at all (a gate, not a drift): fix what compare reports, then verify again. The published run is restored before the verb returns |

**report** — the only verb that reads artifacts without a config. Its
failures are the published run's, not the project's:

| name | exit | stderr says | condition and remedy |
|---|---|---|---|
| `RUN_POINTER_INVALID` | 3 | `current-run names "<text>", which is not a valid run-id` | `.visual-diff/current-run` was hand-edited or written torn. Never repair it by hand — re-capture and compare, which republishes the pointer atomically |
| `REPORT_JSON_UNREADABLE` | 3 | `published run <id> has no readable report.json at diffs/<id>/report.json — the run is no longer fully consumable` | the published run's report is missing or unreadable, so the last verdict cannot be reported. Re-compare to republish it |
| `REPORT_JSON_INVALID` | 3 | `published run <id> has a corrupt report.json (not valid JSON): <reason>` | the file is corrupt or was hand-edited. Re-compare |
| `REPORT_JSON_SHAPE` | 3 | `published run <id> report.json is not an object`; `… has no states object`; `… has no valid exit field (expected 0 or 1, got <v>)`; `… state <name>: <what>` | the report parses but does not hold the shape the schema requires — including a per-state score field that is missing or non-numeric. Re-compare rather than editing it |
| `REPORT_JSON_MISMATCH` | 3 | `published run <id> report.json names run "<other>" — pointer and report disagree` | `current-run` and the report it points at name different runs. Re-compare; do not reconcile them by hand |
| `bad-diff-args` | 2 | `--diff requires exactly two run ids: report --diff <runIdA> <runIdB>` | `report --diff` takes the run id under the flag plus one positional |
| `no-such-run`, `bad-run-id` | 2 | as in the compare rows above | `report --diff` shares the run-diff loader with `compare --against`, and raises the same two failures under the report verb's name |

## Exit codes

The agent contract. The [recovery playbook](#recovery-playbook) above is the
actionable version; the exit codes themselves are stable API. They are a
five-value alphabet, so the *reason* rides on stderr beside them, as the
error code in the report head — branch on the exit code, then read the code
to know which failure inside that bucket you have:

- `0` — success (compare: under threshold)
- `1` — compare: over threshold
- `2` — usage error (bad flags, bad config, missing zip)
- `3` — trust failure (provenance gate, browser resolution, archive trust)
- `4` — capture determinism self-check failed

`capture` re-renders every state from a fresh context and byte-compares the
two passes before staging a run. A run that fails this self-check is
never staged and never disturbs the last compare verdict.

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

## Project config

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
| `browser` | top level | yes (semantic fields) | [The browser pin](#the-browser-pin) |
| `states.<name>.route` | state | yes | [Routes and serving](#routes-and-serving) |
| `states.<name>.comp` | state | yes | `<comp-name>#<screen-id>` from the import manifest |
| `states.<name>.compTarget` | state | yes | [Unlabelled exports](#unlabelled-exports-no-data-screen-label) |
| `states.<name>.viewport` | state | yes | gated for unclipped states — [The provenance gate](#the-provenance-gate) |
| `states.<name>.clip` | state | yes | frames one element instead of the viewport |
| `states.<name>.readiness` | state | yes (policy/timeout/settle) | [Readiness](#readiness) |
| `states.<name>.threshold` | state | no | [Thresholds, units, and the noise floor](#thresholds-units-and-the-noise-floor) |
| `states.<name>.sections` | state | no | fractional rects scored separately beside the frame |
| `states.<name>.compDrive` / `.drive` | state | yes | [compDrive and drive](#compdrive-and-drive) |
| `states.<name>.selfCheck` | state | no | [selfCheck](#selfcheck) |
| `masks` / `states.<name>.masks` | top level, state | no | [Masks](#masks) |
| `capture` | top level | yes | [Capture fixtures](#capture-fixtures) |

`comp` is `<comp-name>#<screen-id>` from the import manifest
(`.visual-diff/references/manifest.json`). States without `comp` are
capture-only.

### Routes and serving

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

### Readiness

`readiness.selector` (optional) is the **implementation-side** readiness
signal: capture waits for it to become visible after the policy wait, and a
selector that never appears fails the capture loudly (exit 3) naming it —
a frame of the wrong state is worse than no frame. `readiness.compSelector`
is the comp-side equivalent, consumed by import's driven render (FR-37).
The two are side-bound by design: never point `selector` at comp markup.

### compDrive and drive

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
([Unlabelled exports](#unlabelled-exports-no-data-screen-label));
`drive` requires nothing — a capture-only state may
drive freely.

### Masks

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
space. A config mask of the same name wins — the operator's explicit
declaration overrides the comp author's annotation. References imported
before this feature carry no `compAuthoredMasks`; the next re-import
re-probes the annotations and rewrites the record (pixels untouched), no
`--refresh` needed.

### selfCheck

`selfCheck` (optional, per state) bounds the FR-17 determinism re-capture:
by default the two captures must be byte-identical (any difference is exit
4); a state with a known-nondeterministic element (the blinking-caret
class) may declare `maxDiffPixels`, and a pixel difference within budget is
accepted and recorded in the capture's provenance instead of failing. A
dimension change fails regardless. Pair the budget with an anchored mask
on the caret element so the declared nondeterminism stays out of the
scored diff too.

### Capture fixtures

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

## The provenance gate

The provenance gate (exit 3) requires reference and capture to agree on
renderer identity (browser build, client version, mode, backend), device
scale factor, readiness policy/timeout/settle, vendor hashes, and the
per-state config hash; viewport (width/height/fullPage) is gated for
unclipped states only — a clipped state frames one element, and its output
dimensions are checked by the pixel path instead. Fonts are recorded in
provenance for diagnosis but are not gated. This is what makes a "pass" mean "same renderer, same
conditions" rather than a coincidence. Keep the state viewport at the
reference default (1502×818, fullPage, DSF 2).

The config hash is compared **per state**: every record carries
`inputs.stateConfigHash`, the
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

The renderer identity (browser build, client version, mode) is recorded in
every provenance record; references imported under one renderer will not
gate-match captures under another. Import and capture in the same mode.

### The browser pin

`browser` in the config is the **tool-managed pin** (native mode) written
by `--auto-discover-browser` — you can read it, diff it, and hand-author
it, but you normally never edit it; re-run the flag to re-pin. Its semantic
fields feed the config hash; `discoveredAt` is observational only. Absent
in service-only projects.

The pin is inspectable, diffable, and hand-authorable JSON. Because the
semantic pin fields feed the config hash (and therefore every state's
per-state hash), swapping the pinned browser invalidates references
deliberately: compare exits 3 naming `inputs.stateConfigHash` (or
`inputs.configHash` for legacy records), and one `import --refresh`
realigns.

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

## Install and run

**From a release artifact**: download the single-file executable for your
platform from the GitHub release (assets are named
`noise-visual-diff-<platform>-<arch>`; releases ship **linux-x64**,
**darwin-arm64**, and **darwin-x64**, built from the tagged source by the
public release workflow — `.github/workflows/release.yml`). An honest
caveat: only linux-x64 is exercised by the full test suite; the macOS
binaries are smoke-tested (version/help plus a best-effort worked-example
run) at build time. Windows binaries are **not shipped** (untested);
building from a checkout may work there, but is unverified. Verify your
download against the release's `SHA256SUMS`, mark it executable, and run
it directly — it bundles Node and every npm dependency (a browser is still
required; see Dependencies below).

```sh
sha256sum -c SHA256SUMS                          # verify the download
mv noise-visual-diff-linux-x64 noise-visual-diff # take the local name
chmod +x noise-visual-diff
./noise-visual-diff help
```

On macOS, download via the terminal (`curl -LO` or `gh release download`) so
no Gatekeeper quarantine attribute is set; if you downloaded through a
browser instead, `xattr -d com.apple.quarantine noise-visual-diff-darwin-<arch>`
is the remedy (the binaries are ad-hoc signed, not notarized).

**From a checkout:**

```sh
# from a checkout (Node pinned in .nvmrc)
npm ci
node src/cli.mjs <verb> ...

# or build the single-file SEA executable yourself (dist/noise-visual-diff)
npm run build:sea

# suite version (deployment gates compare this verbatim)
noise visual-diff version    # -> noise-visual-diff 0.12.0
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
  installs the exact-pinned runtime deps (`playwright`, `pngjs`,
  `pixelmatch`). No caret ranges anywhere. What may be added, and on what
  terms, is NFR-4 in `docs/DESIGN.md`: the runtime set is closed, while
  build-time-only and test-only devDependencies are permitted exact-pinned,
  never imported from `src/`, and never in the shipped closure. CI enforces
  the pins; the authoritative list is `package.json` + the lockfile.

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
