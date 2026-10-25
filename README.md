# Noisefloor Visual Diff

Visual Diff gives coding agents a way to see how closely their work matches
your design. It compares screenshots of the running interface with reference
screenshots and shows where the pixels differ.

An agent can make a change, capture the interface again, and measure whether
it got closer. Repeating that loop lets it work toward a pixel-perfect
implementation with feedback from the actual screen.

<!-- TODO: add a screenshot of a compare round (reference | diff | implementation). The repository has no product image yet. -->

## From design to working interface

Visual Diff renders a Claude Design export into reference screenshots, then
captures the corresponding screens in your application. Reports show the
reference, implementation and differences, so an agent can find the areas
that still need work.

Between rounds, the agent edits the code and uses Visual Diff to measure the
result, with checks that each comparison uses the expected design,
configuration and browser. A passing comparison means the difference is
within your chosen tolerance, and you can inspect the screenshots alongside
the score.

**Status: experimental.** Daily-driven by its author against real projects;
interfaces, file formats, and exit codes may change between releases without
a deprecation cycle. See [DEVELOPMENT.md](DEVELOPMENT.md) for how the project
is developed and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Part of the Noisefloor workflow

[Deck](https://github.com/noisefloor-oss/deck) brings projects, tasks and
agent sessions into a browser workspace for building products with AI.
[Tasks](https://github.com/noisefloor-oss/tasks) manages the work and its
working copies, [SDLC](https://github.com/noisefloor-oss/sdlc) provides the
project's delivery rules, and Visual Diff gives agents feedback on the
interface they are building.

Visual Diff also works on its own, with a command-line interface that lets
agents and scripts capture and compare each round.

## Install

Download the single-file binary for your platform from the GitHub release,
verify it, and run it directly:

```sh
sha256sum -c SHA256SUMS                          # verify the download
mv noise-visual-diff-linux-x64 noise-visual-diff # take the local name
chmod +x noise-visual-diff
./noise-visual-diff help
```

Source development and SEA builds require Go 1.26.10 in addition to the pinned
Node runtime. Go builds the first-party static-file helper that keeps capture
responses inside the selected directory during concurrent filesystem changes.
Released executables embed that helper and do not require Go to be installed.

Or run from a checkout (Node pinned in `.nvmrc`): `npm ci`, then
`node src/cli.mjs <verb> ...`. `import` and `capture` need a browser, which is
never bundled. See [Install and run](docs/install.md) for platforms, macOS
quarantine, uninstalling, and dependencies.

For an existing installation, use the
[install/update skill](skills/install-update-visual-diff/SKILL.md).

## First run

```sh
./noise-visual-diff import --auto-discover-browser design-export.zip  # 1. references
# 2. author .visual-diff/visual-diff.json (one state per screen)
./noise-visual-diff import --refresh design-export.zip                # 3. re-align
./noise-visual-diff capture                                           # 4. stage a run
./noise-visual-diff compare --threshold 2 --json                      # 5. verdict
```

Step 1 pins a local browser; if `NOISE_BROWSER_WS` points at a browser service,
leave `--auto-discover-browser` out. Exit 0 means the comparison passed its
checks and is within the chosen threshold; 1 means over threshold, so the
agent can adjust the implementation and repeat from `capture`. Each step is
explained in [Setup and import](docs/setup-and-import.md) and
[The hill-climb round](docs/hill-climb.md). `./noise-visual-diff help` prints
the command reference. In a full Noisefloor installation, the same
commands are available as `noise visual-diff`.

## Documentation

- [Documentation index](docs/README.md): a task map that routes any question.
- [Overview](docs/overview.md): what the tool is for and how an agent drives it.
- [Setup and import](docs/setup-and-import.md): first import, multi-screen SPA exports, unlabelled exports.
- [The hill-climb round](docs/hill-climb.md): capture, compare, iterate, and archive the PR proof.
- [Reading compare results](docs/compare-results.md): `compare --json`, thresholds, attribution, run-to-run diff.
- [Project config](docs/project-config.md): `.visual-diff/visual-diff.json`, routes, drive steps, masks.
- [The provenance gate](docs/provenance-gate.md) and [Browser modes](docs/browser-modes.md).
- [Exit codes and recovery](docs/exit-codes-and-errors.md): the recovery playbook and every named error.
- [Development](docs/development.md): running the test suite.

## License

MIT © 2026 Doug Doan. Built at Noisefloor.
