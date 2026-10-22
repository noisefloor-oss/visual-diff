# Development

- `npm test` — full suite. Offline by default; set
  `NOISE_BROWSER_WS` to include the live browser-service tests. Test
  scratch lives under the gitignored in-tree `.tmp/` (per-process
  `run-<pid>` roots via `test/helpers/tmp.mjs`, removed on exit; stale
  roots from killed runs are swept on the next run) — never in `/tmp`.
- Ground truth: `docs/DESIGN.md` (the FR/NFR requirement index cited
  throughout the source and tests).
