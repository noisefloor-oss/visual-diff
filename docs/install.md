# Install and run

**From a release artifact**: download the single-file executable for your
platform from the GitHub release (assets are named
`noise-visual-diff-<platform>-<arch>`; releases ship **linux-x64**,
**linux-arm64**, **darwin-arm64**, and **darwin-x64**, built from the
tagged source by the public release workflow —
`.github/workflows/release.yml`). CI runs the full suite on Linux ARM64 and
native filesystem race tests on macOS ARM64. Each release platform must build its SEA executable and pass
the embedded static-helper smoke and version/help checks. The worked-example
walkthrough is required on both Linux platforms and best-effort on macOS. Windows
binaries are **not shipped** (untested); building from a checkout may work
there, but is unverified. Verify your download against the release's
`SHA256SUMS`, mark it executable, and run it directly — it bundles Node
and every npm dependency (`import` and `capture` still need a browser; see
Dependencies below).

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

**From a checkout:** also install Go 1.26.10 — `build:sea` and source-mode
capture build the first-party static-file helper from `native/` on demand.

```sh
# from a checkout (Node pinned in .nvmrc)
npm ci
node src/cli.mjs <verb> ...

# or build the single-file SEA executable yourself (dist/noise-visual-diff)
npm run build:sea

# suite version (deployment gates compare this verbatim)
noise visual-diff version    # -> noise-visual-diff 0.14.1
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

## Install or update with an agent

Use the [install/update skill](../skills/install-update-visual-diff/SKILL.md)
for verified standalone downloads, replacement and rollback. It also explains
when [Deck](https://github.com/noisefloor-oss/deck) manages the executable and
browser versions together.

## Dependencies

- **Using the distributed binary:** the SEA build bundles Node and every npm
  dependency into one file — but `import` and `capture` need a **browser**,
  and it is NOT bundled. `compare`, `report`, and `verify-neutral` read
  saved artifacts and never launch one. In service mode the remote browser service provides it (nothing local
  to install); in native mode a local chromium comes from the discovery
  ladder (playwright managed cache, system Chrome/Edge/Chromium, or
  agent-browser) the first time you pass `--auto-discover-browser`, and is
  pinned in the config from then on — see [Browser modes](browser-modes.md). If nothing
  works, the tool exits 3 with a probe report and the exact fix command.
- **Developing from a checkout:** Node exact-pinned in `.nvmrc`; `npm ci`
  installs the exact-pinned runtime deps (`playwright`, `pngjs`,
  `pixelmatch`). No caret ranges anywhere. What may be added, and on what
  terms, is NFR-4 in `docs/DESIGN.md`: the runtime set is closed, while
  build-time-only and test-only devDependencies are permitted exact-pinned,
  never imported from `src/`, and never in the shipped closure. CI enforces
  the pins; the authoritative list is `package.json` + the lockfile.
