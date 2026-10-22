# The provenance gate

The provenance gate (exit 3) requires reference and capture to agree on
renderer identity (browser build, client version, mode, backend), device
scale factor, readiness policy/timeout/settle, vendor hashes, and the
per-state config hash; viewport (width/height/fullPage) is gated for
unclipped states only — a clipped state frames one element, and its output
dimensions are checked by the pixel path instead. Fonts are recorded in
provenance for diagnosis but are not gated. This is what makes a "pass" mean "same renderer, same
conditions" rather than a coincidence. Keep the state viewport at the
reference default (1502×818, DSF 2).

The config hash is compared **per state**: every record carries
`inputs.stateConfigHash`, the
hash of the whole-config projection minus the *other* states, so editing
one state's route — or adding a state — invalidates only that state's
references and captures, never the rest. The browser pin is shared, so
re-pinning still moves every state's hash. The whole-config
`inputs.configHash` is still recorded as the run-level fingerprint, and it
remains the gate's **fallback**: a record written before the per-state
field existed (or a reference record for a screen shared by several
states, which cannot honestly name one state's hash) is compared on the
whole-config hash, exactly as before — old records neither pass silently
nor invalidate en masse.
