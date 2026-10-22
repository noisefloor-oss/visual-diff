// Static reader of the tool's error-raising surface, on a real parser.
//
// STRATEGY: reject what cannot be proved. Three regex-based generations of this
// reader each shipped a new hole — a shadowed catch binding, a reassigned one,
// `new Map()` counted as an error construction, `||=`, computed member keys,
// `static code`, two re-export forms — because tracking bindings, scopes,
// shadowing and re-export chains is what a parser does, and a pattern matcher
// only ever approximates it. This version parses (acorn, exact-pinned
// devDependency under NFR-4, never imported from src/) and resolves:
//
//   - SCOPES and BINDINGS. Every function, block and catch clause opens a
//     scope; an identifier resolves to the binding that is actually in scope, so
//     an inner `err` is a different binding from the `err` of an enclosing
//     catch. Writes are recorded against NAME plus scope during the walk and
//     resolved to bindings AFTER it, when every declaration in scope exists —
//     a write inside an earlier function body may target a binding declared
//     later (`function f(){ F = …; } class F …`). Every WRITE to a binding is
//     recorded — `=`, `||=`, `&&=`, `??=`, `+=`, `++`/`--`, a destructuring
//     assignment target (`({ err } = payload)`), and a `for (err of …)` loop
//     target alike — and a
//     pattern write never proves its binding, since destructuring a
//     construction yields its properties, not the error. A repeated
//     declaration in one scope (`var alias = e; var alias;`, a redeclared
//     function) keeps ONE binding object — the runtime truth — with every
//     initializer recorded as a write against it. A write to the VALUE a
//     binding holds — `err.code = …`, any deeper member chain rooted at it, a
//     MEMBER destructuring target (`({ code: err.code } = …)`), a bare member
//     loop target (`for (err.code of …)`), `delete
//     err.code`, `Object.assign(err, …)` — invalidates the binding's proof
//     exactly like a rebinding, and because `const alias = err` — or a
//     destructured extraction like `const { x: alias } = { x: err }`, in a
//     declaration or a bare assignment alike, following LAST-wins key
//     precedence — or a CONTAINER literal holding a binding
//     (`const holder = { x: err }`, so `holder.x.code = …` reaches err) —
//     makes two
//     bindings name the SAME object, a mutation through any alias invalidates
//     the whole alias group. Identity and CONTAINMENT are distinct link kinds:
//     a container (`const holder = { x: err }`, `holder.x = err`, or a store
//     through any expression root like `[holder][0].x = e`) propagates
//     only DEEP writes (`holder.x.code = …`) to its contents — a shallow store
//     replaces a slot without touching what was there. A member write may be
//     rooted at an EXPRESSION (`[e][0].code = …`, `(0, e).code = …`,
//     `(c ? e : null).code = …`, `(a = e).code = …`): the root resolves through
//     the same value machinery, mutating every binding it may refer to. An
//     unprovable root refuses the write outright; a root that crosses a call
//     boundary (`f().code = …`) is the ceiling's — named below, not refused.
//     Object.assign/defineProperty
//     targets resolve identically, member-valued targets (`holder.x`,
//     `[e][0]`, a container holding `this`) included. A destructuring extraction the reader cannot
//     prove — a spread or computed key in the initializer, a default, a rest
//     element, a computed key in the pattern — is REFUSED at the declaration,
//     never silently unlinked. A `var` initializer inside a catch block whose
//     name matches the catch parameter assigns the CATCH binding at runtime —
//     destructured targets included (`var { x: e } = …`, `var [e] = …`) —
//     and so does a loop variable's iteration write (`for (var e of …)`,
//     pattern targets included): the write is recorded against the binding the
//     site resolves, while the hoisted declaration is retained. An extracted
//     CONTAINER keeps its literal's identity (`const { x: holder } =
//     { x: { y: err } }`), so a member write on it reaches the held value.
//     Iteration targets link through their iterable the same way: a literal
//     (spreads of provable iterables expanded, holes index-preserving) or an
//     unreassigned identifier holding one resolves — and every element carries
//     the SCOPE it was written in, so an inner shadow cannot hijack the link.
//     A member-path source (`holder.inner`) resolves its property path into an
//     unreassigned literal container — and so does a member-VALUED source
//     element (`const { x: alias } = { x: holder.x }`, `const [alias] =
//     [holder.x]`, `const box = { y: holder.x }`); a member read whose root is
//     a parameter, import, call result or extraction target reads the CALLER's
//     data — the documented ceiling; only a local literal container whose path
//     does not resolve (a computed key may select a held binding) is
//     unprovable. Value expressions link their whole provable reference set:
//     conditionals and logicals link the union of their arms, a sequence its
//     last element, `await` its argument, an assignment its right-hand side;
//     literals, templates, unary/binary expressions and fresh callables hold
//     nothing tracked. Anything unresolved registers as an unprovable alias
//     source. Anything else — and any destructuring init that
//     does not resolve to a literal container — is an unprovable alias source,
//     REFUSED when a target binding is later mutated (an unmutated target can
//     hold anything; nothing propagates). (Rebinding an alias does not propagate: that
//     changes what the alias names, not the object. A value handed to an
//     arbitrary CALL may still be mutated there; interprocedural mutation is
//     beyond this reader and is named in the test file's ceiling.) A `var`
//     installs in the nearest function or module scope, as hoisting demands —
//     its binding keeps the declarator's own scope for resolving the
//     initializer. Only a SIMPLE catch identifier is "the caught error"; a
//     destructured catch property (`catch ({ nested: e })`) is an extracted
//     value with its own proof to make. `arguments[i] = …` rewrites the
//     enclosing function's parameters, so it invalidates them all. A REASSIGNED
//     class or function declaration binding (`class F …; F = …`) voids the
//     declaration's proof for constructions, inheritance, and return paths.
//     A module that fails to parse, and any direct `eval(…)`, is refused
//     outright.
//   - PARAMETER DEFAULTS AND DECLARATION PATTERNS. Default initializers are
//     executable code and are walked in scope — in function parameters, in
//     variable-declaration patterns (`const { x = f() } = …`), in computed
//     pattern keys, and in catch patterns — so a sink or raise inside any of
//     them enters the gate.
//   - CONSTRUCTIONS. `new X(...)` resolves X through the scope chain and, when
//     it is imported, across modules to its declaration. A superclass resolves
//     in the scope where the class is DECLARED, so a function-scoped
//     `class Base extends Error {}` parent is found. Built-in names are only
//     built-ins when NO local binding shadows them (`class Error {…}` in scope
//     is a declaration, not the language Error). The verdict is three-valued:
//     PROVED error class (the chain reaches a built-in Error, through an
//     unreassigned `const Parent = Error` alias included), PROVED not one
//     (`new Map()`, a class with no extends), or UNKNOWN — an unresolvable or
//     computed extends — and UNKNOWN is refused, never skipped. A
//     proved-non-error class is still read for a code slot, because errorCode
//     reads `code` off any thrown value.
//   - CODE MEMBERS. A class's code is read from its instance members only: a
//     non-computed `code` assignment in the constructor, a non-computed
//     `get code()`, or a non-computed instance field. `static code` is not the
//     instance's code and is never read as one. Any computed member key makes
//     the class unprovable, because a computed key may be `code`. Runtime
//     precedence decides between competing declarations, so the class is
//     unprovable when `code` is written more than once in the constructor,
//     written with a compound operator, written anywhere but the constructor
//     body, written opaquely (`Object.assign(this, …)`, a destructuring target
//     rooted at `this`, a deeper `this.a.b = …` chain, or a mutation through a
//     `this` alias like `const self = this`), declared both as a member and in
//     the constructor, or named by a method or setter. A
//     constructor that RETURNS a non-primitive replaces the instance at
//     runtime, so it is unprovable too. A constructor write's right-hand side
//     resolves by BINDING at the write: a reassigned or shadowed `code`
//     parameter is not the caller's argument. And a subclass whose super()
//     call does not provably supply the parent's code slot is unprovable —
//     the parent's argument slot describes the parent's callers, not the
//     subclass's. The parent is consulted even when the subclass declares its
//     own slot: an ancestor constructor that RETURNS an object replaces the
//     instance wholesale, so an unprovable parent poisons the subclass.
//     A spread at or before a positional code slot shifts the arguments, so
//     such a call is refused — at constructions, forwarders, and sinks alike.
//   - RE-EXPORTS. Export chains are followed to their definition, including
//     `export { x as default } from …` and a local export list re-exporting an
//     imported binding. Namespace re-exports (`export * as nsx from …`, or a
//     list re-export of a namespace import) resolve to the namespace itself,
//     so a member call through them reaches the export. Sink CALLS resolve
//     the same way: the import binding, a const-alias chain of it, a
//     namespace member call (`renderer.codedLine(…)`), a namespace ALIAS
//     (`const ns2 = ns; ns2.codedLine(…)`), a member extracted into a const
//     (`const f = ns.codedLine`), a namespace destructuring extraction
//     (`const { codedLine: s2 } = ns`), an awaited literal dynamic import
//     (`(await import('…')).codedLine(…)`), and an exported const alias
//     (`export const x = codedLine`) all resolve to the sink by binding. The
//     renderer invoked through `.call` shifts the code position by one;
//     through `.apply`/`.bind` or as a template tag the call is refused.
//   - THE RENDERER NEVER ESCAPES. Those are the ONLY positions the renderer —
//     or a namespace carrying it — may stand in, plus an export. Anywhere
//     else (a call argument, a literal, a class field, a return, a right-hand
//     side, a `let`/`var` declarator, a conditional arm, `typeof`, `new`, a
//     computed namespace member, an un-awaited `import()`) the reference is
//     REFUSED where it escapes. A callee that is not import-rooted is then
//     provably not the renderer and is not resolved: there is no container,
//     store, field, getter or return-path machinery for the renderer at all.
//     A dynamic `import()` with a non-literal specifier, and a static or
//     literal-dynamic import of a repository module OUTSIDE the scanned tree,
//     are refused for the same reason: what they load is not checked here.
//   - THROWN OBJECTS. A spread (`throw { ...x, code: 'y' }`), a duplicate
//     `code` key, or a `__proto__` initializer (which may install an INHERITED
//     code) decides the carried code by runtime rules this reader does not
//     model, so all three are
//     refused rather than read partially. The same holds for an options bag
//     handed to a constructor.
//   - THROWN CALLS. `throw f()` throws what f RETURNS, so every return path of
//     f must prove its value: an enumerated construction, a binding proved
//     like a thrown identifier, a call whose own returns are proved, or a
//     value with no code slot (a literal, a fresh array or function,
//     undefined; an async function's Promise, a generator's iterator). A
//     returned parameter substitutes the call's argument, proved at the call
//     site — which makes the proof CALL-DEPENDENT, so it is never cached per
//     function, and a spread at or before the parameter's position shifts the
//     arguments, so such a call proves nothing. A construction that merely
//     HAPPENS in f's body proves nothing
//     about the returned value. A function may forward SEVERAL code positions
//     from several constructions; each position is resolved on its own. All
//     callers — of forwarders and of thrown calls alike — are matched by
//     resolved function IDENTITY, never by spelling, so a renamed import
//     (`import { make as renamed }`) or a const alias names the same function
//     under another local name.
//
// The rule is unchanged: a code counts only when the WHOLE code expression is a
// string literal (or an identifier bound to a module-level `const X = '…'`);
// anything unprovable is UNRECOGNIZED with file:line and text, and the reviewed
// sites list in test/error-codes.test.mjs is the only escape.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve as resolvePath } from 'node:path';
import { parse } from 'acorn';

const BUILTIN_ERRORS = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError', 'URIError', 'AggregateError',
]);

// Constructors proved not to be error classes without a declaration to resolve
// (built-ins and pinned dependencies' classes). An identifier missing from here
// that resolves to no declaration fails the gate rather than being assumed
// harmless.
// Constructors proved not to be error classes without a declaration to resolve
// (built-ins and pinned dependencies' classes). An identifier missing from here
// that resolves to no declaration fails the gate rather than being assumed
// harmless. Proxy and Object are deliberately NOT here: a Proxy trap can
// invent a `code`, and `new Object(x)` returns x — neither is provably
// codeless, so constructions of them are refused. Function compiles invisible
// code in both spellings, so both `Function(…)` and `new Function(…)` are
// refused; the two sandbox snippets in src/capture.mjs are reviewed sites.
const NON_ERROR_CONSTRUCTORS = new Set([
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Promise', 'URL', 'URLSearchParams',
  'Uint8Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'Buffer',
  'TextDecoder', 'TextEncoder', 'AbortController', 'Array',
  'PNG',
]);

// The renderer that prints a code with no error object (FR-4a's coded
// refusals). Identified by module and export; each caller's import binding
// decides what it is called there.
const CODE_SINKS = [{ module: 'src/cli-error.mjs', exported: 'codedLine', index: 1 }];

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', locations: true };

function* walkMjs(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walkMjs(p);
    else if (entry.endsWith('.mjs')) yield p;
  }
}

/** Every child node of an AST node, in source order. */
function* children(node) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') yield item;
    } else if (value && typeof value.type === 'string') yield value;
  }
}

const isString = (node) => node !== null && node !== undefined && node.type === 'Literal' && typeof node.value === 'string';
/** The name of a member key, or null when it is computed and not a literal. */
function staticKey(node) {
  if (!node.computed) return node.key.type === 'Identifier' ? node.key.name : (isString(node.key) ? node.key.value : null);
  return isString(node.key) ? node.key.value : null;
}
const isComputedUnknown = (node) => node.computed && !isString(node.key);
/** The name a member expression reads (`a.b`, `a['b']`), or null. */
const memberKey = (expr) => (expr.computed
  ? (isString(expr.property) ? expr.property.value : null)
  : (expr.property.type === 'Identifier' ? expr.property.name : null));

class Scope {
  constructor(parent, kind, node) {
    this.parent = parent;
    this.kind = kind; // 'module' | 'function' | 'block' | 'catch'
    this.node = node;
    this.bindings = new Map();
  }
  declare(name, binding) {
    this.bindings.set(name, binding);
    return binding;
  }
  lookup(name) {
    for (let s = this; s !== null; s = s.parent) {
      const b = s.bindings.get(name);
      if (b !== undefined) return b;
    }
    return null;
  }
}

/** Does any recorded write mutate the value a binding's group holds?
 * Identity-linked bindings denote the SAME object — any member write counts.
 * A CONTAINER joins the group in 'container' mode: only a DEEP write on it
 * (`holder.x.code = …`, never a shallow `holder.x = …` store) reaches the held
 * value. Containers of containers join transitively. */
function mutationReaches(mod, binding) {
  if (binding === null || binding === undefined) return false;
  const seenIdentity = new Set();
  const seenContainer = new Set();
  const queue = [[binding, 'identity']];
  const push = (b, mode) => {
    if (b === null || b === undefined) return;
    const seen = mode === 'identity' ? seenIdentity : seenContainer;
    if (seen.has(b)) return;
    seen.add(b);
    queue.push([b, mode]);
  };
  while (queue.length > 0) {
    const [b, mode] = queue.pop();
    for (const w of mod.assignmentsByBinding.get(b) ?? []) {
      if (w.kind === 'mutate' && (mode === 'identity' || w.deep === true)) return true;
    }
    for (const linked of mod.aliasLinks?.get(b) ?? []) push(linked, mode);
    for (const [container, contents] of mod.containerLinks ?? []) {
      if (contents.has(b)) push(container, 'container');
    }
  }
  return false;
}

/** The root of a member chain (`err.code` → err, `err.a.b` → err). */
const rootObject = (node) => {
  let o = node;
  while (o.type === 'MemberExpression') o = o.object;
  return o;
};

/** Parse one module and collect its bindings, sites and export map. */
function readModule(rel, text) {
  const ast = parse(text, PARSE_OPTIONS);
  const mod = {
    rel,
    text,
    ast,
    imports: new Map(), // local -> { module, exported }
    exportsMap: new Map(), // exported -> { kind: 'local', local } | { kind: 'reexport', module, exported }
    scope: null,
    newSites: [],
    throwSites: [],
    callSites: [],
    returnSites: [], // { expr, scope, fn } — expr is the returned expression, null for a bare `return`
    thisWrites: [], // { node, scope, fn, opaque? } — `this.<key> = …` and opaque `this` mutations
    evalSites: [], // direct eval calls: code this reader cannot see
    functions: new Map(), // node -> { name, params, node, scope }
    assignmentsByBinding: new Map(),
    // Writes are recorded LAZILY and resolved after the whole module has been
    // walked: a write inside an earlier function body may target a binding
    // declared LATER in the scope (`function f(){ F = …; } class F …`), and a
    // lookup during the single traversal would silently drop it.
    pendingWrites: [], // { kind, node, scope, fn, name? , pattern? }
    patternInits: [], // { pattern, init, scope } — var declarators, for destructured alias links
    bindingsList: [], // every declared binding, for alias construction
    aliasLinks: null, // binding -> Set(binding), built after the walk
    containerLinks: null, // container binding -> Set(content binding), directed
    unprovableExtractions: [], // destructuring extractions whose alias identity cannot be proved
    unprovableWrites: [], // writes whose target or value this reader cannot prove
    extractedOrigins: new Map(), // pattern binding -> { module, exported } for namespace extractions
    tagSites: [], // { node, scope, fn } — tagged templates INVOKE their tag
    dynamicImports: new Map(), // Import call node -> resolved module path (literal specifiers)
    loopSites: [], // { pattern, iterable, node, scope } — for-of targets, resolved post-walk
    unprovableAliasSources: [], // { node, scope, names } — iterables/containers this reader cannot resolve
    identifierRefs: [], // { node, scope } — every Identifier the walk reaches, declaration targets included
    importSites: [], // { node, scope } — every dynamic import() expression
    importDecls: [], // { node, module } — every static import declaration
    parentOf: new Map(), // node -> parent node, for the sink escape check
  };
  const indexParents = (node) => {
    for (const child of children(node)) {
      mod.parentOf.set(child, node);
      indexParents(child);
    }
  };
  indexParents(ast);
  const specifier = (raw) => (raw.startsWith('.') ? relative('.', resolvePath(dirname(rel), raw)) : raw);

  const moduleScope = new Scope(null, 'module', ast);
  mod.scope = moduleScope;

  // Write kinds: 'value' — a candidate VALUE for a proof (the right-hand side
  // of a plain rebinding); 'invalidate' — a write that never proves anything
  // (destructuring target, update, loop target); 'mutate' — a write to the
  // VALUE the binding holds, which propagates through aliases since both names
  // denote the same object.
  const noteAssignment = (binding, node, scope, kind, deep = false, memberExpr = null, fromMutator = false) => {
    if (binding === null) return;
    if (!mod.assignmentsByBinding.has(binding)) mod.assignmentsByBinding.set(binding, []);
    mod.assignmentsByBinding.get(binding).push({ node, scope, kind, deep, memberExpr, fromMutator });
  };

  /** Queue a binding-name write for post-walk resolution (see pendingWrites). */
  const pendWrite = (name, node, scope, kind, fn, deep = false, memberExpr = null) => {
    mod.pendingWrites.push({ name, node, scope, kind, fn, deep, memberExpr });
  };

  /** Every binding an assignment pattern writes, recursively. Called from the
   * post-walk resolution pass, when every declaration in scope exists. A MEMBER
   * target (`({ code: err.code } = …)`) mutates the value its root binding
   * holds — and a target rooted at `this` may write the code slot. */
  const notePatternWrites = (pattern, node, scope, fn) => {
    if (pattern.type === 'Identifier') noteAssignment(scope.lookup(pattern.name), node, scope, 'invalidate');
    else if (pattern.type === 'MemberExpression') {
      const root = rootObject(pattern);
      if (root.type === 'Identifier') noteAssignment(scope.lookup(root.name), node, scope, 'mutate', pattern.object !== root, pattern);
      else if (root.type === 'ThisExpression') {
        mod.thisWrites.push({ node, scope, fn, opaque: true, viaPrototype: chainHasPrototype(pattern),
          what: 'a destructuring write rooted at `this` may target the code slot' });
      }
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') notePatternWrites(prop.argument, node, scope, fn);
        else notePatternWrites(prop.value, node, scope, fn);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el) notePatternWrites(el, node, scope, fn);
    } else if (pattern.type === 'AssignmentPattern') notePatternWrites(pattern.left, node, scope, fn);
  };

  /** A write through a member chain: `err.code = …`, `this.x = …`,
   * `this.a.b = …`, `arguments[0] = …`, a loop target, a delete. Routes to the
   * binding mutation record, the class's `this` writes (opaque when the chain
   * is deeper than one step — the intermediate may be a self-alias), or the
   * parameters of the enclosing function (`arguments[i] = …` rewrites them). */
  /** Does a member chain pass through `.prototype` (`this.prototype.code`)? */
  const chainHasPrototype = (memberExpr) => {
    let cur = memberExpr;
    while (cur.type === 'MemberExpression') {
      if (!cur.computed && cur.property.type === 'Identifier' && cur.property.name === 'prototype') return true;
      if (cur.computed && isString(cur.property) && cur.property.value === 'prototype') return true;
      cur = cur.object;
    }
    return false;
  };

  const noteMemberWrite = (memberExpr, node, scope) => {
    const fn = fnStack[fnStack.length - 1] ?? null;
    const viaPrototype = chainHasPrototype(memberExpr);
    if (memberExpr.object.type === 'ThisExpression' || memberExpr.object.type === 'Super') {
      if (node.type === 'AssignmentExpression') {
        mod.thisWrites.push({ node, scope, fn, viaPrototype });
      } else {
        // delete/update/loop-target writes carry no assignment shape — and a
        // `super.<key> = …` write lands on the instance's inherited slot.
        mod.thisWrites.push({ node, scope, fn, opaque: true, viaPrototype,
          what: memberExpr.object.type === 'Super'
            ? 'a super.<key> write lands on the instance and may write the code slot'
            : 'a non-assignment write to this.<key> (delete/update/loop target) may hit the code slot' });
      }
      return;
    }
    const root = rootObject(memberExpr);
    if (root.type === 'ThisExpression' || root.type === 'Super') {
      mod.thisWrites.push({ node, scope, fn, opaque: true, viaPrototype,
        what: root.type === 'Super'
          ? 'a write through a super member chain lands on the instance and may write the code slot'
          : 'a write through a `this` member chain may reach the code slot' });
      return;
    }
    if (root.type === 'Identifier') {
      if (root.name === 'arguments' && scope.lookup('arguments') === null) {
        // `arguments[i] = …` rewrites the enclosing function's parameters — and
        // parameters are all declared before the body walks, so this lookup is
        // order-safe.
        for (let s = scope; s !== null; s = s.parent) {
          if (s.kind === 'function') {
            for (const pb of s.bindings.values()) if (pb.kind === 'param') noteAssignment(pb, node, scope, 'invalidate');
            return;
          }
        }
      }
      // The root binding may be declared LATER in the scope: resolve post-walk.
      pendWrite(root.name, node, scope, 'mutate', fn, memberExpr.object !== root, memberExpr);
      return;
    }
    // A root that is not a plain identifier — `[e][0].code = …`,
    // `({ x: e }).x.code = …`, `(0, e).code = …`, `(c ? e : null).code = …`,
    // `(a = e).code = …` — mutates whatever the root EXPRESSION refers to:
    // resolved post-walk through valueBindings, and refused when unprovable.
    // `valueNode` is the assigned value for a STORE (`[holder][0].x = e`):
    // each resolved root then HOLDS that value.
    mod.pendingWrites.push({ kind: 'rootMutate', rootExpr: root, node, scope, fn,
      valueNode: node.type === 'AssignmentExpression' ? node.right : undefined });
  };

  /** Every identifier a pattern declares or writes, recursively. */
  function* patternNames(pattern) {
    if (pattern.type === 'Identifier') yield pattern.name;
    else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') yield* patternNames(prop.argument);
        else yield* patternNames(prop.value);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el) yield* patternNames(el);
    } else if (pattern.type === 'AssignmentPattern') yield* patternNames(pattern.left);
  }

  const declarePattern = (pattern, scope, kind, init, siteScope = scope) => {
    if (pattern.type === 'Identifier') {
      // Within ONE scope, a repeated declaration merges into the same runtime
      // binding (`var alias = e; var alias;`, `var` on a parameter or function
      // name) — and a second initializer is an ASSIGNMENT at runtime.
      // Splitting it into two binding objects would attach writes and alias
      // links to different identities. (Same-scope let/const duplicates are
      // SyntaxErrors; the parse-failure refusal covers those.)
      const existing = scope.bindings.get(pattern.name);
      if (existing !== undefined) {
        if (init !== null && init !== undefined) {
          noteAssignment(existing, init, siteScope, 'value');
          if (existing.init === null || existing.init === undefined) existing.init = init;
        }
        return;
      }
      // The binding installs in `scope`, but its init resolves where the
      // declarator TEXTUALLY sits — the two differ for a hoisted `var`.
      const b = scope.declare(pattern.name, { kind, name: pattern.name, node: pattern, init, scope: siteScope });
      mod.bindingsList.push(b);
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') declarePattern(prop.argument, scope, kind, null);
        else declarePattern(prop.value, scope, kind, null);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el) declarePattern(el, scope, kind, null);
    } else if (pattern.type === 'AssignmentPattern') {
      declarePattern(pattern.left, scope, kind, pattern.right);
    } else if (pattern.type === 'RestElement') {
      declarePattern(pattern.argument, scope, kind, null);
    }
  };

  /** The Object/Reflect mutator family, with `.call`/`.apply` unwrapped.
   * Returns { on, name, via } or null; shadowing is checked at resolution. */
  const mutatorCallee = (callee) => {
    let inner = callee;
    let via = null;
    if (inner.type === 'MemberExpression' && !inner.computed && inner.property.type === 'Identifier'
      && (inner.property.name === 'call' || inner.property.name === 'apply')) {
      via = inner.property.name;
      inner = inner.object;
    }
    if (inner.type !== 'MemberExpression' || inner.computed
      || inner.object.type !== 'Identifier' || inner.property.type !== 'Identifier') return null;
    const on = inner.object.name;
    const name = inner.property.name;
    if (on === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(name)) {
      return { on, name, via };
    }
    if (on === 'Reflect' && ['set', 'defineProperty'].includes(name)) return { on, name, via };
    return null;
  };

  const fnStack = [];
  /** Where a `var` belongs: the nearest function or module scope. */
  const nearestVarScope = (scope) => {
    for (let s = scope; s !== null; s = s.parent) {
      if (s.kind === 'function' || s.kind === 'module') return s;
    }
    return scope;
  };
  const walk = (node, scope) => {
    switch (node.type) {
      case 'ImportDeclaration': {
        const from = specifier(node.source.value);
        mod.importDecls.push({ node, module: from });
        for (const spec of node.specifiers) {
          const exported = spec.type === 'ImportDefaultSpecifier'
            ? 'default'
            : spec.type === 'ImportNamespaceSpecifier'
              ? '*'
              : (spec.imported.name ?? spec.imported.value);
          mod.imports.set(spec.local.name, { module: from, exported });
          const b = scope.declare(spec.local.name, { kind: 'import', name: spec.local.name, module: from, exported, scope });
          mod.bindingsList.push(b);
        }
        return;
      }
      case 'ExportNamedDeclaration': {
        if (node.source) {
          const from = specifier(node.source.value);
          for (const spec of node.specifiers) {
            mod.exportsMap.set(spec.exported.name ?? spec.exported.value, {
              kind: 'reexport', module: from, exported: spec.local.name ?? spec.local.value,
            });
          }
          return;
        }
        for (const spec of node.specifiers) {
          mod.exportsMap.set(spec.exported.name ?? spec.exported.value, { kind: 'local', local: spec.local.name });
        }
        if (node.declaration) walk(node.declaration, scope);
        if (node.declaration) {
          if (node.declaration.type === 'VariableDeclaration') {
            for (const d of node.declaration.declarations) {
              if (d.id.type === 'Identifier') mod.exportsMap.set(d.id.name, { kind: 'local', local: d.id.name });
            }
          } else if (node.declaration.id) {
            mod.exportsMap.set(node.declaration.id.name, { kind: 'local', local: node.declaration.id.name });
          }
        }
        return;
      }
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        mod.exportsMap.set('default', { kind: 'local', local: d.id ? d.id.name : (d.type === 'Identifier' ? d.name : '*default*') });
        walk(d, scope);
        return;
      }
      case 'ExportAllDeclaration': {
        if (node.exported) {
          // `export * as nsx from '…'` exports the NAMESPACE under a name.
          mod.exportsMap.set(node.exported.name ?? node.exported.value, { kind: 'nsstar', module: specifier(node.source.value) });
        } else {
          mod.exportsMap.set('*', { kind: 'star', module: specifier(node.source.value) });
        }
        return;
      }
      case 'VariableDeclaration': {
        // `var` hoists to the nearest function (or module) scope; let/const
        // stay in their block. Installing a var in its block would make every
        // write to it outside the block unresolvable — and an unresolvable
        // write vanishes silently.
        const home = node.kind === 'var' ? nearestVarScope(scope) : scope;
        for (const d of node.declarations) {
          declarePattern(d.id, home, 'var', d.init ?? null, scope);
          // The declaration keyword decides whether the binding can be
          // rebound: only a `const` alias of the renderer is followed.
          for (const name of patternNames(d.id)) {
            const b = home.bindings.get(name);
            if (b !== undefined && b.declKind === undefined) b.declKind = node.kind;
          }
          // `var e = X` inside `catch (e)` assigns the CATCH binding at
          // runtime — the catch parameter shadows the hoisted var within the
          // block (verified against the engine), and a destructured var
          // (`var { x: e } = …`, `var [e] = …`) writes it just the same.
          // Record the initializer against every binding the SITE resolves,
          // when that is a different binding than the hoisted one.
          if (node.kind === 'var' && d.init !== null && d.init !== undefined) {
            for (const name of patternNames(d.id)) {
              const shadowed = scope.lookup(name);
              const hoisted = home.bindings.get(name);
              if (shadowed !== null && shadowed !== undefined && shadowed !== hoisted) {
                // An identifier declarator assigns the initializer itself; a
                // pattern assigns an EXTRACTED value, which never proves.
                noteAssignment(shadowed, d.init, scope, d.id.type === 'Identifier' ? 'value' : 'invalidate');
              }
            }
          }
          // `const { x: alias } = { x: err }` makes alias name the SAME object
          // as err — the extraction preserves identity. Recorded for the
          // post-walk alias pass.
          mod.patternInits.push({ pattern: d.id, init: d.init ?? null, scope });
        }
        for (const d of node.declarations) if (d.init) walk(d.init, scope);
        // The pattern itself is executable: default values (`const { x = f() }
        // = …`) and computed keys (`const { [g()]: y } = …`) run, and can raise
        // or render. Walk them, or those sites never enter the gate.
        for (const d of node.declarations) walk(d.id, scope);
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        // A class DECLARATION binds its name in the enclosing scope; a named
        // class EXPRESSION binds it only inside its own body (`const H =
        // class X {}` leaves the outer `X` untouched), so the id is declared
        // in the inner scope, where a shadowing lookup from the body finds it
        // and a lookup from outside does not.
        const inner = new Scope(scope, 'block', node);
        if (node.id) {
          const home = node.type === 'ClassDeclaration' ? scope : inner;
          const b = home.declare(node.id.name, { kind: 'class', name: node.id.name, node, scope: home });
          mod.bindingsList.push(b);
        }
        for (const child of children(node)) walk(child, inner);
        return;
      }
      case 'SwitchStatement': {
        // The case bodies share ONE block scope of their own: a `let` or
        // `class` in a case is invisible after the switch, so a same-named
        // import is still the import there.
        walk(node.discriminant, scope);
        const switchScope = new Scope(scope, 'block', node);
        for (const c of node.cases) walk(c, switchScope);
        return;
      }
      case 'ForStatement': {
        // A loop head's `let`/`const` lives in a scope of its own, enclosing
        // the head and the body and nothing after the loop.
        const loopScope = new Scope(scope, 'block', node);
        for (const child of children(node)) walk(child, loopScope);
        return;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.id && node.type === 'FunctionDeclaration') {
          const existing = scope.bindings.get(node.id.name);
          if (existing !== undefined) {
            // A redeclared function (or a function sharing a var's name) no
            // longer provably names ONE function: last-wins at runtime, so the
            // binding is treated as written and every use of it is refused.
            noteAssignment(existing, node, scope, 'invalidate');
          } else {
            const b = scope.declare(node.id.name, { kind: 'function', name: node.id.name, node, scope });
            mod.bindingsList.push(b);
          }
        }
        const fnScope = new Scope(scope, 'function', node);
        // A named function EXPRESSION binds its name inside its own body only
        // (`const H = function f() { f(…) }` calls itself, not an outer `f`),
        // so the id is declared in the function scope, before the parameters
        // — a same-named parameter shadows it, as at runtime.
        if (node.id && node.type === 'FunctionExpression') {
          const b = fnScope.declare(node.id.name, { kind: 'function', name: node.id.name, node, scope: fnScope });
          mod.bindingsList.push(b);
        }
        const params = [];
        for (const p of node.params) {
          declarePattern(p, fnScope, 'param', null);
          params.push(p.type === 'Identifier' ? p.name : null);
        }
        mod.functions.set(node, { node, params, scope: fnScope });
        fnStack.push(node);
        // Parameter DEFAULTS are executable code (`function f(x = codedLine(…))`)
        // and run in the function's own scope — walk them, or a sink or raise
        // inside a default never enters the gate.
        for (const p of node.params) walk(p, fnScope);
        if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
          // An arrow's expression body is an implicit return.
          mod.returnSites.push({ expr: node.body, scope: fnScope, fn: node });
        }
        for (const child of children(node)) if (!node.params.includes(child)) walk(child, fnScope);
        fnStack.pop();
        return;
      }
      case 'CatchClause': {
        const catchScope = new Scope(scope, 'catch', node);
        if (node.param) {
          // Only a SIMPLE identifier binding is "the caught error". A
          // destructured property (`catch ({ nested: e })`) is an EXTRACTED
          // value with its own provenance to prove — it never inherits the
          // caught-error proof.
          declarePattern(node.param, catchScope, node.param.type === 'Identifier' ? 'catch' : 'catch-part', null);
          // A catch PATTERN can carry executable defaults and computed keys.
          walk(node.param, catchScope);
        }
        walk(node.body, catchScope);
        return;
      }
      case 'BlockStatement': {
        const blockScope = new Scope(scope, 'block', node);
        for (const child of children(node)) walk(child, blockScope);
        return;
      }
      case 'AssignmentExpression': {
        const fn = fnStack[fnStack.length - 1] ?? null;
        if (node.left.type === 'Identifier') pendWrite(node.left.name, node.right, scope, 'value', fn);
        else if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
          // `({ err } = payload)` rebinds every identifier in the pattern. The
          // write is recorded as INVALIDATING, not as a value: destructuring a
          // construction yields its PROPERTIES, not the error, so such a write
          // never proves a binding. But identity still flows: `({ x: alias } =
          // { x: err })` makes alias name the same object as err.
          mod.pendingWrites.push({ pattern: node.left, node, scope, kind: 'pattern', fn });
          mod.patternInits.push({ pattern: node.left, init: node.right, scope });
        } else if (node.left.type === 'MemberExpression') {
          // `err.code = …`, `this.code = …`, `this.a.b = …`: a write through a
          // member chain mutates the value its root denotes.
          noteMemberWrite(node.left, node, scope);
          // Storing a value INTO a container makes the container hold it:
          // `holder.x = e` — later member writes on holder may reach e.
          const root = rootObject(node.left);
          if (root.type === 'Identifier') {
            mod.pendingWrites.push({ kind: 'containerStore', name: root.name, valueNode: node.right, node, scope, fn });
          }
        }
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'UpdateExpression': {
        // `err++` / `--err` are binding writes; `err.code++` is a mutation of
        // the held value.
        if (node.argument.type === 'Identifier') {
          pendWrite(node.argument.name, node, scope, 'invalidate', fnStack[fnStack.length - 1] ?? null);
        } else if (node.argument.type === 'MemberExpression') noteMemberWrite(node.argument, node, scope);
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'UnaryExpression': {
        // `delete err.code` removes the carried code: a mutation of the value.
        if (node.operator === 'delete' && node.argument.type === 'MemberExpression') {
          noteMemberWrite(node.argument, node, scope);
        }
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'ReturnStatement': {
        mod.returnSites.push({ expr: node.argument, scope, fn: fnStack[fnStack.length - 1] ?? null });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        // The head's declaration is scoped to the loop (see ForStatement).
        scope = new Scope(scope, 'block', node);
        // `for (err of …)` rebinds an existing binding each iteration; a
        // pattern target can mutate a held value (`for ({ code: err.code } of
        // …)`), and a bare MEMBER target (`for (err.code of …)`) mutates it
        // directly.
        if (node.left.type === 'Identifier') {
          pendWrite(node.left.name, node, scope, 'invalidate', fnStack[fnStack.length - 1] ?? null);
        } else if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
          mod.pendingWrites.push({ pattern: node.left, node, scope, kind: 'pattern', fn: fnStack[fnStack.length - 1] ?? null });
        } else if (node.left.type === 'MemberExpression') noteMemberWrite(node.left, node, scope);
        else if (node.left.type === 'VariableDeclaration') {
          // A loop DECLARATION is written every iteration — including a `var`
          // whose name a catch parameter shadows: the iteration value lands on
          // the CATCH binding at runtime (verified against the engine, same
          // rule as a catch-shadowed var initializer).
          walk(node.left, scope); // declares the bindings, walks inits and pattern defaults
          const fn = fnStack[fnStack.length - 1] ?? null;
          for (const d of node.left.declarations) {
            mod.pendingWrites.push({ pattern: d.id, node, scope, kind: 'pattern', fn });
            if (node.type === 'ForOfStatement') {
              mod.loopSites.push({ pattern: d.id, iterable: node.right, node, scope });
            }
            if (node.left.kind !== 'var') continue;
            const home = nearestVarScope(scope);
            for (const name of patternNames(d.id)) {
              const shadowed = scope.lookup(name);
              const hoisted = home.bindings.get(name);
              if (shadowed !== null && shadowed !== undefined && shadowed !== hoisted) {
                noteAssignment(shadowed, node, scope, 'invalidate');
              }
            }
          }
          for (const child of children(node)) if (child !== node.left) walk(child, scope);
          return;
        }
        // An iteration target names each iterated value in turn. Where the
        // iterable comes from is resolved post-walk (a literal — spreads of
        // literals expanded — or an unreassigned identifier holding one);
        // anything else is an unprovable alias source. (`for…in` iterates
        // KEYS — strings — so it never aliases.)
        if (node.type === 'ForOfStatement'
          && (node.left.type === 'Identifier' || node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern')) {
          mod.loopSites.push({ pattern: node.left, iterable: node.right, node, scope });
        }
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'ImportExpression': {
        // `await import('./x.mjs')` with a literal specifier yields that
        // module's namespace — recorded so a member call through it resolves.
        if (isString(node.source)) mod.dynamicImports.set(node, specifier(node.source.value));
        mod.importSites.push({ node, scope });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'CallExpression': {
        // The Function global compiles invisible code in BOTH spellings —
        // `Function(…)` and `new Function(…)` build identically — so both are
        // refused (the construction pass covers `new`; the two sandbox
        // snippets in src/capture.mjs are reviewed sites). Shadowing is
        // checked post-walk.
        if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
          mod.evalSites.push({ node, scope, what: 'call' });
        }
        // `globalThis.eval(…)`, `globalThis['eval'](…)`, `global.eval(…)`:
        // the same invisible code through a member.
        if (node.callee.type === 'MemberExpression') {
          const cr = rootObject(node.callee);
          const cp = node.callee.property;
          const isEvalMember = node.callee.computed
            ? isString(cp) && cp.value === 'eval'
            : cp.type === 'Identifier' && cp.name === 'eval';
          if (cr.type === 'Identifier' && (cr.name === 'globalThis' || cr.name === 'global') && isEvalMember) {
            mod.evalSites.push({ node, scope, what: cr.name === 'global' ? 'global-eval' : 'globalThis-eval' });
          }
        }
        // The Object/Reflect mutator family — assign, defineProperty,
        // defineProperties, setPrototypeOf, Reflect.set/defineProperty —
        // writes its TARGET argument's value; `.call(null, target, …)` shifts
        // the target to index 1; `.apply` hides the arguments — refused
        // outright. The Object/Reflect shadow check runs at resolution time.
        const mut = mutatorCallee(node.callee);
        if (mut !== null && mut.via === 'apply') {
          mod.pendingWrites.push({ kind: 'mutatorApply', node, scope, fn: fnStack[fnStack.length - 1] ?? null, mutOn: mut.on });
        } else if (mut !== null && node.arguments.length > (mut.via === 'call' ? 1 : 0)) {
          const fn = fnStack[fnStack.length - 1] ?? null;
          const index = mut.via === 'call' ? 1 : 0;
          const target = node.arguments[index];
          const entry = { node, scope, fn, mutOn: mut.on, mutName: mut.name, targetIndex: index };
          if (target.type === 'Identifier') {
            mod.pendingWrites.push({ ...entry, name: target.name, kind: 'objectMutate' });
          } else {
            const targetRoot = target.type === 'MemberExpression' ? rootObject(target) : target;
            if (target.type === 'ThisExpression' || target.type === 'Super'
              || targetRoot.type === 'ThisExpression' || targetRoot.type === 'Super') {
              mod.thisWrites.push({ node, scope, fn, opaque: true,
                what: `${mut.on}.${mut.name} on \`this\` (possibly through a member) may write the code slot` });
            } else {
              // Any other expression target — a member's value, a conditional,
              // a sequence, a spread — resolves through valueBindings.
              mod.pendingWrites.push({ ...entry, kind: 'objectRootMutate', rootExpr: target });
            }
          }
        }
        mod.callSites.push({ node, scope, fn: fnStack[fnStack.length - 1] ?? null });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'NewExpression': {
        mod.newSites.push({ node, scope, fn: fnStack[fnStack.length - 1] ?? null });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'MemberExpression': {
        // The non-computed property is a NAME, not a reference — never walk it
        // (so `obj.eval` is not an eval reference).
        walk(node.object, scope);
        if (node.computed) walk(node.property, scope);
        return;
      }
      case 'Property': {
        // Object literal/pattern member: a non-computed key is a name.
        if (node.computed) walk(node.key, scope);
        if (node.value) walk(node.value, scope);
        return;
      }
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (node.computed) walk(node.key, scope);
        if (node.value) walk(node.value, scope);
        return;
      }
      case 'LabeledStatement': {
        walk(node.body, scope);
        return;
      }
      case 'Identifier': {
        // ANY reference to the eval global — direct call, indirect
        // `(0, eval)(…)`, aliasing — is code this reader cannot see.
        if (node.name === 'eval') mod.evalSites.push({ node, scope });
        mod.identifierRefs.push({ node, scope });
        return;
      }
      case 'ThrowStatement': {
        mod.throwSites.push({ node, scope, fn: fnStack[fnStack.length - 1] ?? null });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      case 'TaggedTemplateExpression': {
        // A tagged template is a CALL of its tag — `codedLine\`…\`` invokes the
        // renderer — so the tag is recorded like a callee.
        mod.tagSites.push({ node, scope, fn: fnStack[fnStack.length - 1] ?? null });
        for (const child of children(node)) walk(child, scope);
        return;
      }
      default: {
        for (const child of children(node)) walk(child, scope);
      }
    }
  };
  for (const child of children(ast)) walk(child, moduleScope);

  // Resolve every queued write NOW, when each scope holds all of its
  // declarations: a write inside an earlier function body may target a binding
  // declared later in the scope (`function f(){ F = …; } class F …`).
  for (const w of mod.pendingWrites) {
    if (w.pattern !== undefined) {
      notePatternWrites(w.pattern, w.node, w.scope, w.fn);
      continue;
    }
    // rootMutate, containerStore, objectMutate, objectRootMutate and
    // mutatorApply resolve in the second pass, once valueBindings and the
    // alias-link apparatus exist.
    if (w.kind === 'rootMutate' || w.kind === 'containerStore' || w.kind === 'objectMutate'
      || w.kind === 'objectRootMutate' || w.kind === 'mutatorApply') continue;
    const binding = w.scope.lookup(w.name);
    if (binding === null && w.kind === 'mutate') {
      // A member write rooted at an unresolved BUILTIN name mutates the
      // language's own prototypes: `Error.prototype.code = …` rides every
      // later `throw new Error(…)`. Refused, never dropped.
      const isBuiltinRoot = BUILTIN_ERRORS.has(w.name)
        || ['Array', 'Object', 'Function', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set'].includes(w.name)
        || (w.name === 'globalThis' && w.memberExpr !== null
          && w.memberExpr.object.type === 'MemberExpression' && !w.memberExpr.object.computed
          && w.memberExpr.object.property.type === 'Identifier'
          && BUILTIN_ERRORS.has(w.memberExpr.object.property.name));
      if (isBuiltinRoot) mod.unprovableWrites.push({ node: w.node, scope: w.scope });
      continue;
    }
    noteAssignment(binding, w.node, w.scope, w.kind, w.deep === true, w.memberExpr ?? null);
  }

  // Aliases: `const alias = err` or `alias = err` make two bindings name the
  // SAME object, so a mutation through either invalidates both. Links are
  // module-local by construction: scope.lookup never crosses a module boundary.
  //
  // Two DISTINCT link kinds, because they propagate differently:
  //   - identity (aliasLinks): both names denote one object — ANY member write
  //     on either reaches the shared value;
  //   - containment (containerLinks, directed container -> contents):
  //     `const holder = { x: err }` or `holder.x = err` — only a DEEP write on
  //     the container (`holder.x.code = …`) reaches the held value; a shallow
  //     store (`sections[name] = {…}`) replaces a slot without touching what
  //     used to be there.
  const aliasLinks = new Map();
  const containerLinks = new Map();
  const link = (a, b) => {
    if (a === null || b === null || a === undefined || b === undefined || a === b) return;
    if (!aliasLinks.has(a)) aliasLinks.set(a, new Set());
    if (!aliasLinks.has(b)) aliasLinks.set(b, new Set());
    aliasLinks.get(a).add(b);
    aliasLinks.get(b).add(a);
  };
  const linkContainer = (container, content) => {
    if (container === null || content === null || container === undefined || content === undefined) return;
    if (container === content) return;
    if (!containerLinks.has(container)) containerLinks.set(container, new Set());
    containerLinks.get(container).add(content);
  };
  // Link a binding to the value it receives: a fresh literal CONTAINER links
  // by containment (deep writes reach the contents); anything else is the
  // value itself — identity.
  const linkValue = (b, valueNode, vb) => {
    if (vb === null || vb === 'boundary') return;
    const contains = valueNode.type === 'ObjectExpression' || valueNode.type === 'ArrayExpression';
    for (const t of vb) {
      if (t !== null) (contains ? linkContainer : link)(b, t);
    }
  };
  mod.aliasLinks = aliasLinks;
  mod.containerLinks = containerLinks;
  mod.valueBindings = (n, sc, a) => valueBindings(n, sc, a);
  mod.resolveMemberPath = (n, sc) => resolveMemberPath(n, sc);
  // A container literal holding a binding (`const holder = { x: err }`) makes
  // every member write on the container a possible write to the held value:
  // `holder.x.code = …` mutates err. Link the container to every binding its
  // value may hold.
  //
  // valueBindings(expr, scope) resolves the bindings an expression may REFER
  // to: an array (possibly empty — a provable value holding nothing tracked),
  // 'boundary' (a call or construction — the documented ceiling), or null
  // (unprovable — the caller must register an unprovable alias source).
  // Member reads resolve through literal containers (`holder.inner.x`);
  // conditionals, logicals, sequences, awaits and parenthesized assignments
  // link the UNION of their provable branches; literals, templates, unary and
  // binary expressions and fresh callables are primitives or fresh objects.
  const valueBindings = (node, scope, allowContainerContents = false, seen = new Set()) => {
    if (node.type === 'MemberExpression' || node.type === 'CallExpression') {
      if (seen.has(node)) return null; // a getter/member cycle proves nothing
      seen.add(node);
    }
    if (node.type === 'Identifier') {
      const b = scope.lookup(node.name);
      return b === null ? [] : [b];
    }
    if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') {
      const out = [];
      const parts = node.type === 'ObjectExpression'
        ? node.properties.map((p) => (p.type === 'SpreadElement' ? p.argument : p.value))
        : node.elements.filter((el) => el !== null).map((el) => (el.type === 'SpreadElement' ? el.argument : el));
      for (const part of parts) {
        const vb = valueBindings(part, scope);
        if (vb === null) return null;
        if (vb !== 'boundary') out.push(...vb);
      }
      return out;
    }
    if (node.type === 'MemberExpression') {
      const resolved = resolveMemberPath(node, scope);
      if (resolved !== null) {
        if (resolved.viaGetter) {
          // A getter's value is its RETURN: read the return paths.
          const sites = mod.returnSites.filter((st) => st.fn === resolved.node);
          const out = [];
          for (const st of sites) {
            if (st.expr === null || st.expr === undefined) continue;
            const vb = valueBindings(st.expr, st.scope, allowContainerContents, seen);
            if (vb === null) return null;
            if (vb !== 'boundary') out.push(...vb);
          }
          return out;
        }
        return valueBindings(resolved.node, resolved.scope, allowContainerContents, seen);
      }
      if (memberSourceIsClean(node, scope)) return [];
      // Anything else reads a value that crossed a boundary (call result,
      // parameter, import, iteration or extraction target) — the documented
      // ceiling — UNLESS the root is a literal the path did not resolve
      // through (a computed key may select a held binding): no call is
      // involved there, so it is unprovable, not boundary.
      let root = node;
      while (root.type === 'MemberExpression') root = root.object;
      if (root.type !== 'Identifier') {
        // A member the literal root does not declare resolves to the
        // PROTOTYPE (`['a'].includes`, `({}).missing`): a built-in method,
        // never the renderer. Anything else non-identifier is unprovable.
        return root.type === 'ObjectExpression' || root.type === 'ArrayExpression' ? [] : 'boundary';
      }
      const b = scope.lookup(root.name);
      if (b === null || b.kind !== 'var') return 'boundary';
      if (b.init !== null && b.init !== undefined
        && (b.init.type === 'ObjectExpression' || b.init.type === 'ArrayExpression')) {
        return null; // local literal container, but the path did not resolve
      }
      return 'boundary';
    }
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      const arms = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right];
      const out = [];
      let onlyBoundary = true;
      for (const arm of arms) {
        const vb = valueBindings(arm, scope);
        if (vb === null) return null;
        if (vb === 'boundary') continue; // a boundary arm's value is the ceiling's business
        onlyBoundary = false;
        out.push(...vb);
      }
      return onlyBoundary ? 'boundary' : out;
    }
    if (node.type === 'SequenceExpression') return valueBindings(node.expressions[node.expressions.length - 1], scope);
    if (node.type === 'AwaitExpression') return valueBindings(node.argument, scope);
    if (node.type === 'ChainExpression') return valueBindings(node.expression, scope);
    if (node.type === 'AssignmentExpression') return valueBindings(node.right, scope);
    if (node.type === 'CallExpression' || node.type === 'NewExpression'
      || node.type === 'TaggedTemplateExpression') return 'boundary'; // a tagged template is a CALL
    if (node.type === 'Literal' || node.type === 'TemplateLiteral'
      || node.type === 'UnaryExpression' || node.type === 'BinaryExpression' || node.type === 'UpdateExpression'
      || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
      || node.type === 'ClassExpression' || node.type === 'ThisExpression' || node.type === 'Super') {
      return []; // primitives and fresh callables hold no tracked binding
    }
    return null;
  };

  // The elements of an iterable this reader can prove: a literal (spreads of
  // provable iterables expanded), or an unreassigned identifier holding one.
  // Each element carries the SCOPE it was written in — the iterable's scope,
  // not the loop's — so an inner shadow cannot hijack the link.
  const iterableElements = (node, scope) => {
    if (node.type === 'ArrayExpression') {
      const out = [];
      for (const el of node.elements) {
        if (el === null) { out.push(null); continue; } // a hole: index-preserving (undefined yields no alias)
        if (el.type === 'SpreadElement') {
          const inner = iterableElements(el.argument, scope);
          if (inner === null || inner.includes(null)) return null; // a spread with holes shifts indices
          out.push(...inner);
          continue;
        }
        out.push({ node: el, scope });
      }
      return out;
    }
    if (node.type === 'Identifier') {
      const b = scope.lookup(node.name);
      if (b !== null && b.kind === 'var' && b.init !== null && b.init !== undefined
        && (mod.assignmentsByBinding.get(b) ?? []).length === 0) {
        return iterableElements(b.init, b.scope);
      }
    }
    return null;
  };

  /** Resolve `holder.a.b` — or `[e][0].x`, `({ x: e }).x` — following the
   * property path into an unreassigned literal container or a literal root
   * directly. Returns { node, scope } or null. */
  /** Has any write been recorded against a binding or any identity-linked
   * alias of it? Links are consulted as they stand when asked, so this is
   * used only where a false negative would be caught by a later, complete
   * proof (mutationReaches at analysis time) and a false positive merely
   * refuses. */
  const groupIsWritten = (binding) => {
    const seen = new Set([binding]);
    const queue = [binding];
    while (queue.length > 0) {
      const cur = queue.pop();
      if ((mod.assignmentsByBinding.get(cur) ?? []).length > 0) return true;
      for (const l of aliasLinks.get(cur) ?? []) {
        if (!seen.has(l)) { seen.add(l); queue.push(l); }
      }
    }
    return false;
  };

  const resolveMemberPath = (expr, scope) => {
    const path = [];
    let cur = expr;
    while (cur.type === 'MemberExpression') {
      if (cur.computed) {
        if (cur.property.type !== 'Literal'
          || (typeof cur.property.value !== 'string' && !Number.isInteger(cur.property.value))) return null;
        path.unshift(cur.property.value);
      } else {
        if (cur.property.type !== 'Identifier') return null;
        path.unshift(cur.property.name);
      }
      cur = cur.object;
    }
    const step = (value, key, valueScope) => {
      if (value.type === 'ObjectExpression') {
        if (typeof key !== 'string') return null;
        if (value.properties.some((p) => p.type === 'SpreadElement' || isComputedUnknown(p))) return null;
        const matches = value.properties.filter((p) => p.type === 'Property' && staticKey(p) === key);
        const prop = matches[matches.length - 1]; // duplicate keys: last wins
        return prop === undefined ? null : { node: prop.value, getter: prop.kind === 'get' };
      }
      if (value.type === 'ArrayExpression') {
        if (typeof key !== 'number' || key < 0) return null;
        const el = value.elements[key];
        return el === null || el === undefined || el.type === 'SpreadElement' ? null : { node: el, getter: false };
      }
      return null;
    };
    const walkPath = (start, startScope) => {
      let value = start;
      let scopeAt = startScope;
      let viaGetter = false;
      for (let i = 0; i < path.length; i++) {
        // An intermediate value may itself be a binding holding a literal, or
        // a constructed instance whose class decides the rest of the path.
        while (value.type === 'Identifier') {
          const b = scopeAt.lookup(value.name);
          if (b === null || b.kind !== 'var' || b.init === null || b.init === undefined) return null;
          // Any write on the intermediate's identity group — a rebinding, or a
          // member store through any alias (`inner.line = x` runs after
          // `inner = { line: … }`) — makes its literal stale: unprovable.
          if (groupIsWritten(b)) return null;
          if (b.init.type === 'NewExpression') {
            return { node: b.init, scope: b.scope, viaGetter, restPath: path.slice(i) };
          }
          // Object.freeze/seal/preventExtensions return their argument.
          if (b.init.type === 'CallExpression' && b.init.callee.type === 'MemberExpression'
            && !b.init.callee.computed && b.init.callee.object.type === 'Identifier'
            && b.init.callee.object.name === 'Object' && scopeAt.lookup('Object') === null
            && ['freeze', 'seal', 'preventExtensions'].includes(b.init.callee.property.name)
            && b.init.arguments.length === 1) {
            value = b.init.arguments[0];
            scopeAt = b.scope;
            continue;
          }
          if (b.init.type !== 'ObjectExpression' && b.init.type !== 'ArrayExpression') return null;
          value = b.init;
          scopeAt = b.scope;
        }
        const stepped = step(value, path[i]);
        if (stepped === null) return null;
        viaGetter = viaGetter || stepped.getter;
        value = stepped.node;
        if (value.type === 'NewExpression' && i + 1 < path.length) {
          // The path ran into a constructed instance: its class decides.
          return { node: value, scope: scopeAt, viaGetter, restPath: path.slice(i + 1) };
        }
      }
      return { node: value, scope: scopeAt, viaGetter, restPath: [] };
    };
    if (cur.type === 'Identifier') {
      const b = scope.lookup(cur.name);
      if (b === null || b.kind !== 'var' || b.init === null || b.init === undefined) return null;
      // Any write on the root's identity group makes the literal stale —
      // a shallow store included: the stored value, not the literal member,
      // is what a later read returns.
      if (groupIsWritten(b)) return null;
      // Object.freeze/seal/preventExtensions return their argument.
      let rootInit = b.init;
      let rootScope = b.scope;
      if (rootInit.type === 'CallExpression' && rootInit.callee.type === 'MemberExpression'
        && !rootInit.callee.computed && rootInit.callee.object.type === 'Identifier'
        && rootInit.callee.object.name === 'Object' && b.scope.lookup('Object') === null
        && ['freeze', 'seal', 'preventExtensions'].includes(rootInit.callee.property.name)
        && rootInit.arguments.length === 1) {
        rootInit = rootInit.arguments[0];
      }
      if (rootInit.type !== 'ObjectExpression' && rootInit.type !== 'ArrayExpression'
        && rootInit.type !== 'NewExpression') return null;
      return walkPath(rootInit, rootScope);
    }
    if (cur.type === 'ObjectExpression' || cur.type === 'ArrayExpression') {
      return walkPath(cur, scope);
    }
    return null;
  };

  /** A member-read source that PROVABLY holds no tracked binding: an
   * unreassigned, unlinked local container whose literal initializer
   * references nothing (`const rows = []; rows.push({…}); rows[rows.length-1]`
   * — contents arriving through calls are the documented ceiling). */
  const memberSourceIsClean = (expr, scope) => {
    let root = expr;
    while (root.type === 'MemberExpression') root = root.object;
    if (root.type !== 'Identifier') return false;
    const b = scope.lookup(root.name);
    if (b === null || b.kind !== 'var') return false; // params, imports, unknowns: tainted
    if ((mod.assignmentsByBinding.get(b) ?? []).length > 0) return false;
    if ((aliasLinks.get(b) ?? []).size > 0) return false;
    if (b.init === null || b.init === undefined) return false;
    if (b.init.type !== 'ObjectExpression' && b.init.type !== 'ArrayExpression') return false;
    const vb = valueBindings(b.init, b.scope);
    return vb === 'boundary' || (vb !== null && vb.length === 0);
  };

  // Every binding's initial value and EVERY 'value' write links it to
  // whatever the expression may refer to — a bare assignment of a conditional,
  // sequence or member read included.
  for (const b of mod.bindingsList) {
    if (b.kind !== 'var' || b.init === null || b.init === undefined) continue;
    const vb = valueBindings(b.init, b.scope);
    if (vb === null) mod.unprovableAliasSources.push({ node: b.node, scope: b.scope, names: [b.name] });
    else linkValue(b, b.init, vb);
    // `const P = A.prototype` with A a local class/function: P joins the
    // declaration's identity group, so writes to P void the declaration.
    if (b.init.type === 'MemberExpression') {
      let root = b.init;
      while (root.type === 'MemberExpression') root = root.object;
      if (root.type === 'Identifier') {
        const rb = b.scope.lookup(root.name);
        if (rb !== null && (rb.kind === 'class' || rb.kind === 'function')) link(b, rb);
      }
    }
  }
  for (const [b, writes] of mod.assignmentsByBinding) {
    for (const w of writes) {
      if (w.kind !== 'value') continue;
      const vb = valueBindings(w.node, w.scope);
      if (vb === null) mod.unprovableAliasSources.push({ node: w.node, scope: w.scope, names: [b.name] });
      else linkValue(b, w.node, vb);
      if (w.node.type === 'MemberExpression') {
        let root = w.node;
        while (root.type === 'MemberExpression') root = root.object;
        if (root.type === 'Identifier') {
          const rb = w.scope.lookup(root.name);
          if (rb !== null && (rb.kind === 'class' || rb.kind === 'function')) link(b, rb);
        }
      }
    }
  }



  // Second write-resolution pass — the kinds that need valueBindings and the
  // alias-link apparatus: expression-rooted member writes, values stored into
  // containers, and the Object/Reflect mutator family.
  /** The values a mutator call stores into its target: assign/setPrototypeOf
   * take source objects, defineProperty a descriptor with `value`,
   * defineProperties a map of them. Non-literal shapes yield the expression
   * itself for valueBindings to classify. */
  const mutatorStoredValues = (w) => {
    const args = w.node.arguments;
    const ti = w.targetIndex;
    if (w.mutName === 'assign' || w.mutName === 'setPrototypeOf' || w.mutName === 'set') {
      return args.slice(ti + 1).filter((a) => a !== undefined);
    }
    const descriptorValues = (d) => {
      if (d === undefined || d.type !== 'ObjectExpression'
        || d.properties.some((p) => p.type === 'SpreadElement' || isComputedUnknown(p))) return [];
      const v = d.properties.filter((p) => p.type === 'Property' && staticKey(p) === 'value');
      return v.length > 0 ? [v[v.length - 1].value] : [];
    };
    if (w.mutName === 'defineProperty') return [...descriptorValues(args[ti + 2])];
    // defineProperties
    const map = args[ti + 1];
    if (map === undefined || map.type !== 'ObjectExpression'
      || map.properties.some((p) => p.type === 'SpreadElement' || isComputedUnknown(p))) return [];
    const out = [];
    for (const p of map.properties) {
      if (p.type === 'Property') out.push(...descriptorValues(p.value));
    }
    return out;
  };
  const noteMutatorStore = (w, targetBindings) => {
    for (const src of mutatorStoredValues(w)) {
      const svb = valueBindings(src, w.scope);
      if (svb === null) {
        for (const b of targetBindings) {
          if (b !== null) mod.unprovableAliasSources.push({ node: w.node, scope: w.scope, names: [b.name] });
        }
        continue;
      }
      if (svb === 'boundary') continue;
      // Storing INTO a container is containment: assign(holder, { x: e }) and
      // defineProperty(holder, 'x', { value: e }) make holder hold e.
      for (const b of targetBindings) for (const t of svb) linkContainer(b, t);
    }
  };
  for (const w of mod.pendingWrites) {
    if (w.kind === 'mutatorApply') {
      if (w.scope.lookup(w.mutOn) !== null) continue; // shadowed: not the built-in
      // The arguments hide in an array this reader does not index.
      mod.unprovableWrites.push({ node: w.node, scope: w.scope });
      continue;
    }
    if (w.kind === 'objectMutate') {
      if (w.scope.lookup(w.mutOn) !== null) continue; // a local shadow: not the built-in
      const b = w.scope.lookup(w.name);
      if (b !== null) {
        noteAssignment(b, w.node, w.scope, 'mutate', false, null, true);
        noteMutatorStore(w, [b]);
      }
      continue;
    }
    if (w.kind === 'objectRootMutate') {
      if (w.scope.lookup(w.mutOn) !== null) continue;
      const resolved = resolveMemberPath(w.rootExpr, w.scope);
      if (resolved !== null && (resolved.node.type === 'ThisExpression' || resolved.node.type === 'Super')) {
        mod.thisWrites.push({ node: w.node, scope: w.scope, fn: w.fn, opaque: true,
          what: `${w.mutOn}.${w.mutName} through a container holding \`this\` may write the code slot` });
        continue;
      }
      const vb = valueBindings(w.rootExpr, w.scope);
      if (vb === null) {
        mod.unprovableWrites.push({ node: w.node, scope: w.scope });
        continue;
      }
      if (vb === 'boundary') {
        // A target rooted at a local CLASS or function binding mutates the
        // declaration's own object (`Object.assign(A.prototype, …)`): void
        // the declaration's proof exactly like a direct write does — through
        // the root's whole identity group (`const K = A; K.prototype.…`).
        let root = w.rootExpr;
        while (root.type === 'MemberExpression') root = root.object;
        if (root.type === 'Identifier') {
          const b = w.scope.lookup(root.name);
          if (b !== null) {
            const seen = new Set([b]);
            const queue = [b];
            while (queue.length > 0) {
              const cur = queue.pop();
              if (cur.kind === 'class' || cur.kind === 'function') {
                noteAssignment(cur, w.node, w.scope, 'mutate', false);
              }
              for (const l of mod.aliasLinks.get(cur) ?? []) {
                if (!seen.has(l)) { seen.add(l); queue.push(l); }
              }
            }
          }
        }
        continue;
      }
      for (const b of vb) noteAssignment(b, w.node, w.scope, 'mutate', false, null, true);
      noteMutatorStore(w, vb);
      continue;
    }
    if (w.kind === 'rootMutate') {
      const vb = valueBindings(w.rootExpr, w.scope);
      if (vb === null) {
        // A member write whose root proves nothing: refused outright.
        mod.unprovableWrites.push({ node: w.node, scope: w.scope });
        continue;
      }
      if (vb === 'boundary') continue;
      for (const b of vb) noteAssignment(b, w.node, w.scope, 'mutate', false);
      if (w.valueNode !== undefined) {
        // A store THROUGH the root (`[holder][0].x = e`) makes every resolved
        // root HOLD the stored value.
        const stored = valueBindings(w.valueNode, w.scope);
        if (stored === null) {
          for (const b of vb) {
            if (b !== null) mod.unprovableAliasSources.push({ node: w.node, scope: w.scope, names: [b.name] });
          }
        } else if (stored !== 'boundary') {
          for (const b of vb) for (const t of stored) linkContainer(b, t);
        }
      }
      continue;
    }
    if (w.kind === 'containerStore') {
      const b = w.scope.lookup(w.name);
      if (b !== null) {
        const vb = valueBindings(w.valueNode, w.scope);
        if (vb === null) mod.unprovableAliasSources.push({ node: w.node, scope: w.scope, names: [w.name] });
        // Storing INTO a container is containment, whatever the value's shape:
        // the container now holds the value; it is not the value.
        else if (vb !== 'boundary') for (const t of vb) linkContainer(b, t);
      }
      continue;
    }
  }

  // Destructuring preserves identity too: `const { x: alias } = { x: err }`
  // makes alias name the same object as err. What this reader cannot prove it
  // REFUSES (recorded for the flag pass): a spread or a computed key in the
  // literal initializer, a default or a rest element or a computed key in the
  // pattern — each may still carry an alias of a proved value. Duplicate keys
  // follow LAST-wins precedence; array holes extract as undefined, so only
  // their own position is skipped. The initializer may also be an IDENTIFIER
  // holding an unreassigned literal container (`const holder = { x: err }`)
  // — resolved through the binding; anything else is an unprovable alias
  // source, refused when an extracted binding is later mutated.
  // Target names resolve in `scope`; the source literal lives in sourceScope.
  const linkDestructured = (pattern, init, scope, sourceScope = scope) => {
    const refuse = (node) => mod.unprovableExtractions.push({ node, scope });
    // A simple target — a declaration (`const x = …`) or an iteration target
    // (`for (const alias of [e])`, `for (alias of [e])`) — names the value
    // itself: link it to every binding the value expression may refer to
    // (conditionals, logicals, sequences and awaits included), or register the
    // unprovable source.
    if (pattern.type === 'Identifier') {
      if (init !== null && init !== undefined) {
        const vb = valueBindings(init, sourceScope);
        if (vb === null) {
          mod.unprovableAliasSources.push({ node: pattern, scope, names: [pattern.name] });
        } else {
          linkValue(scope.lookup(pattern.name), init, vb);
        }
        // 'boundary': a call or construction — the documented ceiling.
      }
      return;
    }
    if ((pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern')
      && init !== null && init !== undefined && init.type === 'Identifier') {
      // The container name resolves in the SOURCE's scope: a destructured
      // iterable element belongs to the iterable, and an inner shadow of its
      // name must not substitute.
      const b = sourceScope.lookup(init.name);
      if (b !== null && b.kind === 'import' && b.exported === '*') {
        // `const { codedLine: s2 } = ns`: extracting from a NAMESPACE names
        // that export — recorded so a CALL of the extracted binding resolves.
        if (pattern.type === 'ObjectPattern') {
          for (const prop of pattern.properties) {
            if (prop.type !== 'Property') continue;
            if (prop.value.type === 'AssignmentPattern') continue;
            const key = staticKey(prop);
            if (key === null) continue;
            const target = prop.value;
            if (target.type !== 'Identifier') continue;
            const tb = scope.lookup(target.name);
            if (tb !== null) mod.extractedOrigins.set(tb, { module: b.module, exported: key });
          }
        } else {
          mod.unprovableAliasSources.push({ node: pattern, scope, names: [...patternNames(pattern)] });
        }
        return;
      }
      if (b !== null && b.kind === 'var' && b.init !== null && b.init !== undefined
        && (b.init.type === 'ObjectExpression' || b.init.type === 'ArrayExpression')
        // Stores (`box.f = sink`) are mutations of the literal's CONTENT, not
        // of the binding: the literal still describes the container, and the
        // stores' links are consulted just below.
        && (mod.assignmentsByBinding.get(b) ?? []).every((w) => w.kind === 'mutate')) {
        linkDestructured(pattern, b.init, scope, b.scope);
        // Members STORED after the literal (`box.f = sink`) live in the
        // container's links: an extracted target may hold any of them.
        for (const name of patternNames(pattern)) {
          const tb = scope.lookup(name);
          for (const content of mod.containerLinks.get(b) ?? []) link(tb, content);
        }
      } else {
        mod.unprovableAliasSources.push({ node: pattern, scope, names: [...patternNames(pattern)] });
      }
      return;
    }
    if ((pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern')
      && init !== null && init !== undefined && init.type === 'MemberExpression') {
      const resolved = resolveMemberPath(init, sourceScope);
      if (resolved !== null) linkDestructured(pattern, resolved.node, scope, resolved.scope);
      else if (!memberSourceIsClean(init, sourceScope)) {
        mod.unprovableAliasSources.push({ node: pattern, scope, names: [...patternNames(pattern)] });
      }
      return;
    }
    if (pattern.type === 'ObjectPattern' && init !== null && init !== undefined
      && init.type === 'ObjectExpression') {
      if (init.properties.some((p) => p.type === 'SpreadElement' || isComputedUnknown(p))) {
        refuse(pattern);
        return;
      }
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') { refuse(prop); continue; }
        if (prop.value.type === 'AssignmentPattern') { refuse(prop); continue; } // the default may win
        const key = staticKey(prop);
        if (key === null) { refuse(prop); continue; }
        // Duplicate keys: the LAST property wins at runtime, so the link must
        // follow the last — a first-match read would link the wrong value.
        const matches = init.properties.filter((p) => p.type === 'Property' && staticKey(p) === key);
        const source = matches[matches.length - 1];
        if (source === undefined) continue;
        const target = prop.value;
        if (target.type === 'Identifier') {
          // The extracted value resolves like any value expression — including
          // a member-valued one (`{ x: holder.x }`).
          const vb = valueBindings(source.value, sourceScope);
          if (vb === null) {
            mod.unprovableAliasSources.push({ node: prop, scope, names: [target.name] });
          } else {
            linkValue(scope.lookup(target.name), source.value, vb);
          }
        } else if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
          linkDestructured(target, source.value, scope, sourceScope);
        }
      }
      return;
    } else if (pattern.type === 'ArrayPattern' && init !== null && init !== undefined
      && init.type === 'ArrayExpression') {
      // Spreads of provable iterables expand; anything else refuses.
      const elements = iterableElements(init, sourceScope);
      if (elements === null) { refuse(pattern); return; }
      for (let i = 0; i < pattern.elements.length; i++) {
        const el = pattern.elements[i];
        if (!el) continue; // an elided pattern position extracts nothing
        if (el.type === 'AssignmentPattern') { refuse(el); continue; }
        if (el.type === 'RestElement') { refuse(el); continue; }
        const source = elements[i];
        if (source === null || source === undefined) continue; // a hole or past-the-end yields undefined: no alias
        if (el.type === 'Identifier') {
          const vb = valueBindings(source.node, source.scope);
          if (vb === null) {
            mod.unprovableAliasSources.push({ node: el, scope, names: [el.name] });
          } else {
            linkValue(scope.lookup(el.name), source.node, vb);
          }
        } else if (el.type === 'ObjectPattern' || el.type === 'ArrayPattern') {
          linkDestructured(el, source.node, scope, source.scope);
        }
      }
      return;
    }
    // Every remaining extraction shape: a call or construction boundary is
    // the documented ceiling, and a primitive initializer carries no alias.
    // Anything else is an unprovable alias source — registered for the
    // mutation-conditional refusal, never silently skipped.
    if (init !== null && init !== undefined
      && init.type !== 'CallExpression' && init.type !== 'NewExpression'
      && init.type !== 'Literal' && init.type !== 'TemplateLiteral' && init.type !== 'UnaryExpression') {
      mod.unprovableAliasSources.push({ node: pattern, scope, names: [...patternNames(pattern)] });
    }
  };
  for (const { pattern, init, scope } of mod.patternInits) linkDestructured(pattern, init, scope);

  for (const loop of mod.loopSites) {
    const elements = iterableElements(loop.iterable, loop.scope);
    if (elements === null) {
      mod.unprovableAliasSources.push({ node: loop.node, scope: loop.scope, names: [...patternNames(loop.pattern)] });
      continue;
    }
    for (const el of elements) if (el !== null) linkDestructured(loop.pattern, el.node, loop.scope, el.scope);
  }


  // An unprovable alias source is only dangerous when a target binding is
  // later MUTATED — then the mutation may reach a proved value through the
  // alias. An unmutated target can hold anything; nothing propagates. Runs
  // last, when every link and write is recorded.
  const seenExtractionNodes = new Set();
  for (const u of mod.unprovableAliasSources) {
    if (seenExtractionNodes.has(u.node)) continue;
    for (const name of u.names) {
      const b = u.scope.lookup(name);
      if (b !== null && mutationReaches(mod, b)) {
        seenExtractionNodes.add(u.node);
        mod.unprovableExtractions.push({ node: u.node, scope: u.scope });
        break;
      }
    }
  }
  return mod;
}

/** Promote mutations of `this` ALIASES into thisWrites: `const self = this;
 * self.code = …` mutates the instance exactly like a direct write. An alias
 * belongs to the `this` of its nearest NON-ARROW function (arrows share the
 * outer `this`), and alias links only propagate within the same home. */
function promoteThisAliases(mod) {
  const home = (scope) => {
    for (let s = scope; s !== null; s = s.parent) {
      if (s.kind === 'function' && s.node.type !== 'ArrowFunctionExpression') return s.node;
    }
    return null;
  };
  // Does a value expression pass `this` through? Only value-preserving forms
  // count — a call boundary ends provenance, and a regular function rebinds
  // `this`, so neither appears here.
  const containsThis = (node) => {
    switch (node.type) {
      case 'ThisExpression': return true;
      case 'ObjectExpression':
        return node.properties.some((p) => (p.type === 'SpreadElement' ? containsThis(p.argument) : containsThis(p.value)));
      case 'ArrayExpression':
        return node.elements.some((el) => el !== null && containsThis(el.type === 'SpreadElement' ? el.argument : el));
      case 'ConditionalExpression': return containsThis(node.consequent) || containsThis(node.alternate);
      case 'LogicalExpression': return containsThis(node.left) || containsThis(node.right);
      case 'SequenceExpression': return containsThis(node.expressions[node.expressions.length - 1]);
      case 'AwaitExpression': return containsThis(node.argument);
      case 'ChainExpression': return containsThis(node.expression);
      case 'AssignmentExpression': return containsThis(node.right);
      default: return false;
    }
  };
  const seeds = new Map(); // binding -> { home, container } — container seeds propagate only DEEP writes
  const seedIf = (b, valueNode) => {
    if (valueNode === null || valueNode === undefined || seeds.has(b) || !containsThis(valueNode)) return;
    const literal = valueNode.type === 'ObjectExpression' || valueNode.type === 'ArrayExpression';
    seeds.set(b, { home: home(b.scope), container: literal });
  };
  for (const b of mod.bindingsList) seedIf(b, b.init);
  for (const [b, writes] of mod.assignmentsByBinding) {
    for (const w of writes) if (w.kind === 'value') seedIf(b, w.node);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [a, links] of mod.aliasLinks) {
      for (const b of links) {
        if (seeds.has(a) && !seeds.has(b) && home(b.scope) === seeds.get(a).home) { seeds.set(b, seeds.get(a)); grew = true; }
        else if (seeds.has(b) && !seeds.has(a) && home(a.scope) === seeds.get(b).home) { seeds.set(a, seeds.get(b)); grew = true; }
      }
    }
    // A container holding a `this` alias (`const box = { t: this }`): only a
    // DEEP member write on it can reach the instance.
    for (const [container, contents] of mod.containerLinks ?? []) {
      for (const c of contents) {
        if (seeds.has(c) && !seeds.has(container) && home(container.scope) === seeds.get(c).home) {
          seeds.set(container, { home: seeds.get(c).home, container: true });
          grew = true;
        }
      }
    }
  }
  for (const [b, writes] of mod.assignmentsByBinding) {
    if (!seeds.has(b)) continue;
    const seed = seeds.get(b);
    for (const w of writes) {
      if (w.kind === 'mutate' && (!seed.container || w.deep === true)) {
        mod.thisWrites.push({ node: w.node, scope: w.scope, fn: seed.home, opaque: true,
          what: seed.container
            ? 'a container holding `this` is deeply mutated, which may write the code slot'
            : 'a `this` alias is mutated, which may write the code slot' });
      }
    }
  }
}

export function collectErrorSurface(srcDir, repoRoot = srcDir, { allowlist = [] } = {}) {
  const modules = new Map();
  const load = (rel) => {
    if (modules.has(rel)) return modules.get(rel);
    let mod;
    try {
      mod = readModule(rel, readFileSync(join(repoRoot, rel), 'utf8'));
      if (mod !== undefined) promoteThisAliases(mod);
    } catch {
      mod = undefined; // outside the repository (a package), or unparseable
    }
    modules.set(rel, mod);
    return mod;
  };
  const scanned = [...walkMjs(srcDir)].map((p) => relative(repoRoot, p));
  for (const rel of scanned) load(rel);

  const codes = new Map();
  const unrecognized = [];
  const familySites = new Map();
  const defaultsUsed = new Map();
  const allowHits = new Map(allowlist.map((a) => [`${a.file}::${a.snippet}`, 0]));

  const note = (label) => familySites.set(label, (familySites.get(label) ?? 0) + 1);
  const record = (code, rel, line) => {
    if (!codes.has(code)) codes.set(code, new Set());
    codes.get(code).add(`${rel}:${line}`);
  };
  const snippet = (mod, node) => mod.text.slice(node.start, Math.min(node.end, node.start + 160)).replace(/\s+/g, ' ');
  const flag = (rel, line, text, reason) => {
    const clean = text.replace(/\s+/g, ' ').slice(0, 160);
    for (const entry of allowlist) {
      if (entry.file !== rel || !clean.includes(entry.snippet)) continue;
      allowHits.set(`${entry.file}::${entry.snippet}`, (allowHits.get(`${entry.file}::${entry.snippet}`) ?? 0) + 1);
      for (const code of entry.codes ?? []) record(code, rel, line);
      note('allowlisted');
      return;
    }
    unrecognized.push({ rel, line, text: clean, reason });
  };

  // --- cross-module resolution ---------------------------------------------
  // A scanned module that failed to parse, and any direct eval: the reader
  // cannot see what they raise, so both are refused rather than skipped.
  for (const rel of scanned) {
    const mod = modules.get(rel);
    if (mod === undefined) {
      flag(rel, 1, rel, 'the module could not be parsed, so its raise surface is unknown');
      continue;
    }
    for (const site of mod.evalSites) {
      // A local binding with the same name shadows the global: not our call.
      const global = site.what === 'call' ? 'Function' : site.what === 'globalThis-eval' ? 'globalThis' : site.what === 'global-eval' ? 'global' : 'eval';
      if (site.scope.lookup(global) !== null) continue;
      flag(rel, site.node.loc.start.line, snippet(mod, site.node),
        site.what === 'call'
          ? 'calling the Function global compiles code this reader cannot see'
          : 'a reference to the eval global is code this reader cannot see');
    }
    // A destructuring extraction this reader cannot prove may still alias a
    // proved value: refused, never silently unlinked.
    for (const site of mod.unprovableExtractions) {
      flag(rel, site.node.loc.start.line, snippet(mod, site.node),
        'a destructuring extraction this reader cannot prove may alias a proved value');
    }
    // A write whose root or stored value proves nothing may reach a proved
    // value just the same.
    for (const site of mod.unprovableWrites) {
      flag(rel, site.node.loc.start.line, snippet(mod, site.node),
        'a write whose target or value this reader cannot prove may reach a proved value');
    }
  }
  /** Where an exported name is defined: { module, local } | null (unprovable) | undefined (outside). */
  const resolveExport = (moduleRel, exported, seen = new Set()) => {
    const mod = load(moduleRel);
    if (mod === undefined) return undefined;
    const key = `${moduleRel}:${exported}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const entry = mod.exportsMap.get(exported);
    if (entry === undefined) return mod.exportsMap.has('*') ? null : null;
    if (entry.kind === 'reexport') return resolveExport(entry.module, entry.exported, seen);
    if (entry.kind === 'nsstar') return { module: entry.module, local: '*' }; // a re-exported NAMESPACE
    if (entry.kind === 'star') return null;
    // A local export list may re-export an imported binding.
    const imported = mod.imports.get(entry.local);
    if (imported !== undefined) {
      if (imported.exported === '*') return { module: imported.module, local: '*' }; // a namespace, re-exported
      return resolveExport(imported.module, imported.exported, seen);
    }
    // A local CONST alias of an import (`export const x = codedLine`,
    // `export const ns2 = ns`, `export default alias`) names what it aliases.
    const aliased = followLocalAlias(mod, entry.local);
    if (aliased !== null) {
      if (aliased.tainted || aliased.exported === null) return null; // reassigned or computed: unprovable
      if (aliased.exported === '*') return { module: aliased.module, local: '*' };
      return resolveExport(aliased.module, aliased.exported, seen);
    }
    return { module: moduleRel, local: entry.local };
  };
  // Bound once resolveCalleeOrigin exists (it is declared with the sinks).
  let followLocalAlias = () => null;

  /** Resolve an identifier in a scope to a declaration record, following imports. */
  const resolveIdentifier = (mod, scope, name, seen = new Set()) => {
    const binding = scope.lookup(name);
    if (binding === null) return { kind: 'unresolved', name };
    if (binding.kind !== 'import') return { kind: 'binding', mod, binding };
    const origin = resolveExport(binding.module, binding.exported, seen);
    if (origin === undefined) return { kind: 'external', name, module: binding.module };
    if (origin === null) return { kind: 'unresolved', name };
    const target = load(origin.module);
    if (target === undefined) return { kind: 'external', name, module: origin.module };
    const decl = target.scope.lookup(origin.local);
    if (decl === null) return { kind: 'unresolved', name };
    return { kind: 'binding', mod: target, binding: decl };
  };

  const classNodeOf = (resolved) => {
    if (resolved.kind !== 'binding') return null;
    const b = resolved.binding;
    // A REASSIGNED binding no longer names its declaration: `F = class {…}`
    // after `class F extends Error {}` voids the declaration's proof. So does
    // a member write anywhere in its identity group — `K.prototype.code = …`
    // with `const K = F` mutates every instance.
    if ((resolved.mod.assignmentsByBinding.get(b) ?? []).length > 0
      || mutationReaches(resolved.mod, b)) return null;
    // The superclass must resolve in the scope where the class is DECLARED —
    // a function-scoped `class Base extends Error {}` is invisible from the
    // module scope.
    if (b.kind === 'class') return { mod: resolved.mod, node: b.node, scope: b.scope };
    // `const X = class extends Error {}` is a declaration too.
    if (b.kind === 'var' && b.init && (b.init.type === 'ClassExpression')) return { mod: resolved.mod, node: b.init, scope: b.scope };
    return null;
  };

  /** true: proved error class. false: proved NOT one. null: UNKNOWN — the
   * extends chain cannot be followed to a proof either way, and unknown must
   * be refused, never silently skipped. */
  const isErrorClass = (entry, seen = new Set()) => {
    if (entry === null) return null;
    const key = `${entry.mod.rel}:${entry.node.start}`;
    if (seen.has(key)) return null; // a cycle proves nothing
    seen.add(key);
    const sup = entry.node.superClass;
    if (sup === null || sup === undefined) return false; // no extends: provably not an Error
    if (sup.type !== 'Identifier') return null; // `extends mixin(Base)` and the like: unprovable
    // A local declaration SHADOWS the language built-in (`class Error {…}`), so
    // the built-in shortcut applies only when no binding is in scope.
    if (entry.scope.lookup(sup.name) === null && BUILTIN_ERRORS.has(sup.name)) return true;
    const resolved = resolveIdentifier(entry.mod, entry.scope, sup.name);
    // `const Parent = Error` (never reassigned) is a proved alias of a built-in.
    if (resolved.kind === 'binding' && resolved.binding.kind === 'var'
      && resolved.binding.init !== null && resolved.binding.init !== undefined
      && resolved.binding.init.type === 'Identifier' && BUILTIN_ERRORS.has(resolved.binding.init.name)
      && (resolved.mod.assignmentsByBinding.get(resolved.binding) ?? []).length === 0) return true;
    if (resolved.kind !== 'binding' && NON_ERROR_CONSTRUCTORS.has(sup.name)) return false; // `extends Map`
    return isErrorClass(classNodeOf(resolved), seen);
  };

  /** Resolve an identifier callee to the function it names, by BINDING
   * identity — through import chains (a renamed import included) and
   * unreassigned const aliases of a function. A REASSIGNED binding proves
   * nothing: the declaration may no longer be what the name calls. */
  const resolveFunctionRef = (mod, scope, name, seen = new Set()) => {
    const resolved = resolveIdentifier(mod, scope, name);
    if (resolved.kind !== 'binding') return null;
    const b = resolved.binding;
    if ((resolved.mod.assignmentsByBinding.get(b) ?? []).length > 0
      || mutationReaches(resolved.mod, b)) return null;
    if (b.kind === 'function') return { mod: resolved.mod, node: b.node };
    if (b.kind === 'var' && b.init !== null && b.init !== undefined) {
      if (b.init.type === 'FunctionExpression' || b.init.type === 'ArrowFunctionExpression') {
        return { mod: resolved.mod, node: b.init };
      }
      if (b.init.type === 'Identifier' && !seen.has(b)) {
        seen.add(b);
        return resolveFunctionRef(resolved.mod, b.scope, b.init.name, seen);
      }
    }
    return null;
  };

  /** A module-level `const X = 'literal'`, the only non-literal a code may be. */
  const literalOf = (mod, scope, node) => {
    if (isString(node)) return node.value;
    if (node.type === 'Identifier') {
      const b = scope.lookup(node.name);
      if (b !== null && b.kind === 'var' && b.scope.kind === 'module' && b.init && isString(b.init)
        && (mod.assignmentsByBinding.get(b) ?? []).length === 0) {
        return b.init.value;
      }
    }
    return null;
  };

  // --- a class's instance code slot ----------------------------------------
  const slotCache = new Map();
  const slotFor = (entry, seen = new Set()) => {
    if (entry === null) return null;
    const key = `${entry.mod.rel}:${entry.node.start}`;
    if (slotCache.has(key)) return slotCache.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const compute = () => {
      const body = entry.node.body.body;
      // A static block runs arbitrary code at class definition —
      // `static { this.prototype.code = … }` installs a code every instance
      // inherits. Unprovable: refused, never skipped (and never crashed on —
      // a StaticBlock has no member key).
      if (body.some((el) => el.type === 'StaticBlock')) {
        return { kind: 'unprovable', what: 'a static block may install a prototype code at class definition' };
      }
      for (const el of body) {
        if (isComputedUnknown(el)) {
          return { kind: 'unprovable', what: 'a computed member key that may be `code`' };
        }
      }
      // The instance's code may be declared as a member (`get code()`, a field)
      // OR written in the constructor — but not both, and not twice: runtime
      // precedence decides between them, so a conflict is refused, not guessed.
      let memberSlot = null;
      for (const el of body) {
        const name = staticKey(el);
        if (name !== 'code' || el.static) continue;
        let slot;
        if (el.type === 'MethodDefinition' && el.kind === 'get') {
          const stmts = el.value.body.body;
          const ret = stmts.length === 1 && stmts[0].type === 'ReturnStatement' ? stmts[0].argument : null;
          slot = ret !== null && isString(ret)
            ? { kind: 'fixed', code: ret.value }
            : { kind: 'unprovable', what: 'get code() returning a non-literal' };
        } else if (el.type === 'PropertyDefinition') {
          slot = el.value !== null && isString(el.value)
            ? { kind: 'fixed', code: el.value.value }
            : { kind: 'unprovable', what: 'a code field with a non-literal value' };
        } else {
          // A `code()` method or `set code()` accessor is not a value slot:
          // err.code would be the function, or a write would invoke the setter.
          slot = { kind: 'unprovable', what: `a code ${el.kind === 'set' ? 'setter' : 'method'}, which is not a value slot` };
        }
        if (memberSlot !== null) return { kind: 'unprovable', what: 'more than one member named `code`' };
        memberSlot = slot;
      }
      const ctor = body.find((el) => el.type === 'MethodDefinition' && el.kind === 'constructor');
      // `this.code` written anywhere but directly in the constructor body — a
      // method, a getter/setter body, or a nested function — mutates the slot
      // at a time this reader cannot order: unprovable. Static members are
      // exempt: there `this` is the class itself, not the instance. An opaque
      // `this` write (Object.assign(this, …)) may target the code slot.
      {
        const staticMembers = body.filter((el) => el.type === 'StaticBlock' || el.static === true);
        const targetsCode = (w) => w.opaque === true || (w.node.left.computed
          ? !isString(w.node.left.property) || w.node.left.property.value === 'code'
          : w.node.left.property.name === 'code');
        const stray = entry.mod.thisWrites.find((w) => w.fn !== (ctor === undefined ? null : ctor.value)
          && w.node.start >= entry.node.start && w.node.end <= entry.node.end
          && !staticMembers.some((el) => w.node.start >= el.start && w.node.end <= el.end
            && w.viaPrototype !== true) // `this` in a static member IS the class: .prototype writes hit instances
          && targetsCode(w));
        if (stray !== undefined) return { kind: 'unprovable', what: 'this.code is written outside the constructor body' };
      }
      let ctorSlot = null;
      if (ctor !== undefined) {
        // A constructor that RETURNS an object replaces the instance at
        // runtime: the slot analysis is moot. Only a bare `return;` or a
        // primitive literal provably keeps the instance.
        const replacing = entry.mod.returnSites.find((s) => s.fn === ctor.value
          && s.expr !== null && s.expr !== undefined
          && s.expr.type !== 'Literal' && s.expr.type !== 'TemplateLiteral');
        if (replacing !== undefined) {
          return { kind: 'unprovable', what: 'the constructor returns a value that may replace the instance' };
        }
        const params = ctor.value.params;
        ctorSlot = slotFromConstructor(entry, ctor, params);
      }
      if (memberSlot !== null && ctorSlot !== null) {
        return { kind: 'unprovable', what: 'code is declared both as a class member and as a constructor write' };
      }
      const ownSlot = memberSlot !== null ? memberSlot : ctorSlot;
      // Inherit: what this class hands the parent's slot. The parent is
      // consulted even when this class declares its OWN slot: an ancestor
      // constructor RETURNING an object replaces the instance wholesale, and
      // this class's members are never installed on the replacement — so an
      // unprovable parent poisons the subclass too.
      const sup = entry.node.superClass;
      const hasParent = sup !== null && sup !== undefined && sup.type === 'Identifier'
        && !(entry.scope.lookup(sup.name) === null && BUILTIN_ERRORS.has(sup.name));
      if (!hasParent) return ownSlot;
      const parent = classNodeOf(resolveIdentifier(entry.mod, entry.scope, sup.name));
      const parentSlot = slotFor(parent, seen);
      if (parentSlot !== null && parentSlot.kind === 'unprovable') return parentSlot;
      if (ownSlot !== null) return ownSlot;
      if (parentSlot === null) return null;
      if (ctor === undefined) return parentSlot; // the default constructor forwards every argument
      if (parentSlot.kind === 'fixed') return parentSlot;
      // The parent's slot is fed by ITS constructor parameter, so the subclass's
      // super() call decides. The super call comes from the recorded call
      // sites: its arguments resolve in their real scope. An argument this
      // reader cannot prove must NOT fall back to the parent's slot — the
      // parent's `arg` shape describes the PARENT's callers, and the runtime
      // code is whatever the expression evaluated to.
      const superCalls = entry.mod.callSites.filter((c) => c.node.callee.type === 'Super'
        && c.fn === ctor.value
        && c.node.start >= ctor.value.body.start && c.node.end <= ctor.value.body.end);
      if (superCalls.length !== 1) {
        return { kind: 'unprovable', what: `${superCalls.length === 0 ? 'no' : 'several'} super() calls feed the parent's code slot` };
      }
      const passed = readSlotArgs(entry.mod, superCalls[0].scope, superCalls[0].node.arguments, parentSlot);
      if (passed.code !== null) return { kind: 'fixed', code: passed.code };
      if (passed.missing) {
        // No argument for the slot: an option default applies; an argument slot
        // receives undefined and the instance is codeless.
        return parentSlot.kind === 'option' && parentSlot.default !== null && parentSlot.default !== undefined
          ? { kind: 'fixed', code: parentSlot.default }
          : null;
      }
      if (passed.paramName !== null) {
        const at = provedParamIndex(entry.mod, ctor.value, passed.paramName, superCalls[0].scope);
        if (at !== -1) return { kind: 'arg', index: at };
      }
      return { kind: 'unprovable', what: `super(${passed.expr ?? passed.paramName ?? '…'}) does not provably supply the parent's code slot` };
    };
    const result = compute();
    slotCache.set(key, result);
    return result;
  };

  function slotFromConstructor(entry, ctor, params) {
    // The writes come from the walk's own records, each with the scope it was
    // written in — so the right-hand side resolves against the binding that is
    // ACTUALLY in scope at the write, not against a name match.
    const writes = entry.mod.thisWrites.filter((w) => w.fn === ctor.value);
    const opaque = writes.find((w) => w.opaque === true);
    if (opaque !== undefined) return { kind: 'unprovable', what: opaque.what };
    const computedWrite = writes.find((w) => w.node.left.computed && !isString(w.node.left.property));
    if (computedWrite !== undefined) return { kind: 'unprovable', what: 'this[<computed>] = … in the constructor' };
    const codeWrites = writes.filter((w) => (w.node.left.computed
      ? w.node.left.property.value === 'code'
      : w.node.left.property.name === 'code'));
    // Every write is inspected: the LAST write wins at runtime, so reading the
    // first of several would record a code the error never carries.
    if (codeWrites.length > 1) return { kind: 'unprovable', what: 'this.code is written more than once in the constructor' };
    if (codeWrites.length === 0) return null;
    const w = codeWrites[0];
    const node = w.node;
    if (node.operator !== '=') return { kind: 'unprovable', what: `this.code is updated with ${node.operator}, not assigned` };
    const rhs = node.right;
    if (isString(rhs)) return { kind: 'fixed', code: rhs.value };
    if (rhs.type === 'Identifier') {
      const lit = literalOf(entry.mod, w.scope, rhs);
      if (lit !== null) return { kind: 'fixed', code: lit };
      // The right-hand side must be THIS constructor's own, never-reassigned
      // parameter. A reassigned parameter, or an inner binding shadowing the
      // name, makes the write unprovable: runtime carries the rewritten value,
      // not the caller's argument.
      const rec = entry.mod.functions.get(ctor.value);
      const binding = w.scope.lookup(rhs.name);
      if (binding !== null && binding.kind === 'param' && rec !== undefined && binding.scope === rec.scope
        && (entry.mod.assignmentsByBinding.get(binding) ?? []).length === 0) {
        const at = params.findIndex((p) => p.type === 'Identifier' && p.name === rhs.name);
        if (at !== -1) return { kind: 'arg', index: at };
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          const pattern = p.type === 'AssignmentPattern' ? p.left : p;
          if (pattern.type !== 'ObjectPattern') continue;
          for (const prop of pattern.properties) {
            if (prop.type !== 'Property') continue;
            const target = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (target === binding.node) {
              const dflt = prop.value.type === 'AssignmentPattern' && isString(prop.value.right)
                ? prop.value.right.value : null;
              return { kind: 'option', index: i, default: dflt, field: staticKey(prop) ?? prop.key.name };
            }
          }
        }
      }
    }
    return { kind: 'unprovable', what: `this.code = ${entry.mod.text.slice(rhs.start, rhs.end)}` };
  }

  /** Read the code out of a call's arguments for a slot. */
  function readSlotArgs(mod, scope, args, slot) {
    if (slot.kind === 'fixed') return { code: slot.code, paramName: null, expr: null, missing: false };
    // A spread at or before the slot's position shifts every later index: the
    // AST node AT the position is not the argument that lands there.
    if (args.slice(0, slot.index + 1).some((a) => a !== undefined && a !== null && a.type === 'SpreadElement')) {
      return { code: null, paramName: null, expr: 'a spread at or before the code position shifts the arguments', missing: false };
    }
    if (slot.kind === 'arg') {
      const arg = args[slot.index];
      if (arg === undefined) return { code: null, paramName: null, expr: null, missing: true };
      const lit = literalOf(mod, scope, arg);
      if (lit !== null) return { code: lit, paramName: null, expr: null, missing: false };
      return {
        code: null,
        paramName: arg.type === 'Identifier' ? arg.name : null,
        expr: mod.text.slice(arg.start, arg.end),
        missing: false,
      };
    }
    const bag = args[slot.index];
    if (bag === undefined || bag.type !== 'ObjectExpression') {
      return { code: null, paramName: null, expr: bag === undefined ? null : mod.text.slice(bag.start, bag.end), missing: bag === undefined };
    }
    if (bag.properties.some((p) => p.type === 'SpreadElement')) {
      return { code: null, paramName: null, expr: 'a spread element that may carry or override the code', missing: false };
    }
    if (bag.properties.some((p) => p.type === 'Property' && !p.computed && staticKey(p) === '__proto__')) {
      return { code: null, paramName: null, expr: 'a __proto__ initializer that may install an inherited code', missing: false };
    }
    const codeProps = bag.properties.filter((p) => p.type === 'Property' && !isComputedUnknown(p) && staticKey(p) === (slot.field ?? 'code'));
    if (codeProps.length > 1) return { code: null, paramName: null, expr: 'a duplicate code key', missing: false };
    for (const prop of bag.properties) {
      if (prop.type !== 'Property') continue;
      if (isComputedUnknown(prop)) return { code: null, paramName: null, expr: 'a computed property key', missing: false };
      if (staticKey(prop) !== (slot.field ?? 'code')) continue;
      const lit = literalOf(mod, scope, prop.value);
      if (lit !== null) return { code: lit, paramName: null, expr: null, missing: false };
      return {
        code: null,
        paramName: prop.value.type === 'Identifier' ? prop.value.name : null,
        expr: mod.text.slice(prop.value.start, prop.value.end),
        missing: false,
      };
    }
    return { code: null, paramName: null, expr: null, missing: true };
  }

  // --- constructions --------------------------------------------------------
  const forwarders = new Map(); // `${rel}:${fnStart}` -> { mod, fnNode, index, name }
  const enumeratedNew = new Set(); // NewExpression nodes proved to build an error class

  /** The index of `name` among fnNode's simple parameters — but only when the
   * identifier at the SITE resolves to that very parameter binding (an inner
   * shadow resolves elsewhere) and the parameter is never written. */
  const provedParamIndex = (mod, fnNode, name, siteScope) => {
    if (fnNode === null || fnNode === undefined) return -1;
    const rec = mod.functions.get(fnNode);
    if (rec === undefined || rec.scope === undefined) return -1;
    const binding = siteScope.lookup(name);
    if (binding === null || binding.kind !== 'param' || binding.scope !== rec.scope) return -1;
    if ((mod.assignmentsByBinding.get(binding) ?? []).length > 0) return -1;
    return fnNode.params.findIndex((p) => p.type === 'Identifier' && p.name === name);
  };

  const fnKey = (mod, fnNode) => (fnNode === null ? null : `${mod.rel}:${fnNode.start}`);

  for (const rel of scanned) {
    const mod = modules.get(rel);
    if (mod === undefined) continue;
    for (const site of mod.newSites) {
      const { node, scope, fn } = site;
      const line = node.loc.start.line;
      if (node.callee.type !== 'Identifier') {
        flag(rel, line, snippet(mod, node), 'constructor is not a plain identifier, so it cannot be resolved to a class');
        continue;
      }
      const name = node.callee.name;
      const resolved = resolveIdentifier(mod, scope, name);
      // The language built-ins carry no tool code — but only when no LOCAL
      // binding shadows the name (`class Error { code = … }` throws that code).
      if (resolved.kind === 'unresolved' && BUILTIN_ERRORS.has(name)) continue;
      const entry = classNodeOf(resolved);
      if (entry === null) {
        if (NON_ERROR_CONSTRUCTORS.has(name) && (resolved.kind === 'external' || resolved.kind === 'unresolved')) continue;
        if (resolved.kind === 'binding' && resolved.binding.kind === 'var') {
          flag(rel, line, snippet(mod, node), 'constructor is a value binding, not a class declaration');
          continue;
        }
        flag(rel, line, snippet(mod, node), 'constructor identifier does not resolve to a class declared in this source tree');
        continue;
      }
      const errClass = isErrorClass(entry);
      if (errClass === null) {
        // UNKNOWN is not "proved harmless": the extends chain cannot be
        // followed to a built-in Error, so the construction is refused.
        flag(rel, line, snippet(mod, node), 'the extends chain does not provably reach a built-in Error');
        continue;
      }
      // A class PROVED not to extend Error is not skipped on that ground
      // alone: errorCode reads `code` off ANY thrown value, so the class's own
      // slot decides — a plain class with no code slot at all is codeless.
      enumeratedNew.add(node);
      const slot = slotFor(entry);
      note(`class ${entry.node.id ? entry.node.id.name : '(anonymous)'}${slot === null ? ' (codeless)' : ''}`);
      if (slot === null) continue;
      if (slot.kind === 'unprovable') {
        flag(rel, line, `${snippet(mod, node)} — the class declares ${slot.what}`, 'the class declares a code this reader cannot resolve to a literal');
        continue;
      }
      const res = readSlotArgs(mod, scope, node.arguments, slot);
      if (res.code !== null) { record(res.code, rel, line); continue; }
      if (res.missing) {
        const fallback = slot.kind === 'option' ? slot.default : null;
        if (fallback !== null && fallback !== undefined) {
          record(fallback, rel, line);
          const cname = entry.node.id ? entry.node.id.name : '(anonymous)';
          if (!defaultsUsed.has(cname)) defaultsUsed.set(cname, { code: fallback, sites: new Set() });
          defaultsUsed.get(cname).sites.add(`${rel}:${line}`);
          continue;
        }
        flag(rel, line, snippet(mod, node), 'no code argument and no class default');
        continue;
      }
      const at = res.paramName === null ? -1 : provedParamIndex(mod, fn, res.paramName, scope);
      if (at !== -1) {
        // Keyed by function AND position: a function may forward several code
        // parameters from several constructions, and each is resolved.
        forwarders.set(`${fnKey(mod, fn)}|${at}`, { mod, fnNode: fn, index: at, name: fnNameOf(mod, fn) });
        continue;
      }
      flag(rel, line, `${snippet(mod, node)} … code: ${res.expr}`, 'code expression is not a whole string literal');
    }
  }

  function fnNameOf(mod, fnNode) {
    if (fnNode.id) return fnNode.id.name;
    for (const [name, b] of mod.scope.bindings) if (b.node === fnNode || b.init === fnNode) return name;
    for (const scope of [mod.scope]) {
      for (const [name, b] of scope.bindings) if (b.init === fnNode) return name;
    }
    return null;
  }

  // --- forwarders to a fixpoint --------------------------------------------
  const resolvedFwd = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, fwd] of [...forwarders]) {
      if (resolvedFwd.has(key)) continue;
      resolvedFwd.add(key);
      changed = true;
      if (fwd.name === null) {
        flag(fwd.mod.rel, fwd.fnNode.loc.start.line, snippet(fwd.mod, fwd.fnNode).slice(0, 80),
          'a function forwarding a code has no resolvable name, so its call sites cannot be found');
        continue;
      }
      let sites = 0;
      for (const rel of scanned) {
        const mod = modules.get(rel);
        if (mod === undefined) continue;
        for (const call of mod.callSites) {
          const { node, scope, fn } = call;
          // Callers are matched by resolved function IDENTITY, never by
          // spelling: a renamed import (`import { make as renamed }`) or a
          // const alias names the same function under another local name.
          if (node.callee.type !== 'Identifier') continue;
          const target = resolveFunctionRef(mod, scope, node.callee.name);
          if (target === null || target.node !== fwd.fnNode) continue;
          sites++;
          note(`forwarder ${fwd.name} (${fwd.mod.rel})`);
          const line = node.loc.start.line;
          if (node.arguments.slice(0, fwd.index + 1).some((a) => a.type === 'SpreadElement')) {
            flag(rel, line, snippet(mod, node), 'a spread at or before the forwarded code position shifts the arguments');
            continue;
          }
          const arg = node.arguments[fwd.index];
          if (arg === undefined) { flag(rel, line, snippet(mod, node), `no argument at the forwarded code position ${fwd.index}`); continue; }
          const lit = literalOf(mod, scope, arg);
          if (lit !== null) { record(lit, rel, line); continue; }
          const at = arg.type === 'Identifier' ? provedParamIndex(mod, fn, arg.name, scope) : -1;
          if (at !== -1) {
            forwarders.set(`${fnKey(mod, fn)}|${at}`, { mod, fnNode: fn, index: at, name: fnNameOf(mod, fn) });
            continue;
          }
          flag(rel, line, `${snippet(mod, node)} … code: ${mod.text.slice(arg.start, arg.end)}`, 'forwarded code is not a whole string literal');
        }
      }
      if (sites === 0) {
        flag(fwd.mod.rel, fwd.fnNode.loc.start.line, `${fwd.name}()`, 'forwards a code but has no resolvable call site');
      }
    }
  }

  // --- renderer sinks, resolved by binding ---------------------------------
  //
  // THE CONTRACT. The renderer is a function, and a function is a value: it
  // can be stored in a container, a class field, a parameter, a return value,
  // a closure — and invoked from any of them. Following it there is where
  // every earlier version of this reader was defeated, one shape a round, and
  // it is not what src/ does: src/ calls the renderer through its import
  // binding and nothing else. So the reader now proves the NEGATIVE instead of
  // chasing the positive: the renderer, and every namespace that carries it,
  // may be referenced in exactly four positions —
  //
  //   1. as the DIRECT CALLEE of a call (`codedLine(…)`, `ns.codedLine(…)`,
  //      `codedLine.call(…)` with the code position shifted by one);
  //   2. as the initializer of a CONST identifier declarator (an alias);
  //   3. as the OBJECT of a member expression naming an export — for a
  //      namespace, whose member is then held to the same four positions;
  //      for the renderer itself only `.call`, `.apply` and `.bind`, the last
  //      two refused at the call — or, for a namespace held by an import
  //      binding, as the initializer of a const object-pattern declarator
  //      whose keys are all static (`const { codedLine: s2 } = ns`);
  //   4. as an EXPORT (`export { codedLine }`, `export default codedLine`,
  //      `export * as ns from …`).
  //
  // Every other reference — a call argument, an array or object literal, a
  // class field, a return value, a right-hand side, a conditional or sequence
  // arm, `typeof`, a comparison, a `let`/`var` declarator, `new` — is an
  // ESCAPE: refused at the reference, with file:line and the text. Once the
  // renderer cannot escape, a callee that is not import-rooted is provably
  // not the renderer, and is not resolved at all — there is no container,
  // store, field, getter or return-path machinery left to be wrong.
  //
  // Two doors are closed with the same rule: a dynamic `import()` whose
  // specifier is not a literal may load the renderer's module, so it is
  // refused (the one in src/capture.mjs is a reviewed site), and a scanned
  // module that imports another repository module OUTSIDE the scanned tree
  // is refused, because that module's references are not checked here. The
  // exact-pinned dependencies are outside the repository and cannot import it;
  // that is the ceiling, named in test/error-codes.test.mjs.

  /** Resolve a BINDING to an import origin: an import binding, a const alias
   * chain of one, a namespace member extracted into a const, an awaited
   * literal dynamic import, or a namespace destructuring extraction. Tainted
   * marks a chain this reader cannot prove: a REASSIGNED alias, or a computed
   * member of a namespace — the caller must refuse, not skip. */
  const resolveBindingOrigin = (mod, binding, seen = new Set()) => {
    if (binding === null || seen.has(binding)) return null;
    seen.add(binding);
    if (binding.kind === 'import') return { module: binding.module, exported: binding.exported, tainted: false };
    if (binding.kind !== 'var' || binding.declKind !== 'const') return null; // a let/var alias is refused where it is declared
    if (binding.init !== null && binding.init !== undefined) {
      const inner = resolveCalleeOrigin(mod, binding.init, binding.scope, seen);
      if (inner !== null && (mod.assignmentsByBinding.get(binding) ?? []).length > 0) inner.tainted = true;
      return inner;
    }
    const direct = mod.extractedOrigins.get(binding);
    if (direct !== undefined) return { ...direct, tainted: false };
    return null;
  };

  /** Read or refuse the code argument of a known sink call. */
  const readSinkCall = (mod, rel, node, scope, index) => {
    const line = node.loc.start.line;
    if (node.arguments.slice(0, index + 1).some((a) => a.type === 'SpreadElement')) {
      flag(rel, line, snippet(mod, node), 'a spread at or before the code position shifts the arguments');
      return;
    }
    const arg = node.arguments[index];
    if (arg === undefined) { flag(rel, line, snippet(mod, node), `no argument at the code position ${index}`); return; }
    const lit = literalOf(mod, scope, arg);
    if (lit !== null) { record(lit, rel, line); return; }
    flag(rel, line, `${snippet(mod, node)} … code: ${mod.text.slice(arg.start, arg.end)}`, 'rendered code is not a whole string literal');
  };
  /** What a callee EXPRESSION resolves to: { module, exported, tainted } or
   * null (not an import-rooted callee at all). Follows const-alias chains of
   * import bindings (`const alias = codedLine`), namespace member calls
   * (`renderer.codedLine(...)`), namespace aliases (`const ns2 = ns`), members
   * extracted into a const (`const f = ns.codedLine`), and awaited literal
   * dynamic imports. Tainted marks a chain this reader cannot prove: a
   * REASSIGNED alias, or a computed member of a namespace — the caller must
   * refuse, not skip. */
  const resolveCalleeOrigin = (mod, expr, scope, seen = new Set()) => {
    if (expr.type === 'Identifier') {
      const binding = scope.lookup(expr.name);
      if (binding === null) return null;
      if (binding.kind === 'import') return { module: binding.module, exported: binding.exported, tainted: false };
      if (binding.kind !== 'var' || binding.declKind !== 'const') return null; // a let/var alias is refused where it is declared
      if (binding.init !== null && binding.init !== undefined && !seen.has(binding)) {
        seen.add(binding);
        const inner = resolveCalleeOrigin(mod, binding.init, binding.scope, seen);
        if (inner === null) return null;
        if ((mod.assignmentsByBinding.get(binding) ?? []).length > 0) inner.tainted = true;
        return inner;
      }
      // A pattern-declared binding: an extraction origin recorded at link
      // time (`const { codedLine: s2 } = ns`).
      const direct = mod.extractedOrigins.get(binding);
      if (direct !== undefined) return { ...direct, tainted: (mod.assignmentsByBinding.get(binding) ?? []).length > 0 };
      return null;
    }
    if (expr.type === 'AwaitExpression') {
      // The namespace of a dynamic import is reached ONLY as `await
      // import('literal')`, directly: the promise itself is never followed.
      if (expr.argument.type === 'ImportExpression') {
        const target = mod.dynamicImports.get(expr.argument);
        return target === undefined ? null : { module: target, exported: '*', tainted: false };
      }
      return resolveCalleeOrigin(mod, expr.argument, scope, seen);
    }
    if (expr.type === 'ChainExpression') return resolveCalleeOrigin(mod, expr.expression, scope, seen);
    if (expr.type === 'MemberExpression') {
      let ns = resolveCalleeOrigin(mod, expr.object, scope, seen);
      if (ns !== null && ns.exported !== '*' && ns.exported !== null) {
        // The object may be a re-exported NAMESPACE (`export * as nsx from …`,
        // or a list re-export of a namespace import): follow it.
        const inner = resolveExport(ns.module, ns.exported);
        if (inner !== null && inner !== undefined && inner.local === '*') {
          ns = { module: inner.module, exported: '*', tainted: ns.tainted };
        }
      }
      if (ns === null || ns.exported !== '*') return null;
      if (ns.tainted) return { module: ns.module, exported: null, tainted: true };
      if (expr.computed) {
        if (isString(expr.property)) return { module: ns.module, exported: expr.property.value, tainted: false };
        return { module: ns.module, exported: null, tainted: true };
      }
      if (expr.property.type !== 'Identifier') return null;
      return { module: ns.module, exported: expr.property.name, tainted: false };
    }
    return null;
  };

  followLocalAlias = (mod, name) => {
    const b = mod.scope.lookup(name);
    if (b === null || b.kind !== 'var' || b.declKind !== 'const' || b.init === null || b.init === undefined) return null;
    return resolveCalleeOrigin(mod, b.init, b.scope);
  };

  /** Does an origin { module, exported } name the sink export? */
  const originIsSink = (origin, sink) => {
    if (origin === null || origin === undefined || origin.exported === null || origin.exported === '*') return false;
    const resolved = resolveExport(origin.module, origin.exported);
    return resolved !== undefined && resolved !== null && resolved.module === sink.module && resolved.local === sink.exported;
  };

  /** Does a module's namespace CARRY the sink — export it under any name,
   * directly, through a chain, or through a star re-export (a star that
   * cannot be enumerated is assumed to)? Memoized per sink. */
  const carriesMemo = new Map();
  const moduleCarriesSink = (moduleRel, sink, seen = new Set()) => {
    const memoKey = `${moduleRel}::${sink.module}::${sink.exported}`;
    if (carriesMemo.has(memoKey)) return carriesMemo.get(memoKey);
    if (seen.has(moduleRel)) return false;
    seen.add(moduleRel);
    const mod = load(moduleRel);
    let carries = false;
    if (mod !== undefined) {
      if (moduleRel === sink.module) carries = mod.exportsMap.has(sink.exported);
      for (const [name, entry] of mod.exportsMap) {
        if (carries) break;
        if (name === '*') { carries = load(entry.module) === undefined ? false : moduleCarriesSink(entry.module, sink, seen); continue; }
        const resolved = resolveExport(moduleRel, name);
        if (resolved === undefined) continue;
        if (resolved === null) { carries = true; continue; } // unresolvable: may be the sink
        if (resolved.local === '*') carries = moduleCarriesSink(resolved.module, sink, seen);
        else carries = resolved.module === sink.module && resolved.local === sink.exported;
      }
    }
    carriesMemo.set(memoKey, carries);
    return carries;
  };

  /** What an EXPRESSION bears, for the escape check: { kind: 'sink' },
   * { kind: 'namespace', module } (a namespace that carries the sink),
   * { kind: 'computed' } (a computed member of such a namespace — refused by
   * the caller), { kind: 'dynamic' } (a non-literal dynamic import), or null
   * (provably neither). */
  const bearing = (mod, expr, scope, sink) => {
    const classify = (origin) => {
      if (origin === null) return null;
      if (origin.exported === null) return { kind: 'computed' };
      if (origin.exported === '*') return moduleCarriesSink(origin.module, sink) ? { kind: 'namespace', module: origin.module } : null;
      const resolved = resolveExport(origin.module, origin.exported);
      if (resolved === undefined) return null; // outside the repository: the ceiling
      if (resolved === null) return load(origin.module) === undefined ? null : { kind: 'sink' }; // unresolvable in-tree: may be
      if (resolved.local === '*') return moduleCarriesSink(resolved.module, sink) ? { kind: 'namespace', module: resolved.module } : null;
      return resolved.module === sink.module && resolved.local === sink.exported ? { kind: 'sink' } : null;
    };
    if (expr.type === 'Identifier') {
      const binding = scope.lookup(expr.name);
      if (binding === null) return null;
      // The sink's own declaration, in the module that defines it.
      if (mod.rel === sink.module && binding.kind !== 'import' && mod.scope.lookup(sink.exported) === binding) return { kind: 'sink' };
      return classify(resolveBindingOrigin(mod, binding));
    }
    if (expr.type === 'AwaitExpression') return bearing(mod, expr.argument, scope, sink);
    if (expr.type === 'ChainExpression') return bearing(mod, expr.expression, scope, sink);
    if (expr.type === 'ImportExpression') {
      const target = mod.dynamicImports.get(expr);
      if (target === undefined) return { kind: 'dynamic' };
      return moduleCarriesSink(target, sink) ? { kind: 'namespace', module: target } : null;
    }
    if (expr.type === 'MemberExpression') {
      const object = bearing(mod, expr.object, scope, sink);
      if (object === null || object.kind !== 'namespace') return null;
      const key = memberKey(expr);
      if (key === null) return { kind: 'computed' };
      return classify({ module: object.module, exported: key });
    }
    return null;
  };

  /** Is an Identifier node a declaration or write TARGET rather than a
   * reference that reads the binding's value? */
  const isBindingTarget = (mod, node) => {
    const p = mod.parentOf.get(node);
    if (p === undefined) return true;
    switch (p.type) {
      case 'VariableDeclarator': return p.id === node;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        return p.id === node || p.params.includes(node);
      case 'ClassDeclaration': case 'ClassExpression': return p.id === node;
      case 'CatchClause': return p.param === node;
      case 'ArrayPattern': case 'RestElement': return true;
      case 'AssignmentPattern': return p.left === node;
      case 'Property': return p.value === node && mod.parentOf.get(p)?.type === 'ObjectPattern';
      case 'AssignmentExpression': return p.left === node;
      case 'UpdateExpression': return true;
      case 'ForInStatement': case 'ForOfStatement': return p.left === node;
      case 'BreakStatement': case 'ContinueStatement': case 'LabeledStatement': case 'MetaProperty':
      case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': case 'ExportSpecifier':
        return true;
      default: return false;
    }
  };

  const ESCAPE_REASON = 'the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export';
  /** Refuse every reference to the renderer, or to a namespace carrying it,
   * that stands anywhere but the four sanctioned positions. */
  const checkSinkEscapes = (mod, rel, sink) => {
    // The refusal quotes the enclosing statement, member or declaration, so
    // the position the renderer stands in is visible at a glance.
    const escape = (node) => {
      let ctx = node;
      for (let p = mod.parentOf.get(node); p !== undefined; p = mod.parentOf.get(p)) {
        ctx = p;
        if (/(Statement|Declaration)$/.test(p.type) || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') break;
      }
      flag(rel, node.loc.start.line, snippet(mod, ctx), ESCAPE_REASON);
    };
    const isCallOf = (p, expr) => p.type === 'CallExpression' && p.callee === expr;
    const isSimpleObjectPattern = (pattern) => pattern.type === 'ObjectPattern'
      && pattern.properties.every((pr) => pr.type === 'Property' && !isComputedUnknown(pr) && pr.value.type === 'Identifier');
    const check = (expr, scope, what) => {
      if (what === null) return;
      if (what.kind === 'computed') {
        flag(rel, expr.loc.start.line, snippet(mod, expr), 'a computed member of a namespace that carries the renderer cannot be resolved to an export');
        return;
      }
      if (what.kind === 'dynamic') {
        flag(rel, expr.loc.start.line, snippet(mod, expr), 'a dynamic import whose specifier is not a literal may load the renderer');
        return;
      }
      const p = mod.parentOf.get(expr);
      if (p === undefined) { escape(expr); return; }
      // `import(…)` is a PROMISE of the namespace: only `await` unwraps it
      // here; `.then`, a binding, an argument all carry it away.
      if (expr.type === 'ImportExpression') {
        if (p.type === 'AwaitExpression') { check(p, scope, what); return; }
        escape(expr);
        return;
      }
      if (isCallOf(p, expr)) return; // 1. the direct callee — read or refused by the call pass
      if (p.type === 'TaggedTemplateExpression' && p.tag === expr) return; // refused by the tag pass
      if (p.type === 'AwaitExpression' || p.type === 'ChainExpression') { check(p, scope, what); return; }
      if (p.type === 'MemberExpression' && p.object === expr) {
        const gp = mod.parentOf.get(p);
        if (what.kind === 'sink') {
          // 3. `.call` shifts the code position; `.apply`/`.bind` are refused
          // by the call pass. Any other member read is the renderer as a value.
          const key = memberKey(p);
          if (!p.computed && (key === 'call' || key === 'apply' || key === 'bind') && gp !== undefined && isCallOf(gp, p)) return;
          escape(p);
          return;
        }
        // A namespace member: what it names decides, and is held to the
        // same positions in turn.
        check(p, scope, bearing(mod, p, scope, sink));
        return;
      }
      if (p.type === 'VariableDeclarator' && p.init === expr) {
        const decl = mod.parentOf.get(p);
        if (decl !== undefined && decl.kind === 'const') {
          if (p.id.type === 'Identifier') return; // 2. a const alias
          // A namespace destructuring extraction is recorded at link time
          // ONLY from an import binding with static keys.
          if (what.kind === 'namespace' && expr.type === 'Identifier' && isSimpleObjectPattern(p.id)) {
            const b = scope.lookup(expr.name);
            if (b !== null && b.kind === 'import' && b.exported === '*') return;
          }
        }
        escape(expr);
        return;
      }
      if (p.type === 'ExportDefaultDeclaration') return; // 4. an export
      escape(expr);
    };
    for (const ref of mod.identifierRefs) {
      if (isBindingTarget(mod, ref.node)) continue;
      check(ref.node, ref.scope, bearing(mod, ref.node, ref.scope, sink));
    }
    // Dynamic imports are expressions, not identifiers: checked from their node.
    for (const site of mod.importSites) check(site.node, site.scope, bearing(mod, site.node, site.scope, sink));
    // A repository module outside the scanned tree is not checked for escapes.
    const outside = (target) => target !== sink.module && !scannedSet.has(target) && load(target) !== undefined;
    for (const site of mod.importDecls) {
      if (outside(site.module)) {
        flag(rel, site.node.loc.start.line, snippet(mod, site.node), 'imports a repository module outside the scanned tree, whose renderer references are not checked');
      }
    }
    for (const [node, target] of mod.dynamicImports) {
      if (outside(target)) {
        flag(rel, node.loc.start.line, snippet(mod, node), 'imports a repository module outside the scanned tree, whose renderer references are not checked');
      }
    }
  };

  const scannedSet = new Set(scanned);
  for (const rel of scanned) {
    const mod = modules.get(rel);
    if (mod === undefined) continue;
    for (const sink of CODE_SINKS) {
      checkSinkEscapes(mod, rel, sink);
      // The renderer's own module calls it from errorLine with the error
      // object's code — every code that can carry is raised, and enumerated,
      // at a construction site. Its export list is pinned by the test file.
      if (rel === sink.module) continue;
      for (const call of mod.callSites) {
        const { node, scope } = call;
        // `codedLine.call(null, …)` invokes the renderer with a thisArg first:
        // the code argument shifts by one. `.apply` hides the arguments in an
        // array and `.bind` doesn't call at all — both refused.
        let calleeExpr = node.callee;
        let via = null;
        if (calleeExpr.type === 'MemberExpression' && !calleeExpr.computed
          && calleeExpr.property.type === 'Identifier'
          && (calleeExpr.property.name === 'call' || calleeExpr.property.name === 'apply' || calleeExpr.property.name === 'bind')) {
          via = calleeExpr.property.name;
          calleeExpr = calleeExpr.object;
        }
        const callee = resolveCalleeOrigin(mod, calleeExpr, scope);
        // Not import-rooted: provably not the renderer, because every way of
        // holding the renderer in a value is refused where it escapes.
        if (callee === null) continue;
        if (callee.tainted || callee.exported === null) {
          // A computed member of a namespace is refused by the escape check
          // when the namespace carries the renderer.
          if (callee.exported === null) continue;
          if (originIsSink(callee, sink)) {
            flag(rel, node.loc.start.line, snippet(mod, node), 'an alias of the renderer is reassigned, so the call is unprovable');
          }
          continue;
        }
        const origin = resolveExport(callee.module, callee.exported);
        if (origin === undefined) continue; // outside the repository
        if (origin === null) {
          flag(rel, node.loc.start.line, snippet(mod, node), 'imported binding is called but its origin cannot be resolved inside this tree');
          continue;
        }
        if (origin.module !== sink.module || origin.local !== sink.exported) continue;
        const line = node.loc.start.line;
        if (via === 'apply' || via === 'bind') {
          flag(rel, line, snippet(mod, node), `the renderer invoked through .${via} has arguments this reader cannot index`);
          continue;
        }
        const index = sink.index + (via === 'call' ? 1 : 0);
        note(`renderer ${sink.exported} (as ${calleeExpr.type === 'Identifier' ? calleeExpr.name : '…'})`);
        readSinkCall(mod, rel, node, scope, index);
      }
      // A tagged template INVOKES its tag: `codedLine\`…\`` calls the renderer
      // with the strings array at index 0 and substitutions after — no code
      // position is provably literal, so an invocation of the sink is refused.
      for (const tag of mod.tagSites) {
        const callee = resolveCalleeOrigin(mod, tag.node.tag, tag.scope);
        if (callee === null || callee.exported === null) continue;
        if (!originIsSink(callee, sink)) continue;
        flag(rel, tag.node.loc.start.line, snippet(mod, tag.node), 'the renderer invoked as a template tag has no provable code position');
      }
    }
  }

  // --- throws ---------------------------------------------------------------
  /* Mutations of the VALUE a binding's group holds: identity-linked bindings
   * denote the same object (any member write counts); a CONTAINER of a group
   * member only propagates deep writes — `holder.x.code = …` reaches the held
   * value, a shallow `holder.x = …` store does not. Rebindings of an alias do
   * NOT propagate: they change what the alias names, not the object. */
  const unreassignedCatch = (mod, binding) => binding !== null && binding.kind === 'catch'
    && (mod.assignmentsByBinding.get(binding) ?? []).length === 0
    && !mutationReaches(mod, binding);

  /** A binding whose every value is provably a caught error or an enumerated
   * construction. Any recorded write — rebinding, destructuring target, loop
   * target, `err.code = …` property mutation, `delete`, Object.assign — is
   * among the values, and none of those nodes is a proof. */
  const provedThrownBinding = (mod, binding) => {
    if (unreassignedCatch(mod, binding)) return true;
    if (binding === null || binding.kind !== 'var') return false;
    if (mutationReaches(mod, binding)) return false;
    const values = [
      ...(binding.init ? [{ node: binding.init, scope: binding.scope }] : []),
      ...(mod.assignmentsByBinding.get(binding) ?? []),
    ];
    return values.length > 0 && values.every(({ node: v, scope: where }) => {
      if (v.type === 'NewExpression') return enumeratedNew.has(v);
      // An identifier resolves in the scope where the assignment was written,
      // not where the throw is: `catch (e) { held = e; }` binds the catch
      // parameter even though `e` is out of scope at the throw.
      if (v.type === 'Identifier') return unreassignedCatch(mod, where.lookup(v.name));
      if (v.type === 'Literal') return true; // a literal carries no code
      return false;
    });
  };

  // A thrown CALL throws what the callee RETURNS, so the callee's return paths
  // — not the constructions that happen to appear in its body — decide what
  // the throw carries. Every return path must provably produce an enumerated
  // construction, a value proved like a thrown identifier, a call whose own
  // returns are proved, or a value with no code slot at all (a literal, a
  // fresh array or function, undefined). A returned parameter substitutes the
  // call's argument at that position, proved at the CALL site. The proof is
  // therefore CALL-DEPENDENT and is deliberately NOT cached per function: a
  // proof made for one call's arguments says nothing about another call's.

  const provableReturnedValue = (exprMod, expr, exprScope, call, seen) => {
    // Primitives and fresh callable/array objects carry no `code` slot.
    if (expr.type === 'Literal' || expr.type === 'TemplateLiteral' || expr.type === 'ArrayExpression'
      || expr.type === 'FunctionExpression' || expr.type === 'ArrowFunctionExpression') return true;
    if (expr.type === 'NewExpression') {
      if (enumeratedNew.has(expr)) return true;
      // An unshadowed language built-in carries no tool code.
      return expr.callee.type === 'Identifier' && exprScope.lookup(expr.callee.name) === null
        && BUILTIN_ERRORS.has(expr.callee.name);
    }
    if (expr.type === 'Identifier') {
      if (expr.name === 'undefined' && exprScope.lookup('undefined') === null) return true;
      const binding = exprScope.lookup(expr.name);
      if (provedThrownBinding(exprMod, binding)) return true;
      // A parameter passed straight through: the CALL's argument decides.
      if (call !== null && binding !== null && binding.kind === 'param'
        && (exprMod.assignmentsByBinding.get(binding) ?? []).length === 0) {
        const fnNode = binding.scope.kind === 'function' ? binding.scope.node : null;
        const at = fnNode === null ? -1 : provedParamIndex(exprMod, fnNode, expr.name, exprScope);
        if (at !== -1) {
          // A spread at or before the position shifts every later argument:
          // the AST node AT the index is not the argument that lands there.
          if (call.node.arguments.slice(0, at + 1).some((a) => a !== undefined && a.type === 'SpreadElement')) {
            return false;
          }
          const passedArg = call.node.arguments[at];
          if (passedArg === undefined) return true; // missing: undefined carries no code
          if (passedArg.type !== 'SpreadElement') {
            return provableReturnedValue(call.mod, passedArg, call.scope, null, seen);
          }
        }
      }
      return false;
    }
    if (expr.type === 'CallExpression' && expr.callee.type === 'Identifier') {
      const nested = resolveFunctionRef(exprMod, exprScope, expr.callee.name);
      return nested !== null && returnsProved(nested.mod, nested.node, { node: expr, scope: exprScope, mod: exprMod }, seen);
    }
    return false;
  };

  const returnsProved = (calleeMod, fnNode, call, seen = new Set()) => {
    // An async function returns a Promise, a generator an iterator: a fresh
    // object with no code slot, whatever the bodies return.
    if (fnNode.async || fnNode.generator) return true;
    const key = `${calleeMod.rel}:${fnNode.start}`;
    if (seen.has(key)) return false; // a recursive return chain proves nothing
    seen.add(key);
    // No return with a value at all: the function returns undefined (codeless)
    // or never returns. Both are provable.
    const ok = calleeMod.returnSites
      .filter((s) => s.fn === fnNode)
      .every((s) => s.expr === null || s.expr === undefined
        || provableReturnedValue(calleeMod, s.expr, s.scope, call, seen));
    seen.delete(key);
    return ok;
  };

  for (const rel of scanned) {
    const mod = modules.get(rel);
    if (mod === undefined) continue;
    for (const site of mod.throwSites) {
      const { node, scope } = site;
      const arg = node.argument;
      const line = node.loc.start.line;
      if (arg.type === 'NewExpression') continue; // read by the construction pass
      note('throw (non-construction)');
      if (arg.type === 'ObjectExpression') {
        const props = arg.properties;
        // A `__proto__` initializer installs a PROTOTYPE: the thrown object
        // may inherit a `code` it does not own.
        if (props.some((p) => p.type === 'Property' && !p.computed && staticKey(p) === '__proto__')) {
          flag(rel, line, snippet(mod, node), 'thrown object sets __proto__, which may install an inherited `code`');
          continue;
        }
        // A spread may carry a `code`, or override one written earlier — and
        // an earlier spread is overridden by a later one. Unprovable.
        if (props.some((p) => p.type === 'SpreadElement')) {
          flag(rel, line, snippet(mod, node), 'thrown object has a spread that may carry or override `code`');
          continue;
        }
        const computed = props.find((p) => p.type === 'Property' && isComputedUnknown(p));
        if (computed !== undefined) {
          flag(rel, line, snippet(mod, node), 'thrown object has a computed key that may be `code`');
          continue;
        }
        const codeProps = props.filter((p) => p.type === 'Property' && staticKey(p) === 'code');
        // The LATER duplicate wins at runtime; recording the first would name
        // a code the thrown object never carries.
        if (codeProps.length > 1) {
          flag(rel, line, snippet(mod, node), 'thrown object writes `code` more than once');
          continue;
        }
        if (codeProps.length === 1) {
          const lit = literalOf(mod, scope, codeProps[0].value);
          if (lit !== null) record(lit, rel, line);
          else {
            flag(rel, line, `${snippet(mod, node)} … code: ${mod.text.slice(codeProps[0].value.start, codeProps[0].value.end)}`,
              'thrown object carries a code that is not a whole string literal');
          }
        }
        continue; // an object with no `code` prints uncoded
      }
      if (arg.type === 'Identifier') {
        if (provedThrownBinding(mod, scope.lookup(arg.name))) continue;
        flag(rel, line, snippet(mod, node), 'thrown value is not provably a caught error or an enumerated construction');
        continue;
      }
      if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') {
        const callee = resolveFunctionRef(mod, scope, arg.callee.name);
        if (callee !== null && returnsProved(callee.mod, callee.node, { node: arg, scope, mod })) continue;
        flag(rel, line, snippet(mod, node), 'thrown call does not provably return an enumerated or codeless value');
        continue;
      }
      flag(rel, line, snippet(mod, node), 'thrown expression is neither a construction, an object literal, nor a resolvable identifier');
    }
  }

  const staleAllowlist = [...allowHits.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  return { codes, unrecognized, familySites, defaultsUsed, forwarders, staleAllowlist, modules, scanned };
}
