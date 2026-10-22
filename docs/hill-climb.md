# The hill-climb round

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

## Operating rules

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

## Artifacts (the PR proof)

Everything lives under `.visual-diff/` (gitignore it in the host project):

```
.visual-diff/
  references/<comp>#<screen>.png + .provenance.json + manifest.json
  captures/<run-id>/<state>.png + .provenance.json
  diffs/<run-id>/<state>.png
  current-run                 # published pointer — managed by the tool
```

Archive `captures/<run>/`, `diffs/<run>/`, and the compare JSON per hill-climb
round (plus side-by-side composites) so a PR can show implemented-vs-reference
visually, round by round.
