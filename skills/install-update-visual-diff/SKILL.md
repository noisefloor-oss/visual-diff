---
name: install-update-visual-diff
description: Install or update a standalone Noisefloor Visual Diff release with verified downloads and rollback. Route bundled installations through their owning application.
---

# Install or update Visual Diff

Use the single-file executables from
[public releases](https://github.com/noisefloor-oss/visual-diff/releases).
Read [installation requirements](../../docs/install.md) and
[browser modes](../../docs/browser-modes.md) when selecting the installation.

## Establish who owns the executable

Inspect the user's actual invocation and resolved executable. Record the
current version with `noise-visual-diff version`, the absolute install path,
and any symlink target before replacing anything. A source checkout follows
its own version-control workflow; do not overwrite it with a release binary.

If [Deck](https://github.com/noisefloor-oss/deck) or another suite installation
owns the executable, use that application's update mechanism. Its Visual Diff,
Node and Playwright browser-service pins move together. Do not replace bundled
binaries, change the service's Playwright pin, or run `npx playwright install`
on that application's host to fix an isolated tool upgrade. Report the owning
application and required compatible update if it cannot be updated now.

For a standalone installation, use the release requested by the operator. If
none was specified, select the latest published stable release and record its
exact tag. Do not choose a draft, prerelease, or unpublished version implicitly.

## Verify a staged download

Map the host to one asset: `linux-x64`, `linux-arm64`, `darwin-arm64`, or
`darwin-x64`. Check the process architecture as well as the host, particularly
under emulation. Windows has no published binary. Stage in a fresh directory,
keeping the existing executable intact until validation succeeds.

For example, after setting `tag` to the selected exact published tag and
`target` to the matching supported platform/architecture:

```sh
asset="noise-visual-diff-$target"
gh release download "$tag" --repo noisefloor-oss/visual-diff \
  --pattern "$asset" --pattern SHA256SUMS --pattern "manifest-$target.json"
# Require exactly one checksum entry for each selected asset. Do not check
# absent binaries for other platforms or accept a missing selected entry.
awk -v a="$asset" -v m="manifest-$target.json" \
  '$2 == a { print; binaries++ } $2 == m { print; manifests++ }
   END { if (binaries != 1 || manifests != 1) exit 1 }' \
  SHA256SUMS > selected-checksums
```

Run `sha256sum -c selected-checksums` on Linux or
`shasum -a 256 -c selected-checksums` on macOS. Require success for both files;
a missing or duplicate selected entry is a refusal. Inspect the manifest's
version, platform and architecture against the tag and selected target.
Checksums downloaded from the same release detect corruption; they are not an
independent publisher signature.

Mark only the verified binary executable. Run its `version` and `help` directly
from staging and require the version to match the chosen tag without `v`.
Released executables embed Node, npm dependencies and the static-file helper;
users do not need to install Node or Go. macOS binaries are ad-hoc signed and
not notarized; use the terminal download and the quarantine guidance in the
installation page if needed.

## Replace and verify

For an update, preserve a rollback copy of the old executable and record its
version and destination. Copy the candidate to a temporary sibling of the
resolved install path, set the intended permissions, then rename it into place
on the same filesystem. Preserve deliberate symlink layouts. For a new install,
choose a user-owned directory on PATH unless the operator requested another
location. Do not silently select a bundled libexec directory.

Resolve the command again and verify its version and help through the user's
actual invocation. If validation fails, restore the previous executable and
report the failed step. Keep the rollback copy until verification is complete.
Leave project `.visual-diff/` data and the user's browser installations intact.

Before the next comparison, check browser compatibility. A remote Playwright
server must match this release's exact client pin in `package.json`; a set but
refused `NOISE_BROWSER_WS` must fail rather than fall back to a local browser.
For standalone native mode, use the documented discovery/re-pin flow and read
its probe report. A runtime/browser change can invalidate existing reference
provenance: refresh imports and capture again with matching settings, preserving
the existing project data first. Never use `--force` to conceal a version or
provenance mismatch.

Report the selected tag, resolved install path, platform, checksum and version
results, rollback location, and any required browser or reference refresh.
