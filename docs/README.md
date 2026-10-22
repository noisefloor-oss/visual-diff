# Visual Diff documentation

The CLI is self-documenting: `noise visual-diff help` (or `--help`) prints
the full flag/exit-code/env-var/artifact reference to stdout, and
`noise visual-diff help <verb>` prints per-verb detail. Both exit 0 and are
safe to call in any directory. These pages remain the prose documentation
(config schema, report.json fields, playbooks); the help text is the terse
scripting reference.

Each step of the loop is explained under [Setup and import](setup-and-import.md#setup-and-import) and
[The hill-climb round](hill-climb.md#the-hill-climb-round); the
[task map](#task-map) below routes any other question.

## Pages

- [Overview](overview.md): what the tool is for and how an agent drives it.
- [Install and run](install.md): release binary, checkout, uninstall, dependencies.
- [Setup and import](setup-and-import.md): first import, multi-screen SPA exports, unlabelled exports.
- [The hill-climb round](hill-climb.md): capture, compare, iterate, and archive the PR proof.
- [Reading compare results](compare-results.md): `compare --json`, thresholds, attribution, run-to-run diff.
- [Project config](project-config.md): `.visual-diff/visual-diff.json`, routes, drive steps, masks.
- [The provenance gate](provenance-gate.md): why a pass is trustworthy.
- [Browser modes](browser-modes.md): service and native modes, the browser pin.
- [Exit codes and recovery](exit-codes-and-errors.md): the recovery playbook and every named error.
- [Development](development.md): running the test suite.
- [DESIGN.md](DESIGN.md): the requirement index cited throughout the source and tests.

## Task map

| I want to … | section |
|---|---|
| set up a project for the first time | [One-time setup](setup-and-import.md#one-time-setup) |
| import a multi-screen SPA export, or understand why screens were skipped | [Multi-screen SPA exports](setup-and-import.md#multi-screen-spa-exports) |
| run a verification round and iterate | [The hill-climb round](hill-climb.md#the-hill-climb-round) |
| drive a UI state (open a menu, select a tab) on the comp side, the implementation side, or both | [compDrive and drive](project-config.md#compdrive-and-drive) |
| exclude a deliberate divergence — a clock, a device bezel — from scoring | [Masks](project-config.md#masks) |
| parse the compare verdict, region rollup, or attribution | [compare --json](compare-results.md#compare---json) |
| reason about thresholds, noise floors, and units | [Thresholds, units, and the noise floor](compare-results.md#thresholds-units-and-the-noise-floor) |
| see what my last change actually moved | [Run-to-run diff](compare-results.md#run-to-run-diff) |
| write or change the config | [Project config](project-config.md#project-config) |
| understand why a pass is trustworthy | [The provenance gate](provenance-gate.md#the-provenance-gate) |
| act on exit 1 (over threshold) | [Recovery playbook](exit-codes-and-errors.md#recovery-playbook) |
| act on exit 2 (usage / config error) | [Recovery playbook](exit-codes-and-errors.md#recovery-playbook) |
| act on exit 3 (trust failure: gate, browser, frame, drive) | [Recovery playbook](exit-codes-and-errors.md#recovery-playbook) |
| act on exit 4 (capture determinism self-check) | [Recovery playbook](exit-codes-and-errors.md#recovery-playbook) |
| look up the code the CLI printed on stderr, or work out what a failure message means | [Named errors](exit-codes-and-errors.md#named-errors) |
| choose or pin a browser, or fix browser resolution | [Browser modes](browser-modes.md#browser-modes--two-no-silent-fallback) |
| find the artifacts and archive round proof for a PR | [Artifacts](hill-climb.md#artifacts-the-pr-proof) |
| install the tool, or remove every trace of it | [Install and run](install.md#install-and-run) |
| read the terse flag reference | `noise visual-diff help` |
