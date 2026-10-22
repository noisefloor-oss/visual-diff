# Overview

Use Visual Diff to check that your implementation matches your design. It
closes the loop a coding agent runs every day:

1. a design is exported from Claude Design as a `.zip` of `.dc.html` comps;
2. your agent implements the UI;
3. your agent proves, with pixels, that the implementation matches the
   design, and fixes the differences until it does.

Visual Diff handles step 3. `import` renders the design comps into reference
screenshots, `capture` takes deterministic screenshots of the running
implementation, and `compare` pixel-compares the two under a strict
provenance gate. `report` reads back the last verdict without comparing
again.

Everything is scriptable. Every verb has stable exit codes, and a typed
failure prints a stable error code on the first line of its stderr report.
`compare` and `report` support `--json`, the artifact layout is
deterministic, nothing prompts you, and all project state lives under
`.visual-diff/`.

Your agent reads the exit codes and JSON, edits code between rounds, and
archives each round's artifacts as visual proof (implemented vs reference)
for a PR.
