# Worked example: one screen, one deliberate defect, one hill-climb

Everything in this directory is synthetic and redistributable. It walks the
complete loop — import a design, capture the implementation, watch compare
fail on a real pixel difference, fix it, converge — using only this
repository and a browser.

The implementation ships with **one deliberate defect**: the button color is
`#a78bfa` where the design says `#7c3aed`. That is the difference you will
see, localize, and fix.

## 0. Prerequisites

Pick one entry point and bootstrap it:

- **From a checkout**: install the Node version pinned in the repository's
  `.nvmrc` (24.x; `nvm install` reads it) and install the repo's
  dependencies once from the repository root: `npm ci`. Then, from this
  directory: `vd() { node ../../src/cli.mjs "$@"; }`
- **From a release binary**: download `noise-visual-diff` from a release,
  verify it against the release's `SHA256SUMS`, `chmod +x` it, and:
  `vd() { ~/Downloads/noise-visual-diff "$@"; }` (adjust the path to where
  you saved it). No Node or npm needed.

Either way, run everything below from this directory
(`cd examples/hello-screen`).

## 1. Zip the design, place the config, import

`import` takes the zip a design tool exports. Build it from `design/`, put
the provided state config where the tool reads it, and import:

```sh
if command -v zip >/dev/null; then
  (cd design && zip -qr ../design-export.zip .)
else
  python3 -c "import shutil; shutil.make_archive('design-export','zip','design')"
fi

mkdir -p .visual-diff
cp visual-diff.json .visual-diff/visual-diff.json

vd import --auto-discover-browser design-export.zip
```

On a plain machine, `--auto-discover-browser` walks the discovery ladder
once, launch-verifies a local browser, and atomically pins it into the
config next to the `hello` state (pinning preserves operator-authored
states); with no usable browser it exits 3 with a probe report naming the
exact fix. On a service host (`NOISE_BROWSER_WS` set) discovery is a
native-mode act — omit the flag and the remote browser service is used
instead.

The import renders `design/Hello.dc.html` twice, records the measured noise
floor (0 for this fully static comp), and writes the reference PNG plus
provenance under `.visual-diff/references/`. If you later edit the config,
re-align the references once with `vd import --refresh design-export.zip`.

## 2. Capture and compare — watch it fail honestly

```sh
vd capture            # deterministic screenshot of implementation/, self-verified
vd compare --json     # exit 1: over threshold — the button color is wrong
```

The JSON names the damage: `states.hello.frame.mismatch` is a small nonzero
fraction against the state's 0.1% threshold, and the region rollup points at
the hottest row bands — the button. Look at the heatmap:

The heatmap is a plain PNG — open it with whatever your platform uses:

```sh
heatmap=".visual-diff/diffs/$(cat .visual-diff/current-run)/hello.png"
xdg-open "$heatmap" || open "$heatmap" || echo "view $heatmap in any image viewer"
```

## 3. Fix and converge

Edit `implementation/index.html`: change the `.card a` background from
`#a78bfa` to `#7c3aed` (a comment marks the line). Then:

```sh
vd capture
vd compare --json     # exit 0: converged — 0 differing pixels
vd report             # the published verdict, re-readable any time
```

That is the whole contract: exit `0` means the pixels matched **and** the
provenance gate proved reference and capture came from the same renderer,
viewport, DPR, readiness policy, and config. Delete `.visual-diff/` and
`design-export.zip` to reset the example.

## Two details worth stealing for real projects

- A comp-mapped state's viewport must equal the reference render frame
  (1502×818, `fullPage: true`) — references always render at that shared
  default, and the provenance gate enforces the match.
- The comp zeroes `body` and `figure` margins inline. Browser default
  margins shrink the figure's content box, and the frame crop follows the
  content box — leaving defaults in place cost this example 96 phantom
  pixel columns of permanent mismatch before they were zeroed.
