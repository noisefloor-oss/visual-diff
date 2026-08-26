/*
 * Comp discovery, naming, and dependency validation (FR-6/FR-7,
 * docs/DESIGN.md §3).
 *
 * Consumes the extracted design-export tree produced by
 * src/unzip.mjs (FR-5). Standalone by design: it depends on the extracted
 * tree's shape only, never on config or the browser.
 *
 * FR-6 — discovery and naming:
 *   Every `.dc.html` file in the tree is a comp. The comp name derives from
 *   the relative path: the filename stem (minus `.dc.html`) sanitized to
 *   `[a-z0-9-]` (`Atlas 5 Mobile.dc.html` → `atlas-5-mobile`).
 *   Collisions are resolved deterministically by suffixing the shortest
 *   distinguishing path segment (root `Atlas.dc.html` keeps
 *   `atlas`; `comps/Atlas.dc.html` becomes `atlas-comps`):
 *     - one file per sanitized base is the primary claimant and keeps the
 *       bare base (the shallowest file, tie-broken by relative path);
 *     - every other member is renamed with the nearest parent directory
 *       segments (nearest first), extended until unique;
 *     - if a member still cannot be distinguished (e.g. `Signin.dc.html`
 *       versus `signin.dc.html` in one directory — the case information is
 *       lost by sanitization), it falls back to a numeric `-2`, `-3`, …
 *       suffix in sorted order. Names are unique tree-wide.
 *   `--only <comp>...` is a pure filtering function (`filterComps`) over the
 *   discovered set; an unknown name is a typed failure, never a silent no-op.
 *
 * FR-7 — declared-dependency validation:
 *   Every `<helmet>` `ext-resource-dependency` declaration must resolve to an
 *   existing path inside the extracted tree before any rendering. A missing,
 *   escaping, or non-relative target is a typed failure (MissingDependencyError),
 *   never a warning.
 *
 *   Assumption (shape): declarations are `<meta name="ext-resource-dependency"
 *   content="<relative-path>" integrity="...">` inside a `<helmet>` element,
 *   per DESIGN §4.2 wording ("`<helmet>` `ext-resource-dependency` meta tags").
 *   The target in `content` is resolved against the comp's own directory, so
 *   `comps/Atlas.dc.html` may declare `../assets/logo.svg`. An SRI
 *   `integrity` attribute is carried through on the record when declared (the
 *   FR-8 vendoring step consumes it later); this module's gate is file resolution
 *   only. Declarations outside `<helmet>` are ignored.
 *
 * FR-10 (discovery half) — screen enumeration:
 *   Screens are elements with `data-screen-label="NN Name"`, 1–13 per comp,
 *   addressed as `<comp>#<sanitized-label>`. Static screens remain direct
 *   `<body>` children and must be `<figure>` elements. Dynamic compositions
 *   use any element directly under `<x-dc>`; hydration preserves the label on
 *   the rendered element. Any other nesting, a non-`<figure>` labeled element
 *   directly under `<body>`, an empty/duplicate label, or a count outside
 *   1–13 raises a typed ScreenStructureError with a clear diagnostic.
 *
 * Parsing uses node builtins only (a small tag scanner over the markup — no
 * DOM library), consistent with the no-new-runtime-dependencies rule.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A comp holds 1–13 screens (DESIGN §3). */
export const SCREEN_LIMITS = Object.freeze({ min: 1, max: 13 });

const COMP_EXT_RE = /\.dc\.html$/i;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9:_-]*/;

// --- Typed failures ---------------------------------------------------------

export class CompsError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** The extracted tree is unreadable or not a directory. */
export class CompTreeError extends CompsError {
  constructor(message, cause) {
    super(message, 'comp-tree', cause);
  }
}

/** Screens do not follow a supported static or dynamic structure. */
export class ScreenStructureError extends CompsError {
  constructor(message) {
    super(message, 'comp-screen-structure');
  }
}

/** A `<helmet>` `ext-resource-dependency` declaration does not resolve. */
export class MissingDependencyError extends CompsError {
  constructor(message) {
    super(message, 'comp-missing-dependency');
  }
}

/** A `--only` name matches no discovered comp. */
export class UnknownCompError extends CompsError {
  constructor(message) {
    super(message, 'comp-not-found');
  }
}

// --- Naming -----------------------------------------------------------------

/**
 * Sanitize a name segment to `[a-z0-9-]`: lowercase, every run of other
 * characters collapses to a single `-`, leading/trailing `-` stripped.
 * May return the empty string for input with no `[a-z0-9]` characters.
 */
export function sanitizeCompName(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('sanitizeCompName expects a string');
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function byDepthThenPath(a, b) {
  if (a.dirSegs.length !== b.dirSegs.length) return a.dirSegs.length - b.dirSegs.length;
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

/*
 * First candidate not already claimed: bare base, then base suffixed with
 * nearest-first parent segments (one, two, …), then a numeric `-2` tail.
 * `taken` is the set of names already assigned tree-wide.
 */
function pickCandidate(base, dirSegs, taken) {
  for (let k = 0; k <= dirSegs.length; k += 1) {
    const suffix = dirSegs.slice(0, k).join('-');
    const candidate = suffix === '' ? base : `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/*
 * Assign a deterministic, tree-wide-unique name to every comp relative path.
 * Pass 1 gives each sanitized-base group its bare base to the shallowest
 * member; pass 2 disambiguates the rest with shortest distinguishing parent
 * segments. Numeric tails never collide with another group's bare base
 * because all primaries claim their bases first.
 */
function assignCompNames(files) {
  const groups = new Map();
  for (const relPath of files) {
    const parts = relPath.split('/');
    const stem = parts[parts.length - 1].replace(COMP_EXT_RE, '');
    const base = sanitizeCompName(stem) || 'comp';
    const dirSegs = parts
      .slice(0, -1)
      .map((seg) => sanitizeCompName(seg))
      .filter((seg) => seg !== '')
      .reverse(); // nearest-first
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ relPath, dirSegs });
  }

  const taken = new Set();
  const nameOf = new Map();
  const bases = [...groups.keys()].sort();

  for (const base of bases) {
    const members = groups.get(base).sort(byDepthThenPath);
    const primary = members[0];
    nameOf.set(primary.relPath, base);
    taken.add(base);
  }
  for (const base of bases) {
    for (const member of groups.get(base).sort(byDepthThenPath).slice(1)) {
      const assigned = pickCandidate(base, member.dirSegs, taken);
      nameOf.set(member.relPath, assigned);
      taken.add(assigned);
    }
  }
  return nameOf;
}

// --- Tree walking -----------------------------------------------------------

function collectCompFiles(treeRoot) {
  let st;
  try {
    st = statSync(treeRoot);
  } catch {
    throw new CompTreeError(`cannot read extracted tree: ${treeRoot}`);
  }
  if (!st.isDirectory()) {
    throw new CompTreeError(`extracted tree root is not a directory: ${treeRoot}`);
  }

  let entries;
  try {
    entries = readdirSync(treeRoot, { recursive: true, encoding: 'utf8' });
  } catch (err) {
    throw new CompTreeError(`cannot walk extracted tree ${treeRoot}: ${err.message}`, err);
  }

  const files = [];
  for (const entry of entries) {
    if (!COMP_EXT_RE.test(entry)) continue;
    const posixPath = entry.split(sep).join('/');
    let st;
    try {
      st = statSync(join(treeRoot, ...posixPath.split('/')));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files.push(posixPath);
  }
  files.sort();
  return files;
}

// --- Dependency validation (FR-7) ------------------------------------------

/**
 * Parse `<helmet>` `ext-resource-dependency` declarations out of a comp's
 * markup. Returns `[{ target, integrity }]`; `integrity` is `undefined` when
 * the declaration carries no SRI hash. A declaration without a `content`
 * target is a typed failure.
 */
export function parseDependencyDeclarations(html, { path: displayPath = '<comp>' } = {}) {
  if (typeof html !== 'string') {
    throw new TypeError('parseDependencyDeclarations expects an HTML string');
  }
  const deps = [];
  let inHelmet = false;
  for (const tok of scanHtml(html)) {
    if (tok.type === 'close' && tok.name === 'helmet') {
      inHelmet = false;
      continue;
    }
    if (tok.type !== 'open') continue;
    if (tok.name === 'helmet') {
      inHelmet = !tok.selfClosing;
      continue;
    }
    if (!inHelmet) continue;
    if (tok.name !== 'meta') continue;
    if (String(tok.attrs.get('name')).toLowerCase() !== 'ext-resource-dependency') continue;
    const target = tok.attrs.get('content');
    if (typeof target !== 'string' || target.trim() === '') {
      throw new MissingDependencyError(
        `${displayPath}: ext-resource-dependency declaration without a content target`,
      );
    }
    const integrity = tok.attrs.has('integrity') ? String(tok.attrs.get('integrity')) : undefined;
    deps.push({ target: target.trim(), integrity });
  }
  return deps;
}

/*
 * FR-7 gate: every declared target must resolve to an existing file or
 * directory inside the extracted tree, relative to the comp's own directory.
 * Non-relative targets (URLs, absolute paths) and `..` escapes are typed
 * failures — the declaration must name something the tree actually serves.
 */
function validateDependencyTarget(treeRoot, compRelPath, target, displayPath) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/')) {
    throw new MissingDependencyError(
      `${displayPath}: declared dependency ${JSON.stringify(target)} is not a relative path ` +
        '— FR-7 requires a target that resolves inside the extracted tree',
    );
  }
  const resolved = resolve(treeRoot, dirname(compRelPath), target);
  const rel = relative(treeRoot, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new MissingDependencyError(
      `${displayPath}: declared dependency ${JSON.stringify(target)} resolves outside the extracted tree`,
    );
  }
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new MissingDependencyError(
      `${displayPath}: declared dependency ${JSON.stringify(target)} does not exist in the extracted tree ` +
        `(searched from export root ${treeRoot} — a wrong-directory-level zip is the usual cause)`,
    );
  }
  if (!st.isFile() && !st.isDirectory()) {
    throw new MissingDependencyError(
      `${displayPath}: declared dependency ${JSON.stringify(target)} is neither a file nor a directory`,
    );
  }
}

/**
 * Parse and validate a comp's `<helmet>` dependency declarations. Returns the
 * validated declaration records; throws MissingDependencyError on the first
 * target that does not resolve.
 */
export function validateDependencies(html, treeRoot, compRelPath, { path: displayPath } = {}) {
  if (typeof treeRoot !== 'string' || typeof compRelPath !== 'string') {
    throw new TypeError('validateDependencies expects treeRoot and compRelPath strings');
  }
  const label = displayPath ?? compRelPath;
  const declared = parseDependencyDeclarations(html, { path: label });
  for (const dep of declared) {
    validateDependencyTarget(treeRoot, compRelPath, dep.target, label);
  }
  return declared;
}

// --- Screen enumeration (FR-10 discovery half) ------------------------------

/**
 * Enumerate a comp's screens via `[data-screen-label]`. Returns
 * `[{ label, id, variableSize? }]` in document order where `id` is the label
 * sanitized to `[a-z0-9-]` (the screen half of `<comp>#<screen-label>`
 * addressing). A screen carrying the boolean `data-screen-variable-size`
 * attribute reports `variableSize: true` — the author's opt-out of the
 * importer's uniform-device-dimensions assertion. Unrecognized
 * nesting or a count outside 1–13 is a ScreenStructureError.
 */
export function enumerateScreens(html, { path: displayPath = '<comp>', allowEmpty = false } = {}) {
  if (typeof html !== 'string') {
    throw new TypeError('enumerateScreens expects an HTML string');
  }
  const screens = [];
  const seen = new Set();
  const stack = [];
  for (const tok of scanHtml(html)) {
    if (tok.type === 'open') {
      if (tok.attrs.has('data-screen-label')) {
        const label = String(tok.attrs.get('data-screen-label'));
        const parent = stack.at(-1);
        const staticScreen = parent?.name === 'body' && tok.name === 'figure';
        // Inside <x-dc> a screen may sit under layout wrappers. A comp of one
        // screen puts it at the root; a comp of twelve lays them out in a
        // grid, and the wrapper is review-page furniture with no bearing on
        // what a screen is. What still may not nest is a screen inside a
        // screen — that is the case the label would address ambiguously.
        const inDc = stack.some((frame) => frame.name === 'x-dc');
        const inScreen = stack.some((frame) => frame.screen === true);
        const dynamicScreen = inDc && !inScreen;
        if (inScreen) {
          throw new ScreenStructureError(
            `${displayPath}: <${tok.name} data-screen-label> is nested inside another screen — ` +
              'screens may not nest; each label must address exactly one screen',
          );
        }
        if (parent?.name === 'body' && tok.name !== 'figure') {
          throw new ScreenStructureError(
            `${displayPath}: data-screen-label on <${tok.name}> directly under <body> — ` +
              'static screens must use <figure data-screen-label>',
          );
        }
        if (!staticScreen && !dynamicScreen) {
          const where = parent === undefined ? 'the document root' : `a <${parent.name}>`;
          throw new ScreenStructureError(
            `${displayPath}: screen element not a supported direct child — ` +
              `<${tok.name} data-screen-label> sits under ${where}; screens must be either ` +
              'a <figure> directly under <body>, or any element inside <x-dc> ' +
              '(layout wrappers between <x-dc> and the screen are fine)',
          );
        }
        if (label.trim() === '') {
          throw new ScreenStructureError(
            `${displayPath}: screen <${tok.name}> has an empty data-screen-label`,
          );
        }
        const id = sanitizeCompName(label);
        if (id === '') {
          throw new ScreenStructureError(
            `${displayPath}: screen label ${JSON.stringify(label)} does not sanitize to [a-z0-9-]`,
          );
        }
        if (seen.has(label)) {
          throw new ScreenStructureError(
            `${displayPath}: duplicate screen label ${JSON.stringify(label)}`,
          );
        }
        seen.add(label);
        const variableSize = tok.attrs.has('data-screen-variable-size');
        screens.push(variableSize ? { label, id, variableSize: true } : { label, id });
        stack.push({ name: tok.name, screen: true });
        continue;
      }
      stack.push({ name: tok.name });
    } else if (tok.type === 'close') {
      const idx = stack.map((frame) => frame.name).lastIndexOf(tok.name);
      if (idx >= 0) stack.splice(idx);
      else stack.pop(); // tolerate a stray close, like a browser
    }
  }
  // With allowEmpty a screenless comp enumerates as [] instead of
  // failing — the importer decides (config-referenced comps still fail).
  if (screens.length === 0 && allowEmpty) return screens;
  if (screens.length < SCREEN_LIMITS.min || screens.length > SCREEN_LIMITS.max) {
    throw new ScreenStructureError(
      `${displayPath}: expected ${SCREEN_LIMITS.min}–${SCREEN_LIMITS.max} screens via ` +
        `[data-screen-label], found ${screens.length}`,
    );
  }
  return screens;
}

// --- Discovery --------------------------------------------------------------

/**
 * Restrict a discovered comp set to the named `--only` comps (FR-6). Returns
 * the subset in input order. Empty `only` returns everything. A name with no
 * match is a typed UnknownCompError listing the unknown names — a typo must
 * never silently import nothing.
 */
export function filterComps(comps, only) {
  if (!Array.isArray(only) || only.some((n) => typeof n !== 'string')) {
    throw new TypeError('only must be an array of comp name strings');
  }
  const wanted = [...new Set(only)];
  if (wanted.length === 0) return comps;
  const byName = new Map(comps.map((c) => [c.name, c]));
  const missing = wanted.filter((n) => !byName.has(n)).sort();
  if (missing.length > 0) {
    throw new UnknownCompError(
      `no discovered comp named ${missing.map((n) => JSON.stringify(n)).join(', ')}`,
    );
  }
  const wantedSet = new Set(wanted);
  return comps.filter((c) => wantedSet.has(c.name));
}

/**
 * Walk an extracted design-export tree and discover its comps.
 *
 * `treeRoot` is the extraction directory (FR-5 output). Returns comp records
 * `{ name, path, screens, dependencies }` sorted by name:
 *   - `name`         — sanitized, collision-free comp name (FR-6);
 *   - `path`         — posix relative path from the tree root;
 *   - `screens`      — `[{ label, id }]` from supported `[data-screen-label]` elements;
 *   - `dependencies` — validated `<helmet>` declaration records (FR-7).
 *
 * `options.only` applies the `--only` restriction before any comp is read, so
 * a broken comp outside the selection never blocks the selected import.
 * Collision resolution is tree-wide regardless of the filter: names are
 * stable identities, not selection-scoped.
 */
export function discoverComps(treeRoot, { only = [] } = {}) {
  if (typeof treeRoot !== 'string' || treeRoot.length === 0) {
    throw new TypeError('treeRoot must be a non-empty string');
  }
  const files = collectCompFiles(treeRoot);
  const nameOf = assignCompNames(files);
  const discovered = files.map((path) => ({ name: nameOf.get(path), path }));
  const selected = filterComps(discovered, only);

  const comps = selected.map(({ name, path }) => {
    const html = readFileSync(join(treeRoot, ...path.split('/')), 'utf8');
    // allowEmpty — a screenless comp (type specimen sheet) is a
    // discovery result, not a structural failure; import decides its fate.
    const screens = enumerateScreens(html, { path, allowEmpty: true });
    // A screenless comp is never rendered, so its helmet
    // dependencies are never fetched — validating them here would abort the
    // import on a comp that is about to be skipped.
    const dependencies = screens.length === 0 ? [] : validateDependencies(html, treeRoot, path);
    return { name, path, screens, dependencies, ...(screens.length === 0 ? { screenless: true } : {}) };
  });
  comps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return comps;
}

// --- Minimal HTML tag scanner (node builtins only) --------------------------

/*
 * A deliberately small scanner: it emits element open/close tokens with parsed
 * attributes, skipping comments, CDATA, doctypes, and the raw-text content of
 * script/style/textarea/title/xmp so fake markup inside scripts or comments
 * can never count as a screen or a declaration.
 */
function scanHtml(html) {
  const tokens = [];
  const len = html.length;
  let i = 0;
  const rawStack = [];

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (rawStack.length > 0) {
      const top = rawStack[rawStack.length - 1];
      const close = html.indexOf(`</${top}`, lt);
      if (close === -1) break;
      const end = html.indexOf('>', close);
      if (end === -1) break;
      tokens.push({ type: 'close', name: top, pos: close });
      rawStack.pop();
      i = end + 1;
      continue;
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);

    if (raw.startsWith('/')) {
      const name = parseTagName(raw.slice(1));
      if (name !== null) tokens.push({ type: 'close', name, pos: lt });
      i = gt + 1;
      continue;
    }

    const parsed = parseOpenTag(raw);
    if (parsed === null) {
      i = gt + 1;
      continue;
    }
    tokens.push({
      type: 'open',
      name: parsed.name,
      attrs: parsed.attrs,
      selfClosing: parsed.selfClosing,
      pos: lt,
    });
    if (RAW_TEXT_TAGS.has(parsed.name) && !parsed.selfClosing) {
      rawStack.push(parsed.name);
    }
    i = gt + 1;
  }
  return tokens;
}

// The tag end is quote-aware so a `>` inside an attribute value (rare, but
// legal in exported markup) does not truncate the tag.
function findTagEnd(html, start) {
  let i = start + 1;
  let quote = null;
  while (i < html.length) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseTagName(input) {
  const m = TAG_NAME_RE.exec(input);
  return m === null ? null : m[0].toLowerCase();
}

function parseOpenTag(raw) {
  const m = TAG_NAME_RE.exec(raw);
  if (m === null) return null;
  const name = m[0].toLowerCase();
  let rest = raw.slice(m[0].length);
  let selfClosing = false;
  const trimmed = rest.trimEnd();
  if (trimmed.endsWith('/')) {
    selfClosing = true;
    rest = trimmed.slice(0, -1);
  }
  return { name, attrs: parseAttrs(rest), selfClosing };
}

function parseAttrs(input) {
  const attrs = new Map();
  const len = input.length;
  let i = 0;
  while (i < len) {
    while (i < len && /\s/.test(input[i])) i += 1;
    if (i >= len) break;
    if (input[i] === '/') {
      i += 1;
      continue;
    }
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(input[i])) i += 1;
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const name = input.slice(nameStart, i).toLowerCase();
    while (i < len && /\s/.test(input[i])) i += 1;
    let value = true;
    if (i < len && input[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(input[i])) i += 1;
      if (i < len && (input[i] === '"' || input[i] === "'")) {
        const quote = input[i];
        i += 1;
        const end = input.indexOf(quote, i);
        if (end === -1) {
          value = input.slice(i);
          i = len;
        } else {
          value = input.slice(i, end);
          i = end + 1;
        }
      } else {
        const valueStart = i;
        while (i < len && !/[\s>]/.test(input[i])) i += 1;
        value = input.slice(valueStart, i);
      }
    }
    attrs.set(name, value);
  }
  return attrs;
}
