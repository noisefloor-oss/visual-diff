# Setup and import

## One-time setup

```sh
# 1. Import the design export — renders every comp screen into
#    .visual-diff/references/ with provenance. First import has no config
#    yet, so references record the hydration default.
#    Native hosts: --auto-discover-browser walks the discovery ladder ONCE
#    and atomically pins the accepted browser into the config (see "Browser
#    modes"). Service hosts (NOISE_BROWSER_WS set): omit the flag —
#    discovery is a native-mode act and exits 2 there.
noise visual-diff import --auto-discover-browser design-export.zip

# 2. Author .visual-diff/visual-diff.json — one state per screen you intend
#    to verify, each mapping a route to a comp#screen (config schema: project-config.md).
#    Read .visual-diff/references/manifest.json for the exact comp/screen ids.
#    (The browser pin written in step 1 stays untouched — edit states only.)

# 3. Re-align references to the config (readiness policy + config hash), so
#    the FR-23 provenance gate matches what capture will record.
noise visual-diff import --refresh design-export.zip
```

## Multi-screen SPA exports

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
  [Named errors](exit-codes-and-errors.md#named-errors) for both messages).

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

## Unlabelled exports (no `data-screen-label`)

Some valid Claude Design exports contain a **complete interactive app** in a
`.dc.html` file but no labelled screen elements at all. Import discovers
such a comp but has nothing to enumerate — earlier versions skipped it
(`comp … has no [data-screen-label] screens — skipping`) and, when it was
the only comp, failed with `import [no-comps]`. The comp is importable
through **explicit mappings** (FR-40): each state names the *whole* comp and
declares a `compTarget` selector whose element frame is the reference,
paired with a `clip` selector framing the corresponding element on the
implementation side. The tool never guesses which element is the screen —
a mapping without `compTarget` fails import with `comp-has-no-screens`.

A `compTarget` is equally valid on a comp that **has** labelled screens
(v0.13.0): labels address inner panels, but a whole-app comparison needs
the app's full frame — header and navigation included — which no screen
names. Use `comp: "<comp-name>"`, `compTarget: "body"`, `clip: "body"` (or
any exact-one selector). The two reference families coexist on one comp:
`comp#screen` states keep their per-screen references, `compTarget` states
get state-scoped `<comp>@<state>` ones.

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
