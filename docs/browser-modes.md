# Browser modes — two, no silent fallback

- **Service mode (remote browser service):** set `NOISE_BROWSER_WS` to the
  `ws://` endpoint of any Playwright browser server — for example,
  `npx playwright@1.64.1 run-server` prints one (the server's Playwright
  version must match the tool's pinned client version). visual-diff connects
  to that WebSocket endpoint and only that one. If it is set but refused,
  the verb exits 3 — it never falls back to a local browser, and it never
  runs `npx playwright install` on a service host. A config pin is never
  *used* in service mode (but a malformed one still fails config
  validation, exit 2).
- **Native mode (any other host):** the browser is **pinned, not searched
  for**. Discovery is explicit: `import --auto-discover-browser` (or
  `capture --auto-discover-browser`) walks the launch-verified ladder —
  playwright managed cache → system channel → agent-browser CLI — accepts
  the first working rung, and **atomically writes a `browser` pin** into
  `.visual-diff/visual-diff.json` (backend, rung, locator, browserRevision).
  Every later run launch-verifies **exactly the pinned locator** — the
  ladder never re-walks implicitly:
  - no pin and no flag → exit 3, zero probes, with the remedy spelled out;
  - a stale pin (binary deleted/upgraded) → exit 3 with a probe report
    scoped to the pinned locator and `re-run with --auto-discover-browser`;
  - `--auto-discover-browser` under service mode → exit 2 (discovery is a
    native-mode act).
- `--browser <ws|native>` forces the mode for one run (wins over
  `NOISE_BROWSER_WS`); it selects the mode only — it never implies
  discovery. `--browser ws --auto-discover-browser` is a usage error.

The renderer identity (browser build, client version, mode) is recorded in
every provenance record; references imported under one renderer will not
gate-match captures under another. Import and capture in the same mode.

## The browser pin

`browser` in the config is the **tool-managed pin** (native mode) written
by `--auto-discover-browser` — you can read it, diff it, and hand-author
it, but you normally never edit it; re-run the flag to re-pin. Its semantic
fields feed the config hash; `discoveredAt` is observational only. Absent
in service-only projects.

The pin is inspectable, diffable, and hand-authorable JSON. Because the
semantic pin fields feed the config hash (and therefore every state's
per-state hash), swapping the pinned browser invalidates references
deliberately: compare exits 3 naming `inputs.stateConfigHash` (or
`inputs.configHash` for legacy records), and one `import --refresh`
realigns.
