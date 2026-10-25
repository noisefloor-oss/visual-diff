# Exit codes and recovery

## Recovery playbook

What to do on each failure. Every failure surfaces as an exit code and a
report on stderr whose first line carries the failure's stable code
(FR-4a), except an unexpected internal failure, which carries none:

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
  it can raise and so always keeps its prefix; capture catches `ConfigError`
  at config load plus its own error types, and compare additionally catches
  `RunError`; report and verify-neutral catch `LayoutError` around the
  layout, `RunError` around the pointer, and `ReportError` around the report
  loaders. Everything else arrives verbless. Reachable today: `PATH_ESCAPE`
  from a `.visual-diff` symlink pointing outside the project (capture,
  compare, report, and verify-neutral all resolve artifact paths lazily,
  after those catches), and `manifest-invalid` from compare (raised by the
  import module compare shares). Each has a row below; the missing verb name
  is the only difference.

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
| 3 (compare) | provenance gate | read the named fields in stderr. Almost always: config written/edited after import without `--refresh` → run `import --refresh`. Otherwise: renderer mismatch (imported and captured under different browsers/modes) → redo both in the same mode; or `inputs.effectiveViewport` (the reference's canvas was grown to fit its frame, FR-38, and the capture rendered under different effective conditions) → make both sides render under matching conditions (typically: let the implementation's document scroll, or clip the state so its element frames identically). See [The provenance gate](provenance-gate.md#the-provenance-gate) |
| 3 (frame) | the rendered frame could not be trusted | stderr says the clip was `clamped to the document scroll box`, that the frame `measured … after the viewport was grown`, or that a `double render … disagreed on the canvas accommodation` — see [Named errors](#named-errors) |
| 3 (drive or readiness) | a target never appeared, so the page never entered the state | stderr says a `drive step`, `compDrive step`, `readiness selector`, or `readiness compSelector` `never became visible within <t>ms` — fix the selector or raise `readiness.timeout`/`settle`; see [Named errors](#named-errors) |
| 3 (browser) | no working browser | native: no pin yet → run any import/capture once with `--auto-discover-browser`; stale pin (binary moved/upgraded) → re-run with `--auto-discover-browser` to re-pin. If every ladder rung fails, read the probe report on stderr and run the printed fix command. On a service host, check `NOISE_BROWSER_WS` is set and the browser service is up — it never falls back silently. See [Browser modes](browser-modes.md#browser-modes--two-no-silent-fallback) |
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
| `CONFIG_ERROR` (not report) | 2 | a message naming the offending config path and reason, e.g. `comp must contain at most one "#" (got <n>)` | `.visual-diff/visual-diff.json` is missing a required key, malformed, or holds a value the schema refuses. Raised by import, capture, and compare — never by report. See [Project config](project-config.md#project-config) |
| `LAYOUT_ERROR` | 2 | `project directory does not exist: <dir>`, or `invalid <what>: "<value>" (must match <re>)` | the project directory or an artifact name (run id, state, comp, screen) does not satisfy the FR-30 grammar. Run the verb from the project root, and keep state/comp names within `[a-z0-9-]` |
| `PATH_ESCAPE` | 3 | `path escapes the project directory: <parts>`, or `path component is a symlink resolving outside the project: <path> -> <target>` | an artifact path, or a symlink on its way, leaves the project directory — typically `.visual-diff/` (or a directory inside it) symlinked elsewhere. Nothing is written. Remove the symlink, or fix the name that composed the path. Artifact paths resolve lazily, so in capture, compare, and report this arrives **without** the verb prefix; import maps it itself |
| `PROVENANCE_SCHEMA` | 3 | `unsupported provenance schema version <v> (supported: <v>)`, or a message naming the malformed record field | a `.provenance.json` was written by an incompatible version or hand-edited. Re-import / re-capture the artifact rather than repairing the record |
| `PROVENANCE_TAMPER` | 3 | `artifact content hash mismatch: record says <hash>, artifact computes <hash>` | a PNG and its record disagree — the artifact or the record changed after it was written. Re-import / re-capture. (Compare re-labels its own copy of this check as `provenance-tamper`) |
| `PROVENANCE_ARGUMENT` | 2 | a message naming the invalid argument, e.g. `artifact path must be relative to the project directory` | an internal misuse of the provenance API — it should never reach you; if it does, it is a bug worth reporting |

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
| `comp-has-no-screens` | 2 | `declares no [data-screen-label] screens, but state(s) … map it as <comp>#<screen>`, or `declares no [data-screen-label] screens, but state(s) … map it without a compTarget` | a config state maps a comp whose markup has no screens at all. There are no labelled screens to name: map the **whole** comp and give each mapping state an explicit `compTarget` selector (paired with `clip`), or add screens to the comp — see [Unlabelled exports](setup-and-import.md#unlabelled-exports-no-data-screen-label). An *unreferenced* screenless comp is only a logged warning |
| `comp-target-missing` | 3 | `compTarget "<selector>" matched <n> elements — it must match exactly one`; `compTarget "<selector>" matched an element with no layout box (display:none or detached)`; `compTarget "<selector>" never became visible within <t>ms` | the explicit frame selector resolved to zero or several elements, a hidden element, or never appeared (post-drive, if the state drives). Fix the selector — the reference frame must be a stated fact. See [Unlabelled exports](setup-and-import.md#unlabelled-exports-no-data-screen-label) |
| `screen-missing` | 2 | `screen "<id>" not found in <comp file> after hydration` | the screen is in the comp's markup but absent from the hydrated DOM. The first render of a base screen triages absence instead (skip / driven-only), so this fires on a later render of the same screen — a driven render, the second pass, or a record repair — which makes a nondeterministic or drive-sensitive comp the usual cause. Fix or re-export the comp. It is not a config mistake: a `comp` value naming a screen the manifest does not hold fails in compare as `no-screen` |
| `empty-frame` (undriven) | 2 | `renders empty undriven, but state(s) "…" map it without compDrive` | a runtime-conditional screen is mapped by a state with no `compDrive`, so no undriven reference can exist for it. Give that state a `compDrive` that makes the screen visible (it becomes driven-only), or fix the comp so the screen renders undriven. See [Multi-screen SPA exports](setup-and-import.md#multi-screen-spa-exports) |
| `empty-frame` (driven render) | 2 | `has an empty frame (caption only?)` | a `compDrive` render measured a zero-size frame: the steps ran but did not put the comp into that screen. Fix the `compDrive` steps (or the selectors they target) |
| `empty-frame` (second pass) | 2 | the same `has an empty frame (caption only?)`, on a screen that rendered fine a moment earlier | only the FIRST render of a base screen tolerates an empty frame; pass 2 of 2 does not. A screen that was non-empty on pass 1 and empty on pass 2 has no `compDrive` to fix — the comp itself is nondeterministic (a timer, an animation, a late conditional). Re-run import; if it repeats, make the comp render the screen deterministically |
| `all-screens-empty` | 2 | `every screen of comp … renders empty undriven` | every screen of the comp sits behind a runtime condition, so it can produce no reference at all. Map at least one screen with a `compDrive` state (driven-only) and re-run import |
| `screen-dimension-mismatch` | 2 | `screens of one comp must share device dimensions` | two screens of one comp rendered at different sizes. If the difference is intentional, annotate that screen with `data-screen-variable-size` in the comp |
| `comp-mask-conflict` | 2 | `mask "…" is declared differently for <comp>#<screen>` | two states declare the same mask name for one screen with a different `compSelector` or `shape`; the screen's shared reference record cannot name both. Make them identical, or rename one |
| `drive-target-missing` | 3 | `compDrive step <i> (<action> "<selector>") never became visible within <t>ms — the comp cannot be driven into this state` | a `compDrive` step's target never appeared, so the comp never entered the state. Fix the selector, or raise `readiness.timeout`/`settle`. See [compDrive and drive](project-config.md#compdrive-and-drive) |
| `comp-selector-missing` | 3 | `readiness compSelector "…" never became visible within <t>ms — refusing to record a reference of the wrong state` | the comp-side readiness selector never appeared. Fix `readiness.compSelector`, or raise the timeout. See [Readiness](project-config.md#readiness) |
| `frame-unstable` | 3 | `measured <rect> at the declared viewport but <rect> after the viewport was grown to <w>x<h> to fit it`, or `disappeared after the viewport was grown` | the frame extended past the document canvas, the tool grew the viewport to fit it, and the re-measured frame changed — the comp reflows responsively with viewport size, so extending the canvas would change the very pixels being referenced. Fix the comp to a static frame (dimensions independent of viewport), or let the document itself scroll instead of an inner container, then re-import. Stderr names both measured rects (FR-38, [docs/DESIGN.md](DESIGN.md)) |
| `frame-truncated` | 3 | `the render delivered <w>x<h> device px but the screen frame requires <w>x<h> — the screenshot clip was clamped to the document scroll box` | the browser clamped the requested frame to the document scroll box, so the delivered PNG is short. The tool grows the canvas automatically for the common inner-scroll case (`html,body` at `height:100%` with an `overflow:auto` region), so this is the residual failure: the grow could not bring the frame inside the document canvas. Let the document itself scroll, or size the scroll container to its content, then re-import. Provenance `inputs.frame` + `inputs.delivered` carry both dimensions (FR-38) |
| `canvas-divergent` | 3 | `double render of <comp>#<screen> disagreed on the canvas accommodation` | the two passes of the reference's double render made different structural decisions (one grew the viewport, the other did not, or they grew differently). That is a canvas race, not pixel jitter, so no noise floor may absorb it and the reference is refused. Re-run import on a quiet host; if it repeats, give the comp a static frame so no grow is needed |
| `comp-mask-missing` | 3 | `mask "…" compSelector "…" matched <n> elements (<m> visible) … it must match exactly one visible element` | an anchored mask's `compSelector` does not resolve to exactly one visible element in that screen. Retarget it. See [Masks](project-config.md#masks) |
| `comp-mask-radius-unsupported` | 3 | `mask "…" compSelector "…" has unsupported computed border-…-radius "…" — use plain px or % radius components` | the comp ring anchor's computed radius contains `calc()` or another component the tool cannot resolve without guessing. Replace it with plain `px`/`%` radii; the import refuses to record a rectangular ring fallback. See [Masks](project-config.md#masks) |
| `comp-mask-invalid` | 3 | `data-vd-mask="…" matched <n> elements (<m> visible)`, or `a data-vd-mask annotation … has an empty value` | a comp-authored annotation names zero or several visible elements, or carries an empty value. Fix the annotation in the comp. See [Masks](project-config.md#masks) |
| `render-defect` | 3 | `aborted requests — unvendored external or isolation failure`, `aborted requests after load — … re-run import so discovery can vendor it`, or `isolation trust defect while discovering …` | the comp render reached for something the isolation layer refused. Re-run import so discovery vendors it, or drop the external reference from the comp |
| `font-load-failed` | 3 | `reference render of <url>: font face(s) failed to load: <faces> — the reference would bake in fallback glyphs` | a font the comp used was served but failed to load — a 404 from the export tree, corrupt vendored bytes, or an undecodable file. (The policy is conservative: a face reaches `error` when a load was attempted and failed — by layout or by explicit script such as `document.fonts.load` — while a declared-but-never-attempted face stays `unloaded` and passes.) Fix the font reference or drop the `@font-face`, then re-import |
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
| `drive-target-missing` | 3 | `drive step <i> (<action> "<selector>") never became visible within <t>ms — the implementation cannot be driven into this state; refusing to record a frame of the wrong state (FR-39)` | the implementation never entered the state. Fix the selector, or raise `readiness.timeout`/`settle`. See [compDrive and drive](project-config.md#compdrive-and-drive) |
| `READINESS_SELECTOR_TIMEOUT` | 3 | `readiness selector "…" never became visible within <t>ms — refusing to record a frame of the wrong state (FR-16)` | `readiness.selector` never became visible. Fix the selector, or raise the timeout. See [Readiness](project-config.md#readiness) |
| `MASK_SELECTOR_MATCH` | 3 | `mask "…" selector "…" matched <n> elements (<m> visible) — it must match exactly one visible element` | an anchored mask does not resolve to exactly one visible element on the capture page. Retarget it. See [Masks](project-config.md#masks) |
| `MASK_RADIUS_UNSUPPORTED` | 3 | `state <name>: mask "…" selector "…" has unsupported computed border-…-radius "…" — use plain px or % radius components` | a ring anchor's computed radius contains `calc()` or another component the tool cannot resolve without guessing. Replace it with plain `px`/`%` radii; capture refuses to record a rectangular ring fallback. See [Masks](project-config.md#masks) |
| `unknown-state` | 2 | `unknown state(s): <names> (valid: <names>)` | `--state` named a state the config does not define. The valid list is printed |
| `no-states` | 2 | `no states defined — author .visual-diff/visual-diff.json` | the config has no `states` at all. See [One-time setup](setup-and-import.md#one-time-setup) |
| `CAPTURE_FAILED` | 3 | `state <name>: setupScript <path> must export an async default function (page) => Promise<void>`, or any other untyped capture failure verbatim | the class default, carried by capture failures that declare no more specific code — chiefly a `route.setupScript` module with no usable `default`/`setup` export. Anything the script itself throws is reported verbatim and lands in the same trust bucket: nothing is staged or published |
| `render-defect` | 3 | `aborted external font request(s) — the capture would record fallback glyphs, not the design's ground truth` | an external font was refused, so the capture would compare fallback glyphs. Re-run import so discovery vendors the font, or drop the external `@font-face` |
| `font-load-failed` | 3 | `state <name>: font face(s) failed to load: <faces> — the capture would record fallback glyphs, not the design’s ground truth` | the candidate's font did not load — a missing file, a 404 from the served tree, or undecodable bytes — and the browser fell back to another font. Comparing would read fallback glyphs as design drift (or, against an equally broken reference, pass silently). Restore the font or drop the `@font-face`, then re-capture |
| `frame-unstable` | 3 | `clip "<selector>" framed <rect> at the declared viewport but <rect> after the viewport was grown to <w>x<h> to fit it` | the capture-side twin of the import row above: the page reflows under the grown viewport. Fix the page to a static frame, or let the document itself scroll, then re-capture |
| `frame-truncated` | 3 | `the clipped capture delivered <w>x<h> … but the clip rect requires <w>x<h> — the screenshot clip was clamped to the document scroll box` | the capture-side twin of the import row above. Let the document itself scroll, or size the scroll container to its content, then re-capture |
| `determinism-failed` | 4 | `determinism self-check FAILED for <state> (…) — re-capture from a fresh context differed (FR-17/NFR-1)`, plus `The capture is not trusted and the run is not published` | the two passes differed (or diverged on the canvas accommodation, which no `selfCheck` budget may absorb). Re-capture; if the same state fails on a quiet host the page is nondeterministic — see the exit-4 row above and [selfCheck](project-config.md#selfcheck) |

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
| `screen-skipped` | 2 | `but import skipped that screen (<reason>: it renders empty undriven and no state mapped it at import time)` | the id is in the manifest but has no artifacts: it rendered empty when it was imported and nothing drove it. Give the state a `compDrive` if it has none, then `import --refresh`. See [Multi-screen SPA exports](setup-and-import.md#multi-screen-spa-exports) |
| `driven-only` | 2 | `without compDrive, but that screen is driven-only (it renders empty undriven, so no undriven reference exists)` | the id is in the manifest as driven-only and this state has no `compDrive`, so there is no undriven reference to compare against. Declare a `compDrive` on the state. (This guard and `screen-skipped` test the `drivenOnly` and `skipped` flags only — a driven `<id>@<state>` entry would trip neither, and is kept out of reach by the sanitization noted under `no-screen`.) See [Multi-screen SPA exports](setup-and-import.md#multi-screen-spa-exports) |
| `no-reference` | 2 | `no reference PNG at reference <comp>#<screen> — run import before compare`; for a driven state the remedy reads `driven references render only under import --refresh (a config change does not alter the comp content hash)`; for a compTarget state, `maps comp <name> with compTarget <selector>, but the reference manifest holds no <comp>@<state> reference` | the manifest names the screen but its PNG is absent (or, for a compTarget state, no state-scoped reference was ever rendered for this state). Run the import the message names |
| `capture-only` | 2 | `state(s) … are capture-only (no comp mapping) and cannot be compared` | `--state` explicitly selected a state with no `comp`. Drop it from the selection, or give it a mapping |
| `no-comparable` | 2 | `no selected state maps to a comp — compare needs comp mappings (FR-31)` | nothing in the selection has a `comp` mapping |
| `no-such-run` | 2 | `no stored report for run "<id>" — looked for diffs/<id>/report.json (compare that run first)` | `--against` / `report --diff` named a well-formed run id whose `report.json` is absent. Compare that run first, or name one that has been compared. See [Run-to-run diff](compare-results.md#run-to-run-diff) |
| `threshold-below-noise-floor` | 2 | `threshold below the measured noise floor — pass --force to override: <state>: threshold <p>% < noise floor <p>%` | the threshold asks for more precision than two renders of the same screen agree on. Raise it above the floor, make the state deterministic, or pass `--force` if you accept the noise. See [Thresholds, units, and the noise floor](compare-results.md#thresholds-units-and-the-noise-floor) |
| `mask-covers-nothing` | 2 | `mask "…" excludes 0 pixels — its rect covers none of the compared area` | the mask measures nothing, so scoring would report a number with a mask that does nothing. Fix the rect/selector, or remove the mask. See [Masks](project-config.md#masks) |
| `mask-anchor-unresolved` | 2 | `anchors to "…" but the capture's provenance carries no resolution for it — re-capture the state`, or `names compSelector "…" but the reference's provenance carries no resolution for it — re-import the comp` | the anchor was never resolved on that side (anchors resolve at capture time, comp anchors at import time). Do what the message says. See [Masks](project-config.md#masks) |
| `mask-anchor-stale` | 2 | capture side: `was captured as shape "<recorded>" but config now says "<configured>" — re-capture the state`, or `was captured against selector "…" but config now anchors to "…" — re-capture the state`. Reference side (only for a mask that declares `compSelector`): `was imported as shape "<recorded>" but config now says "<configured>" — re-import the comp`, or `was imported against compSelector "…" but config now names "…" — re-import the comp` | an anchored mask was retargeted or reshaped after the artifacts were written, so the recorded geometry belongs to another element or shape. The capture side is checked **first** and the reference side only after it passes, so a **shape** change on a mask that declares `compSelector` fails twice in a row: do **both** — re-capture *and* re-import — before the next compare, or the reference check fires as soon as the capture check stops. A `selector`-only change needs the re-capture; a `compSelector`-only change needs the re-import. Masks never enter the config hash, so nothing else is invalidated. See [Masks](project-config.md#masks) |
| `provenance-mismatch` | 3 | `provenance gate failed for state <name>: incompatible fields: <fields> — re-import references or re-capture under matching conditions` | the reference and the capture disagree on a gated field; stderr names them. Almost always `import --refresh`. See the exit-3 (compare) row above and [The provenance gate](provenance-gate.md#the-provenance-gate) |
| `capture-missing` | 3 | `capture artifact missing at <artifact label>`, or `run <id> holds no capture for the selected state(s) …` | the published run holds no capture for what you selected. Re-capture, or select states the run holds |
| `provenance-unreadable`, `provenance-tamper` | 3 | `<artifact> provenance cannot be trusted: …`, or `artifact content hash mismatch — the artifact or its record was tampered` | a record is unreadable, or does not match its PNG. Never repair a record by hand: re-import / re-capture |
| `png-decode` | 3 | `cannot decode PNG: …` | a reference or capture PNG cannot be decoded for comparison. Re-import / re-capture |
| `RUN_INCOMPLETE` | 3 | `run <id> is not complete (missing <artifacts>) — current-run was not updated` | an existing report belongs to a run whose artifact set is now incomplete, so compare refuses before writing; publication also re-checks after scoring. The previous report, diff artifacts, and published pointer are left untouched by an early refusal. Re-capture and compare again |

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
| `bad-diff-order` | 2 | `--diff must precede both run ids: report --diff <runIdA> <runIdB>` | a positional run id appeared before `--diff`; put the flag first so the diff remains A-to-B |
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
