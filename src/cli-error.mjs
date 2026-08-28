// The stderr failure line every CLI boundary writes (DESIGN §4.1, FR-3/FR-4a).
//
// The machine interface of this tool is the exit code plus `--json` on the
// read verbs. Exit codes are a five-value alphabet, so a failing run tells an
// agent only which bucket it landed in — the reason used to live in the
// English message, and pattern-matching English prose is exactly the brittle
// habit this tool exists to replace. Every typed failure carries a stable
// `err.code` (ImportError, CaptureError, CompareError, ConfigError,
// ProvenanceError, ReportError, RunError, RenderError, ZipError,
// BrowserResolutionError, LayoutError, CompsError and their subclasses), and
// the refusals that used to write a bare string now name a code at the write
// site. This module is the one place that renders it.
//
// Format, uniform across every verb:
//
//   noise visual-diff <verb> [<code>]: <message>
//
// The code sits INSIDE the prefix, before the colon that separates prefix from
// message. That placement is what makes the token trustworthy: the message
// begins after `: `, so no message — however hostile, however it was worded
// before this existed — can produce a line that parses as a coded one.
// Bracketing the code after the colon would have been ambiguous, because a
// legacy message such as `[frame-truncated] fabricated` renders identically to
// a real coded failure. Here it cannot: it prints after the colon, where a
// code never appears.
//
// A failure report may be several physical lines — the browser-resolution
// probe report is deliberately multi-line (FR-28). Only the FIRST line carries
// the prefix and the code; the renderer indents every continuation line, so a
// continuation can never begin at column 0 and can never parse as a coded
// line. That is what closes the forgery hole a verbatim interpolation would
// leave open: a message containing "\nnoise visual-diff capture [x]: forged"
// emits that text indented, as the message body it is.
//
// Consequences the contract depends on:
// - a line matching the ANCHORED coded-head grammar is always a real failure
//   head. The guarantee is about that grammar, not about the bare token: a
//   fixed-string search for `[frame-truncated]` is not column-anchored, so it
//   also hits the token quoted inside a message body. Agents match the head
//   pattern (`^noise visual-diff <verb> \[<code>\]: `), not a substring;
// - a failure with no code prints `<prefix>: <message>` — its first line byte
//   for byte the line it printed before this existed;
// - continuation lines are indented by CONTINUATION_INDENT, coded or not (the
//   indent is what makes them unmatchable, so it cannot be conditional);
// - the code is lexically constrained (CODE_RE), so it cannot contain a
//   bracket, whitespace, or a newline and can never break the one-line
//   grammar. A value that does not fit renders as no code at all rather than
//   as a malformed one.
// - stdout is untouched: `--json` documents are byte-identical, and there is
//   no JSON error surface to add the code to (a refusal under `--json` leaves
//   stdout empty by design).

/**
 * Every non-empty continuation line of a multi-line failure report is indented
 * by this, so no line of a message can begin at column 0. The renderer applies
 * it — never the call sites — because the guarantee is what the grammar rests
 * on. An empty continuation line is left empty: it carries no text, so it
 * cannot pose as a failure head, and indenting it would only add trailing
 * whitespace.
 */
export const CONTINUATION_INDENT = '  ';

/**
 * Every line terminator that could start a new line for a consumer, matched
 * with CRLF as one unit. This is the union of what ECMAScript recognizes (LF,
 * CRLF, CR, U+2028, U+2029 — splitting on LF alone is NOT enough: a lone CR
 * or a U+2028 starts a line for a JS regex with `m`) and the wider set
 * Python's `str.splitlines()` recognizes (adding VT, FF, FS, GS, RS, NEL) —
 * because the consumers of this output are agents, and an agent splitting
 * stderr in Python must see the same line structure a JS one does. A
 * terminator outside this set is, for every reader in question, ordinary text.
 */
export const LINE_TERMINATORS = /(\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029])/;

/**
 * The lexical grammar of a code. Both families in use fit it and nothing else
 * does: kebab (`frame-truncated`, `png-decode`) and SCREAMING_SNAKE
 * (`PROVENANCE_TAMPER`, and Node's own errnos such as `EACCES`). It is a
 * grammar, not an allowlist, precisely so a new typed failure surfaces without
 * anyone remembering to register it — while a value that is not a code
 * (a sentence, a path, an object's stray `code` field) is refused.
 */
export const CODE_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/;

/**
 * The stable code an error carries, or null when it carries none that fits the
 * grammar. Typed failures set a documented code; Node system errors carry
 * their errno and are surfaced verbatim — the token is always whatever the
 * error itself declares, never a value invented here.
 */
export function errorCode(err) {
  const code = err && err.code;
  return typeof code === 'string' && CODE_RE.test(code) ? code : null;
}

/**
 * Render one failure report from a code known at the write site:
 * `<prefix> [<code>]: <message>\n`. A code that does not fit CODE_RE is
 * dropped rather than printed malformed, and every line of `message` after the
 * first is indented so that no continuation can pose as a failure head.
 *
 * @param {string} prefix   e.g. `noise visual-diff compare`
 * @param {string|null} code
 * @param {string} message
 */
export function codedLine(prefix, code, message) {
  const token = typeof code === 'string' && CODE_RE.test(code) ? ` [${code}]` : '';
  // split(/(sep)/) keeps the separators, so every terminator survives verbatim
  // — nothing is normalized or reflowed — and the indent lands immediately
  // after each one, which is the only position that matters.
  const parts = String(message).split(LINE_TERMINATORS);
  let body = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i + 1] ?? '';
    body += parts[i] + (text === '' ? '' : CONTINUATION_INDENT + text);
  }
  return `${prefix}${token}: ${body}\n`;
}

/**
 * Render one failure line for an error object, degrading to the uncoded
 * `<prefix>: <message>` when the error carries no usable code.
 *
 * @param {string} prefix   e.g. `noise visual-diff compare`
 * @param {unknown} err     the failure being reported
 * @param {string} message  the text to print (defaults to `err.message`)
 */
export function errorLine(prefix, err, message = err && err.message ? err.message : String(err)) {
  return codedLine(prefix, errorCode(err), message);
}
