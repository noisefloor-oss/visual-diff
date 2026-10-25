# Static file serving

Capture serves the selected static directory on loopback while the browser
renders it. Files can change during development. A concurrent file or parent
replacement must not make the server read outside the selected directory.

The first-party helper in `native/static-root` holds a Go `os.Root`. Each
response opens through that held root, checks the opened descriptor is a regular
file, and streams that descriptor. Directory indexes use the same rooted open.
Absolute in-root symlinks resolve to a relative candidate and then pass through
another rooted open; the resolved pathname is never read directly. Replacement
races can change which inside file is seen, or cause a refusal, but cannot
redirect the final read outside the root. A provided project directory is also
anchored while opening the static root. Without a project directory, the root
selected at server startup is the boundary.

The helper accepts only a root and optional project path at startup, binds an
ephemeral loopback port, and supports GET and HEAD. EOF on its parent's pipe
shuts it down, including when the parent exits abruptly. It rejects traversal,
escaping symlinks and non-regular files. It does not isolate changes to the
contents of files already inside the authorized root or protect against an
attacker who can modify the running tool itself.

SEA packaging builds the helper with Go 1.26.10 for the build platform and embeds
its bytes and SHA-256 in the one downloaded executable. At runtime it writes the
verified bytes to a fresh owned temporary directory, starts it, and removes the
directory on normal process exit. No Go installation is needed by release users.
Source development compiles the same helper once per process. The runtime npm
dependency set is unchanged.

`cd native && go test -race ./...` exercises held descriptors, root replacement,
absolute and relative symlinks, non-regular files, and concurrent parent/index
replacement. The Node capture tests exercise the parent wrapper and existing
static-directory behavior. SEA smoke tests must exercise the embedded helper,
not just `report` dispatch. Linux and macOS release matrix jobs build their own
platform's executable; passing Linux tests does not prove a macOS runtime run.
