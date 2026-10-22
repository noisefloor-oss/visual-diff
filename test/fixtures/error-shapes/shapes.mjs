// Fixtures for the error-surface reader (test/helpers/error-surface.mjs).
//
// Every shape here defeated an earlier version of the reader. They are declared
// as real code so the analyzer's behaviour is proven against them rather than
// asserted about. The read/refused partition of every shape is compared
// exactly in test/error-codes.test.mjs — the analyzer's job is to reject what
// it cannot prove, not to guess.
//
// Nothing imports this module at runtime.

import { AliasedFault as ReExportedFault } from './aliased.mjs';
import { codedLine as reviewLine } from '../../../src/cli-error.mjs';
import * as cliError from '../../../src/cli-error.mjs';
import { codedLine as chainLine } from './hop2.mjs';
import defaultRelay from './default-relay.mjs';
import { localRelay } from './local-relay.mjs';
import { make, make as renamedMake, make2 } from './forwarder-mod.mjs';
import { nsx } from './nsrelay.mjs';
import { nsl } from './nslistrelay.mjs';

// --- shapes that must yield a code ------------------------------------------

// (1) a concrete error class whose name does not end in `Error`
export class ReviewFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewFault';
    this.code = code;
    this.exitCode = 3;
  }
}

// (4) a subclass baking its code into the super call
export class DeepFault extends ReviewFault {
  constructor(message) {
    super('FIXTURE_SUPER_FIXED', message);
    this.name = 'DeepFault';
  }
}

// (2) a const-arrow factory forwarding its first parameter
const faultOf = (code, message) => new ReviewFault(code, message);

// (3) a multi-statement helper forwarding a code parameter
function raiseFault(code, message) {
  const detail = ' (helper)';
  throw new ReviewFault(code, `${message}${detail}`);
}

export function raiseConcrete() {
  throw new ReviewFault('FIXTURE_CONCRETE_NAME', 'direct construction');
}

export function raiseThroughArrow() {
  throw faultOf('FIXTURE_ARROW_FACTORY', 'through a const arrow');
}

export function raiseThroughHelper() {
  raiseFault('FIXTURE_MULTI_STATEMENT', 'through a multi-statement helper');
}

export function raiseDeep() {
  throw new DeepFault('through a subclass super call');
}

// --- shapes that must be REFUSED --------------------------------------------

// (5) a code composed at runtime. The inner literal is NOT the code raised:
// kindFor('CONFIG_ERROR') produces UNDOCUMENTED_CONFIG_ERROR.
function kindFor(kind) {
  return `UNDOCUMENTED_${kind}`;
}

export function raiseComputed() {
  throw new ReviewFault(kindFor('CONFIG_ERROR'), 'computed at runtime');
}

// (6) a constructor reached through a value alias
const FaultAlias = ReviewFault;

export function raiseThroughValueAlias() {
  throw new FaultAlias('FIXTURE_VALUE_ALIAS', 'through an aliased binding');
}

// (7) a constructor reached through a re-exported name
export function raiseThroughReExport() {
  throw new ReExportedFault('FIXTURE_RE_EXPORT', 'through a re-export alias');
}

// (8) a constructor obtained from a dynamic import
export async function raiseThroughDynamicImport() {
  const mod = await import('./aliased.mjs');
  throw new mod.AliasedFault('FIXTURE_DYNAMIC_IMPORT', 'through a dynamic import');
}

// (9) an anonymous class expression extending an error class
export function raiseAnonymous() {
  throw new (class extends ReviewFault {
    constructor() {
      super('FIXTURE_ANONYMOUS', 'from an anonymous class expression');
    }
  })();
}

// (10) a thrown object literal that is not an error instance at all. errorLine
// prints whatever `code` it carries, so a whole-literal code counts.
export function raiseThrownObject() {
  throw { code: 'FIXTURE_THROWN_OBJECT', message: 'not an Error instance', exitCode: 3 };
}

// (11) the same shape with a code that is not a whole literal: refused.
export function raiseThrownObjectComputed(kind) {
  throw { code: kindFor(kind), message: 'computed code on a thrown object' };
}

// (12) a thrown value that cannot be proved to be a caught error: refused.
export function raiseThrownValue(fault) {
  throw fault;
}

// (13) a renderer sink reached through a local alias of the import binding.
export function refuseThroughAliasedSink(stderr) {
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_ALIASED_SINK', 'through an aliased sink'));
}

// (14) a class whose code is a getter, not a constructor assignment. errorLine
// reads err.code at runtime, so this is a real emitted code.
export class GetterFault extends Error {
  get code() { return 'FIXTURE_GETTER_CODE'; }
}

export function raiseGetterBacked() {
  throw new GetterFault('getter-backed code');
}

// (15) the same with a code the reader cannot resolve: the class is refused.
export class ComputedGetterFault extends Error {
  get code() { return kindFor('GETTER'); }
}

export function raiseComputedGetter() {
  throw new ComputedGetterFault('computed getter code');
}

// (16) a bare throw of a parameter that merely SHARES A NAME with an earlier,
// unrelated catch binding: refused.
export function raiseShadowedName(items) {
  try {
    items.forEach((item) => item);
  } catch (err) {
    void err;
  }
  return (err) => {
    throw err;
  };
}

// (17) a binding assigned from an unproved value: refused.
export function raiseAssignedFromValue(payload) {
  const fault = payload;
  throw fault;
}

// (18) the renderer reached through a two-hop re-export chain.
export function refuseThroughChainedSink(stderr) {
  stderr.write(chainLine('noise visual-diff review', 'FIXTURE_CHAINED_SINK', 'through two re-export hops'));
}

// --- shapes that need real scopes and bindings ------------------------------

// (19) the catch binding is REASSIGNED before the re-throw: what is thrown is
// no longer the caught error, so the re-throw proves nothing.
export function raiseReassignedCatch(payload) {
  try {
    JSON.parse('{');
  } catch (err) {
    err = payload;
    throw err;
  }
}

// (20) an inner binding that merely SHARES A NAME with an enclosing catch.
export function raiseShadowedCatch() {
  try {
    JSON.parse('{');
  } catch (err) {
    void err;
    return (err) => {
      throw err;
    };
  }
}

// (21) `new Map()` is a construction, but of a proved non-error class.
export function raiseNonErrorConstruction() {
  const fault = new Map();
  throw fault;
}

// (22) a binding proved once, then overwritten by a logical assignment.
export function raiseMutatedBinding(payload) {
  let fault = new ReviewFault('FIXTURE_MUTATED_BEFORE', 'proved at construction');
  fault ||= payload;
  throw fault;
}

// (23) a computed member key: it may be `code`, so the class is unprovable.
const memberKey = 'code';
export class ComputedMemberFault extends Error {
  get [memberKey]() { return 'FIXTURE_COMPUTED_MEMBER'; }
}

export function raiseComputedMember() {
  throw new ComputedMemberFault('computed member key');
}

// (24) `this[key] = …` in the constructor: same reasoning.
export class BracketAssignFault extends Error {
  constructor(message) {
    super(message);
    this[memberKey] = 'FIXTURE_BRACKET_ASSIGN';
  }
}

export function raiseBracketAssign() {
  throw new BracketAssignFault('bracket assignment');
}

// (25) `static code` is the CLASS's property, not the instance's. errorLine
// reads the instance, so this class is codeless — neither read nor refused.
export class StaticCodeFault extends Error {
  static code = 'FIXTURE_STATIC_NEVER_READ';
}

export function raiseStaticCode() {
  throw new StaticCodeFault('static code is not the instance code');
}

// (26) the renderer through a default re-export, and (27) through a local
// export list re-exporting an imported binding.
export function refuseThroughDefaultReExport(stderr) {
  stderr.write(defaultRelay('noise visual-diff review', 'FIXTURE_DEFAULT_REEXPORT', 'x'));
}

export function refuseThroughLocalRelay(stderr) {
  stderr.write(localRelay('noise visual-diff review', 'FIXTURE_LOCAL_RELAY', 'x'));
}

// (28) the catch binding ITSELF mutated with a logical assignment: `||=` is an
// assignment like any other, so the re-thrown binding is no longer the caught
// error and the re-throw proves nothing.
export function raiseCatchLogicallyMutated(payload) {
  try {
    JSON.parse('{');
  } catch (err) {
    err ||= payload;
    throw err;
  }
}

// (29) the catch binding rewritten through a DESTRUCTURING assignment: still a
// binding write, so the re-throw proves nothing either.
export function raiseCatchDestructured(payload) {
  try {
    JSON.parse('{');
  } catch (err) {
    ({ err } = payload);
    throw err;
  }
}

// (30) the catch binding used as a loop target: each iteration rewrites it.
export function raiseCatchLoopTarget(items) {
  try {
    JSON.parse('{');
  } catch (err) {
    for (err of items) void err;
    throw err;
  }
}

// (31) a renderer sink call in a parameter DEFAULT: defaults are executable,
// so the walker must enter them. The code is literal — read.
export function refuseThroughDefaultParam(stderr, line = reviewLine('noise visual-diff review', 'FIXTURE_DEFAULT_PARAM', 'x')) {
  stderr.write(line);
}

// (32) the same, nested inside a destructuring parameter's default.
export function refuseThroughNestedDefault(stderr, { line } = { line: reviewLine('noise visual-diff review', 'FIXTURE_NESTED_DEFAULT', 'x') }) {
  stderr.write(line);
}

// (33) a superclass reached through an unreassigned value alias of a built-in:
// proved, so the code is read.
const BuiltinParent = Error;
export class AliasedParentFault extends BuiltinParent {
  constructor() {
    super('aliased parent');
    this.code = 'FIXTURE_ALIAS_PARENT';
  }
}

export function raiseAliasedParent() {
  throw new AliasedParentFault();
}

// (34) a superclass that resolves to no declaration the reader can prove
// (here: a parameter): UNKNOWN, and unknown is refused, never skipped.
export function raiseDynamicParent(Parent) {
  class DynamicFault extends Parent {
    constructor() {
      super();
      this.code = 'FIXTURE_DYNAMIC_PARENT';
    }
  }
  return new DynamicFault();
}

// (35) a function-scoped error parent: the superclass resolves in the class's
// DECLARATION scope, not the module scope, so the code is read.
export function raiseScopedParent() {
  class ScopedBase extends Error {
    constructor(code) {
      super('scoped');
      this.code = code;
    }
  }
  class ScopedFault extends ScopedBase {}
  return new ScopedFault('FIXTURE_SCOPED_PARENT');
}

// (36) two writes to this.code in one constructor: the LAST wins at runtime,
// so reading the first would record a code the error never carries. Refused.
export class DoubleWriteFault extends Error {
  constructor() {
    super('double write');
    this.code = 'FIXTURE_FIRST_WRITE';
    this.code = 'FIXTURE_SECOND_WRITE';
  }
}

export function raiseDoubleWrite() {
  throw new DoubleWriteFault();
}

// (37) a code field AND a constructor write: the constructor runs after the
// field initializers, so precedence decides — and precedence is refused.
export class FieldAndCtorFault extends Error {
  code = 'FIXTURE_FIELD_CODE';
  constructor() {
    super('field and ctor');
    this.code = 'FIXTURE_CTOR_CODE';
  }
}

export function raiseFieldAndCtor() {
  throw new FieldAndCtorFault();
}

// (38) a thrown object whose code arrives through a spread: the spread may
// carry or override `code`, so the object is unprovable. Refused.
export function raiseThrownSpread() {
  throw { ...{ code: 'FIXTURE_SPREAD_CODE' }, message: 'spread code' };
}

// (39) a thrown object writing code twice: the later duplicate wins at
// runtime. Refused.
export function raiseThrownDuplicate() {
  throw { code: 'FIXTURE_DUP_FIRST', code: 'FIXTURE_DUP_SECOND', message: 'duplicate code keys' };
}

// --- round-3 shapes: mutation, return provenance, aliases, shadowing --------

// (40) a constructed error whose code is OVERWRITTEN before the throw: the
// mutation is a write on the binding's value, so the throw proves nothing.
// (The construction itself is still enumerated — that code was carried,
// briefly.)
export function raiseMutatedConstructed() {
  const err = new ReviewFault('FIXTURE_BEFORE_MUTATION', 'mutated after construction');
  err.code = 'FIXTURE_AFTER_MUTATION';
  throw err;
}

// (41) a caught error whose code is overwritten before the re-throw.
export function raiseMutatedCaught(payload) {
  try {
    JSON.parse('{');
  } catch (err) {
    err.code = 'FIXTURE_CAUGHT_MUTATION';
    throw err;
  }
}

// (42) a helper that CONSTRUCTS an error but RETURNS a coded object: the
// construction in its body proves nothing about the returned value.
function makeCodedObject() {
  const unused = new ReviewFault('FIXTURE_MADE_NOT_RETURNED', 'constructed, not returned');
  void unused;
  return { code: 'FIXTURE_RETURNED_OBJECT' };
}

export function raiseMadeNotReturned() {
  throw makeCodedObject();
}

// (43) the same shape behind a built-in construction: building only Error
// does not make the returned coded object codeless.
function makeBuiltinAndReturn() {
  const e = new Error('plain');
  return { code: 'FIXTURE_BUILTIN_RETURN', message: e.message };
}

export function raiseBuiltinReturn() {
  throw makeBuiltinAndReturn();
}

// (44) the renderer through a const ALIAS of the import binding: read.
const aliasedSink = reviewLine;

export function refuseThroughConstAlias(stderr) {
  stderr.write(aliasedSink('noise visual-diff review', 'FIXTURE_CONST_ALIAS_SINK', 'x'));
}

// (45) the renderer through a NAMESPACE import member call: read.
export function refuseThroughNamespace(stderr) {
  stderr.write(cliError.codedLine('noise visual-diff review', 'FIXTURE_NAMESPACE_SINK', 'x'));
}

// (46) a function-scoped class SHADOWING the language Error: the name-only
// built-in shortcut must not classify it. Its code is read.
export function raiseShadowedBuiltin() {
  class Error {
    constructor() {
      this.code = 'FIXTURE_SHADOWED_BUILTIN';
    }
  }
  return new Error();
}

// (47) the constructor's code parameter is REASSIGNED before the write:
// runtime carries the overwritten value, not the caller's argument. Refused.
export class MutatedParamFault extends Error {
  constructor(code) {
    super('mutated param');
    code = 'FIXTURE_PARAM_OVERWRITE';
    this.code = code;
  }
}

export function raiseMutatedParam() {
  throw new MutatedParamFault('FIXTURE_PARAM_PASSED');
}

// (48) a forwarding helper whose code parameter is reassigned on the way.
function forwardMutated(code) {
  code = 'FIXTURE_FORWARD_OVERWRITE';
  return new ReviewFault(code, 'forwarded after mutation');
}

export function raiseForwardedMutation() {
  throw forwardMutated('FIXTURE_FORWARD_PASSED');
}

// (49) a subclass passing an UNPROVABLE code to super: the parent's argument
// slot describes the parent's callers, not this subclass's. Refused.
export class ComputedSuperFault extends ReviewFault {
  constructor() {
    super(`FIXTURE_${'SUPER_COMPUTED'}`, 'computed super arg');
  }
}

export function raiseComputedSuper() {
  throw new ComputedSuperFault('FIXTURE_SUBCLASS_ARG');
}

// (50) a subclass passing NO argument for the parent's code slot: the runtime
// code is undefined, so the class is codeless — neither read nor refused.
export class MissingSuperFault extends ReviewFault {
  constructor() {
    super();
  }
}

export function raiseMissingSuper() {
  throw new MissingSuperFault();
}

// --- round-4 shapes: caches, aliases, patterns, constructor edges -----------

// (51) an alias of a constructed error is MUTATED: both names denote the same
// object, so the original binding's proof falls with the alias's write.
export function raiseAliasedMutation() {
  const err = new ReviewFault('FIXTURE_ALIAS_BEFORE', 'aliased and mutated');
  const alias = err;
  alias.code = 'FIXTURE_ALIAS_AFTER';
  throw err;
}

// (52) an UNMUTATED alias of a caught error, rethrown: aliasing alone changes
// nothing, and this must stay accepted — the guard against over-refusal.
export function raiseUnmutatedAlias() {
  try {
    JSON.parse('{');
  } catch (err) {
    const alias = err;
    throw alias;
  }
}

// (53) a function forwarding TWO code positions from two constructions: both
// must resolve, not just the last one written into a single-slot map.
function raiseEither(a, b) {
  if (a) throw new ReviewFault(a, 'first position');
  throw new ReviewFault(b, 'second position');
}

export function raiseTwoPositions() {
  raiseEither('FIXTURE_POS_FIRST', 'FIXTURE_POS_SECOND');
}

// (54) and (55): a return proof depends on the CALL's arguments, so it must
// not be cached per function — in EITHER call order.
function identityReturn(x) { return x; }

export function throwSafeCallFirst() {
  try {
    JSON.parse('{');
  } catch (err) {
    throw identityReturn(err);
  }
  throw identityReturn({ code: 'FIXTURE_IDENTITY_CACHE_A' });
}

export function throwUnsafeCallFirst() {
  throw identityReturn({ code: 'FIXTURE_IDENTITY_CACHE_B' });
  try {
    JSON.parse('{');
  } catch (err) {
    throw identityReturn(err);
  }
}

// (56) an executable default inside a declaration PATTERN: it runs when the
// declaration runs, and it throws here. The thrown object's literal code is
// read. (Inside a function so importing this fixture stays inert.)
export function patternDefaultShape() {
  const { x = (() => { throw { code: 'FIXTURE_PATTERN_DEFAULT' }; })() } = {};
  return x;
}

// (57) a constructor RETURNING an object replaces the instance at runtime:
// the returned object's code, not the slot's, is what a catch would see.
export class ReturningCtorFault extends Error {
  constructor() {
    super('returning ctor');
    this.code = 'FIXTURE_CTOR_SLOT';
    return { code: 'FIXTURE_CTOR_RETURN' };
  }
}

export function raiseReturningCtor() {
  throw new ReturningCtorFault();
}

// (58) a destructuring target can be a MEMBER: it mutates the held error
// directly, without rebinding anything.
export function raiseDestructuredMember() {
  const err = new ReviewFault('FIXTURE_DESTRUCT_BEFORE', 'member target');
  ({ code: err.code } = { code: 'FIXTURE_DESTRUCT_AFTER' });
  throw err;
}

// (59) Object.assign on `this` in the constructor may write the code slot.
export class ObjectAssignedFault extends Error {
  constructor() {
    super('object assigned');
    this.code = 'FIXTURE_ASSIGN_SLOT';
    Object.assign(this, { code: 'FIXTURE_ASSIGN_OVERRIDDEN' });
  }
}

export function raiseObjectAssigned() {
  throw new ObjectAssignedFault();
}

// --- round-5 shapes: this-aliases, loop members, declaration bindings --------

// (60) a destructuring write rooted at `this` in the constructor: the pattern
// target may be the code slot, so the class is unprovable even though the
// direct write above it looked safe.
export class ThisDestructFault extends Error {
  constructor() {
    super('this destruct');
    this.code = 'FIXTURE_THIS_SAFE';
    ({ code: this.code } = { code: 'FIXTURE_THIS_DESTRUCT' });
  }
}

export function raiseThisDestruct() {
  throw new ThisDestructFault();
}

// (61) an alias of `this` in the constructor: the mutation lands on the
// instance exactly like a direct write.
export class ThisAliasFault extends Error {
  constructor() {
    super('this alias');
    this.code = 'FIXTURE_THIS_ALIAS_SAFE';
    const self = this;
    self.code = 'FIXTURE_THIS_ALIAS';
  }
}

export function raiseThisAlias() {
  throw new ThisAliasFault();
}

// (62) a bare MEMBER as a loop target: each iteration rewrites the caught
// error's code.
export function raiseLoopMemberTarget() {
  try {
    JSON.parse('{');
  } catch (e) {
    for (e.code of ['FIXTURE_LOOP_MEMBER']) { /* the write is the point */ }
    throw e;
  }
}

// (63) a DESTRUCTURED catch property is an extracted value, not the caught
// error: it never inherits the caught-error proof.
export function raiseDestructuredCatch() {
  try {
    JSON.parse('{');
  } catch ({ nested: e }) {
    throw e;
  }
}

// (64) a rebound class-expression binding: the first declaration no longer
// proves the constructor.
export function raiseReboundClassExpression() {
  let ReboundFault = class extends ReviewFault {};
  ReboundFault = class { code = 'FIXTURE_REBOUND_CLASS'; };
  return new ReboundFault();
}

// (65) a rebound class DECLARATION: same reasoning, one module earlier.
class ReboundDeclared extends Error {
  constructor() {
    super('rebound declared');
    this.code = 'FIXTURE_REBOUND_DECLARED';
  }
}

export function rebindDeclared() {
  ReboundDeclared = class { code = 'FIXTURE_REBOUND_AFTER'; };
}

export function raiseReboundDeclared() {
  throw new ReboundDeclared();
}

// (66) a rebound function binding: the declaration's return paths no longer
// prove what the call returns.
function reboundHelper() {
  return new ReviewFault('FIXTURE_REBOUND_HELPER', 'first incarnation');
}

export function rebindHelper() {
  reboundHelper = () => ({ code: 'FIXTURE_REBOUND_HELPER_AFTER' });
}

export function raiseReboundHelper() {
  throw reboundHelper();
}

// (67) a var declaration hoists OUT of its block at runtime: the alias and the
// mutation outside the block still land on the caught error.
export function raiseHoistedVarAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    if (e) {
      var hoisted = e;
    }
    hoisted.code = 'FIXTURE_HOISTED_VAR';
    throw e;
  }
}

// (68) a forwarder reached through a RENAMED import: identity, not spelling.
// Both call sites must resolve — the direct one must not satisfy coverage for
// the renamed one.
export function raiseDirectForwarder() {
  return make('FIXTURE_DIRECT_FORWARDER');
}

export function raiseRenamedForwarder() {
  return renamedMake('FIXTURE_RENAMED_FORWARDER');
}

// --- round-6 shapes: hoisted writes, ancestor returns, spreads, prototypes ---

// (69) a write that TEXTUALLY precedes the declaration it targets: function
// bodies run after module evaluation, so the rebound lands on the class.
export function rebindEarly() {
  EarlyRebound = class { code = 'FIXTURE_EARLY_REBOUND'; };
}

class EarlyRebound extends Error {
  constructor() {
    super('early');
    this.code = 'FIXTURE_EARLY_DECLARED';
  }
}

export function raiseEarlyRebound() {
  throw new EarlyRebound();
}

// (70) an ancestor constructor that RETURNS an object replaces the instance
// wholesale — the subclass's own `code` member is never installed on it.
export class ReturningParentFault extends Error {
  constructor() {
    super('returning parent');
    return { code: 'FIXTURE_PARENT_RETURN' };
  }
}

export class ChildOfReturning extends ReturningParentFault {
  get code() { return 'FIXTURE_CHILD_MEMBER'; }
}

export function raiseChildOfReturning() {
  throw new ChildOfReturning();
}

// (71) a destructured alias of the caught error: `const { x: alias } =
// { x: e }` preserves identity, so mutating the alias mutates the rethrow.
export function raiseDestructuredAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { x: alias } = { x: e };
    alias.code = 'FIXTURE_DESTRUCT_ALIAS';
    throw e;
  }
}

// (72) a spread at or before a positional code slot shifts the arguments:
// the literal AT the slot's index is not what lands there.
export class SecondSlotFault extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function raiseSpreadShifted() {
  throw new SecondSlotFault(...['FIXTURE_SPREAD_FIRST', 'FIXTURE_SPREAD_SECOND'], 'FIXTURE_SPREAD_THIRD');
}

// (73) the same shift through a forwarder call.
export function raiseSpreadForwarder() {
  return make2(...['FIXTURE_FWD_SPREAD', 'x'], 'FIXTURE_FWD_SAFE');
}

// (74) and through the renderer.
export function refuseSpreadSink(stderr) {
  stderr.write(reviewLine(...['noise visual-diff review', 'FIXTURE_SINK_SPREAD'], 'FIXTURE_SINK_SAFE'));
}

// (75) a thrown object with a __proto__ initializer may INHERIT a code it
// does not own.
export function raiseProtoObject() {
  throw { __proto__: { code: 'FIXTURE_PROTO_INHERITED' }, message: 'proto object' };
}

// (76) the renderer through a namespace ALIAS: provenance preserved — read.
const nsAlias = cliError;

export function refuseThroughNamespaceAlias(stderr) {
  stderr.write(nsAlias.codedLine('noise visual-diff review', 'FIXTURE_NS_ALIAS_SINK', 'x'));
}

// (77) the renderer extracted into a const from the namespace: read.
const extractedSink = cliError.codedLine;

export function refuseThroughExtractedSink(stderr) {
  stderr.write(extractedSink('noise visual-diff review', 'FIXTURE_EXTRACTED_SINK', 'x'));
}

// (78) the renderer invoked through .call: the code argument shifts by one.
export function refuseThroughCall(stderr) {
  stderr.write(reviewLine.call(null, 'noise visual-diff review', 'FIXTURE_CALL_SINK', 'x'));
}

// (79) the renderer invoked through .apply: the argument array is not
// indexable by this reader — refused.
export function refuseThroughApply(stderr) {
  stderr.write(reviewLine.apply(null, ['noise visual-diff review', 'FIXTURE_APPLY_SINK', 'x']));
}

// --- round-7 shapes: alias-link establishment --------------------------------

// (80) a redeclared var keeps ONE binding at runtime: the alias link and the
// mutation must land on the same binding object, or the caught error's proof
// survives a mutation it should not survive.
export function raiseRedeclaredAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    var redeclared = e;
    var redeclared;
    redeclared.code = 'FIXTURE_REDECLARED';
    throw e;
  }
}

// (81) a destructuring ASSIGNMENT (not a declaration) preserves identity too:
// the link from alias to the caught error must follow.
export function raiseAssignDestructuredAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    let alias;
    ({ x: alias } = { x: e });
    alias.code = 'FIXTURE_ASSIGN_DESTRUCT_ALIAS';
    throw e;
  }
}

// (82) duplicate keys in a destructuring initializer: the LAST property wins
// at runtime, so the alias link must follow the last — a first-match read
// would link the wrong value and miss the mutation.
export function raiseDuplicateKeyAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { x: alias } = { x: null, x: e };
    alias.code = 'FIXTURE_DUP_KEY_ALIAS';
    throw e;
  }
}

// --- round-8 shapes: extraction proofs and catch-shadowed var inits ----------

// (83) a var declaration inside a catch block whose name matches the catch
// parameter: the initializer assigns to the CATCH binding at runtime
// (verified against the engine), so the rethrow carries the new object.
export function raiseCatchVarInit() {
  try {
    JSON.parse('{');
  } catch (e) {
    var e = { code: 'FIXTURE_CATCH_VAR_INIT' };
    throw e;
  }
}

// (84) a spread in a destructuring initializer: the extraction is unprovable
// — refused at the declaration, not silently unlinked.
export function raiseSpreadInitAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { x: alias } = { ...{ x: e } };
    alias.code = 'FIXTURE_SPREAD_INIT_ALIAS';
    throw e;
  }
}

// (85) a default in the pattern may win over the initializer: unprovable.
export function raiseDefaultInitAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { x: alias = null } = { x: e };
    alias.code = 'FIXTURE_DEFAULT_INIT_ALIAS';
    throw e;
  }
}

// (86) elision in an array initializer: holes extract as undefined, so only
// their own position skips — the alias at index 0 links and the mutation
// propagates to the rethrow.
export function raiseElisionInitAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const [alias] = [e, ,];
    alias.code = 'FIXTURE_ELISION_INIT_ALIAS';
    throw e;
  }
}

// (87) a non-literal computed key on either side: unprovable — refused.
const computedKey = 'x';

export function raiseComputedKeyAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { [computedKey]: alias } = { [computedKey]: e };
    alias.code = 'FIXTURE_COMPUTED_KEY_ALIAS';
    throw e;
  }
}

// (88) a rest element collects the remaining properties into a NEW object
// whose values are the same references: unprovable — refused.
export function raiseRestAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { ...rest } = { x: e };
    rest.x.code = 'FIXTURE_REST_ALIAS';
    throw e;
  }
}

// (89) a container literal holding the caught error: a member write on the
// container reaches the held value, so the rethrow is refused.
export function raiseContainerMutation() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    holder.x.code = 'FIXTURE_CONTAINER_MUTATION';
    throw e;
  }
}

// --- round-9 shapes: loop declarations and nested extraction -----------------

// (90) a loop VARIABLE whose name matches the catch parameter: each iteration
// writes the CATCH binding at runtime (verified against the engine), so the
// rethrow carries the last element.
export function raiseLoopVarShadow() {
  try {
    JSON.parse('{');
  } catch (e) {
    for (var e of [{ code: 'FIXTURE_LOOP_VAR' }]) { /* the iteration is the write */ }
    throw e;
  }
}

// (91) the same through a destructured loop variable.
export function raiseLoopVarPatternShadow() {
  try {
    JSON.parse('{');
  } catch (e) {
    for (var { x: e } of [{ x: { code: 'FIXTURE_LOOP_PATTERN_VAR' } }]) { /* same */ }
    throw e;
  }
}

// (92) a container extracted through a declaration pattern keeps its nested
// identity: `holder.y` IS the caught error, so the member write propagates.
export function raiseNestedContainerAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const { x: holder } = { x: { y: e } };
    holder.y.code = 'FIXTURE_NESTED_CONTAINER';
    throw e;
  }
}

// --- round-10 shapes: destructured catch-shadowed var inits -------------------

// (93) a destructured var initializer whose target matches the catch
// parameter writes the CATCH binding at runtime (verified against the
// engine), object pattern…
export function raiseCatchVarDestructured() {
  try {
    JSON.parse('{');
  } catch (e) {
    var { x: e } = { x: { code: 'FIXTURE_CATCH_VAR_DESTRUCT' } };
    throw e;
  }
}

// (94) …and array pattern.
export function raiseCatchVarArrayDestructured() {
  try {
    JSON.parse('{');
  } catch (e) {
    var [e] = [{ code: 'FIXTURE_CATCH_VAR_ARRAY' }];
    throw e;
  }
}

// --- round-11 shapes: spread-shifted substitution and loop-target aliases ----

// (95) a returned-parameter proof must not index past a spread: the literal
// AT the AST index is not the argument that lands there (verified against the
// engine).
function identityReturn2(label, value) {
  return value;
}

export function raiseSpreadReturn() {
  throw identityReturn2(...['x', { code: 'FIXTURE_SPREAD_RETURN' }], null);
}

// (96) a for-of declaration target IS each iterated value in turn: the alias
// link must follow a literal iterable's elements.
export function raiseLoopAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    for (const alias of [e]) {
      alias.code = 'FIXTURE_LOOP_ALIAS';
    }
    throw e;
  }
}

// (97) the same with an EXISTING identifier as the loop target.
export function raiseLoopExistingAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    let alias;
    for (alias of [e]) {
      alias.code = 'FIXTURE_LOOP_EXISTING_ALIAS';
    }
    throw e;
  }
}

// --- round-12 shapes: iterable provenance and container extraction -----------

// (98) a spread iterable over a literal expands provably — the alias link
// follows the expanded elements, and the mutation reaches the rethrow.
export function raiseSpreadIterable() {
  try {
    JSON.parse('{');
  } catch (e) {
    for (const alias of [...[e]]) {
      alias.code = 'FIXTURE_SPREAD_ITERABLE';
    }
    throw e;
  }
}

// (99) an identifier-held literal iterable resolves through its binding.
export function raiseIdentifierIterable() {
  try {
    JSON.parse('{');
  } catch (e) {
    const items = [e];
    for (const alias of items) {
      alias.code = 'FIXTURE_IDENT_ITERABLE';
    }
    throw e;
  }
}

// (100) destructuring from a local container IDENTIFIER resolves through the
// container's literal initializer.
export function raiseContainerExtraction() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    const { x: alias } = holder;
    alias.code = 'FIXTURE_CONTAINER_EXTRACT';
    throw e;
  }
}

// (101) an iterable this reader cannot resolve, whose target IS mutated:
// the alias may reach a proved value, so the loop is refused.
export function raiseUnprovableIterable(items) {
  let alias;
  for (alias of items) {
    alias.code = 'FIXTURE_UNPROVABLE_ITERABLE';
  }
  try {
    JSON.parse('{');
  } catch (e) {
    throw e;
  }
}

// (102) control: an unresolved iterable whose target is never mutated is
// harmless — no refusal, no code.
export function readUnprovableIterable(items) {
  let total = 0;
  for (const item of items) {
    total += 1;
  }
  return total;
}

// --- round-13 shapes: source scopes and extraction fall-throughs -------------

// (103) an iterable's elements resolve in THEIR OWN scope, not the loop's:
// the inner `e` shadow must not hijack the alias link.
export function raiseShadowedIterableScope() {
  try {
    JSON.parse('{');
  } catch (e) {
    const items = [e];
    {
      const e = null;
      void e;
      for (const alias of items) {
        alias.code = 'FIXTURE_SHADOWED_ITERABLE';
      }
    }
    throw e;
  }
}

// (104) a spread in a destructuring SOURCE array expands provably — the alias
// link follows the expanded elements.
export function raiseSpreadSourceExtraction() {
  try {
    JSON.parse('{');
  } catch (e) {
    const [alias] = [...[e]];
    alias.code = 'FIXTURE_SPREAD_SOURCE';
    throw e;
  }
}

// (105) destructuring through a MEMBER of a literal container resolves the
// property path into the container's initializer.
export function raiseMemberSourceExtraction() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { inner: { x: e } };
    const { x: alias } = holder.inner;
    alias.code = 'FIXTURE_MEMBER_SOURCE';
    throw e;
  }
}

// (106) destructuring from an UNPROVABLE member source, with a mutation of
// the extracted binding: refused at the declaration.
export function raiseUnprovableSource(unknown) {
  const { x: alias } = unknown.inner;
  alias.code = 'FIXTURE_UNPROVABLE_SOURCE';
  try {
    JSON.parse('{');
  } catch (e) {
    throw e;
  }
}

// --- round-14 shapes: member-valued sources and element source scopes --------

// (107) a destructured iterable element resolves in its OWN scope: an inner
// shadow of the container name must not substitute (verified against the
// engine).
export function raiseShadowedDestructuredElement() {
  try {
    JSON.parse('{');
  } catch (e) {
    const item = { x: e };
    const items = [item];
    {
      const item = { x: null };
      void item;
      for (const { x: alias } of items) {
        alias.code = 'FIXTURE_SHADOWED_ELEMENT';
      }
    }
    throw e;
  }
}

// (108) a member-valued property in a destructuring source resolves through
// the container path…
export function raiseMemberValuedSource() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    const { x: alias } = { x: holder.x };
    alias.code = 'FIXTURE_MEMBER_VALUED';
    throw e;
  }
}

// (109) …and in an array source.
export function raiseMemberValuedArraySource() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    const [alias] = [holder.x];
    alias.code = 'FIXTURE_MEMBER_VALUED_ARRAY';
    throw e;
  }
}

// --- round-15 shapes: nested member containers and value-expression aliases --

// (110) a container whose literal holds a MEMBER value: the member path
// resolves into the container, so the outer container links too (verified
// against the engine).
export function raiseNestedMemberContainer() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    const box = { y: holder.x };
    box.y.code = 'FIXTURE_NESTED_MEMBER';
    throw e;
  }
}

// (111) the destructured variant.
export function raiseNestedMemberDestructured() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    const { box } = { box: { y: holder.x } };
    box.y.code = 'FIXTURE_NESTED_DESTRUCT_MEMBER';
    throw e;
  }
}

// (112) a conditional value expression links the union of its provable
// branches.
export function raiseConditionalAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const alias = e ? e : null;
    alias.code = 'FIXTURE_CONDITIONAL_ALIAS';
    throw e;
  }
}

// (113) a logical value expression, same rule.
export function raiseLogicalAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const alias = null ?? e;
    alias.code = 'FIXTURE_LOGICAL_ALIAS';
    throw e;
  }
}

// (114) awaiting a non-thenable is identity.
export async function raiseAwaitedAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const alias = await e;
    alias.code = 'FIXTURE_AWAIT_ALIAS';
    throw e;
  }
}

// (115) a sequence value is its last element.
export function raiseSequenceAlias() {
  try {
    JSON.parse('{');
  } catch (e) {
    const alias = (0, e);
    alias.code = 'FIXTURE_SEQUENCE_ALIAS';
    throw e;
  }
}

// --- round-16 shapes: expression-rooted writes and stores --------------------

// (116)-(120) a member write whose root is an EXPRESSION mutates whatever the
// root refers to (each verified against the engine).
export function raiseRootArrayWrite() {
  try {
    JSON.parse('{');
  } catch (e) {
    [e][0].code = 'FIXTURE_ROOT_ARRAY';
    throw e;
  }
}

export function raiseRootObjectWrite() {
  try {
    JSON.parse('{');
  } catch (e) {
    ({ x: e }).x.code = 'FIXTURE_ROOT_OBJECT';
    throw e;
  }
}

export function raiseRootSequenceWrite() {
  try {
    JSON.parse('{');
  } catch (e) {
    (0, e).code = 'FIXTURE_ROOT_SEQUENCE';
    throw e;
  }
}

export function raiseRootConditionalWrite() {
  try {
    JSON.parse('{');
  } catch (e) {
    (e ? e : null).code = 'FIXTURE_ROOT_CONDITIONAL';
    throw e;
  }
}

export function raiseRootAssignmentWrite() {
  try {
    JSON.parse('{');
  } catch (e) {
    let a;
    (a = e).code = 'FIXTURE_ROOT_ASSIGN';
    throw e;
  }
}

// (121) a bare ASSIGNMENT of a value expression links like a declaration.
export function raiseAssignConditional() {
  try {
    JSON.parse('{');
  } catch (e) {
    let alias;
    alias = e ? e : null;
    alias.code = 'FIXTURE_ASSIGN_COND';
    throw e;
  }
}

// (122) a member READ rooted at a literal resolves into the literal.
export function raiseLiteralRootRead() {
  try {
    JSON.parse('{');
  } catch (e) {
    const alias = [e][0];
    alias.code = 'FIXTURE_LITERAL_ROOT';
    throw e;
  }
}

// (123) storing a binding INTO a container links the container to it: a later
// member write on the container reaches the stored value.
export function raiseContainerStore() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = {};
    holder.x = e;
    holder.x.code = 'FIXTURE_CONTAINER_STORE';
    throw e;
  }
}

// (124) a container holding `this` in a constructor: a DEEP write through it
// reaches the instance.
export class ThisContainerFault extends Error {
  constructor() {
    super('this container');
    this.code = 'FIXTURE_THIS_CONTAINER_SAFE';
    const box = { t: this };
    box.t.code = 'FIXTURE_THIS_CONTAINER';
  }
}

export function raiseThisContainer() {
  throw new ThisContainerFault();
}

// --- round-17 shapes: store-direction roots and Object.* targets -------------

// (125) a store through an expression-rooted member links the container:
// `[holder][0].x = e` makes holder hold e.
export function raiseExpressionRootStore() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = {};
    [holder][0].x = e;
    holder.x.code = 'FIXTURE_EXPR_ROOT_STORE';
    throw e;
  }
}

// (126) Object.assign onto a member target mutates the value it refers to.
export function raiseObjectAssignMemberTarget() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = { x: e };
    Object.assign(holder.x, { code: 'FIXTURE_OBJECT_ASSIGN_MEMBER' });
    throw e;
  }
}

// (127) Object.defineProperty onto a literal-rooted member target.
export function raiseDefinePropertyLiteralRoot() {
  try {
    JSON.parse('{');
  } catch (e) {
    Object.defineProperty([e][0], 'code', { value: 'FIXTURE_DEFINE_LITERAL_ROOT' });
    throw e;
  }
}

// (128) Object.assign through a member holding `this` in a constructor:
// an opaque this-write, so the class is unprovable.
export class ThisObjectAssignFault extends Error {
  constructor() {
    super('this object assign');
    this.code = 'FIXTURE_THIS_OBJECT_ASSIGN_SAFE';
    const box = { t: this };
    Object.assign(box.t, { code: 'FIXTURE_THIS_OBJECT_ASSIGN' });
  }
}

export function raiseThisObjectAssign() {
  throw new ThisObjectAssignFault();
}

// --- round-18 shapes: non-assignment this-writes, mutator family, tags -------

// (129) a non-assignment write to this.code: delete removes the slot the
// direct write just proved — unprovable, refused (and must not crash).
export class ThisDeleteFault extends Error {
  constructor() {
    super('this delete');
    this.code = 'FIXTURE_THIS_DELETE_SAFE';
    delete this.code;
  }
}

export function raiseThisDelete() {
  throw new ThisDeleteFault();
}

// (130)-(132) Object.* targets that are expressions: conditional, sequence,
// spread.
export function raiseObjectConditionalTarget() {
  try {
    JSON.parse('{');
  } catch (e) {
    Object.assign(e ?? {}, { code: 'FIXTURE_OBJECT_COND_TARGET' });
    throw e;
  }
}

export function raiseObjectSequenceTarget() {
  try {
    JSON.parse('{');
  } catch (e) {
    Object.assign((0, e), { code: 'FIXTURE_OBJECT_SEQ_TARGET' });
    throw e;
  }
}

export function raiseObjectSpreadTarget() {
  try {
    JSON.parse('{');
  } catch (e) {
    Object.assign(...[e], { code: 'FIXTURE_OBJECT_SPREAD_TARGET' });
    throw e;
  }
}

// (133) the renderer invoked as a template TAG: no provable code position.
export function refuseTaggedSink(stderr) {
  stderr.write(reviewLine`noise ${'FIXTURE_TAGGED_SINK'} ${'x'}`);
}

// (134) Object.setPrototypeOf installs an inherited code on a codeless value.
export function raiseSetPrototypeOf() {
  try {
    JSON.parse('{');
  } catch (e) {
    delete e.code;
    Object.setPrototypeOf(e, { code: 'FIXTURE_SETPROTO' });
    throw e;
  }
}

// (135) Reflect.set writes the target's property.
export function raiseReflectSet() {
  try {
    JSON.parse('{');
  } catch (e) {
    Reflect.set(e, 'code', 'FIXTURE_REFLECT_SET');
    throw e;
  }
}

// (136) the STORE direction through Object.*: assign copies the source's
// values INTO the target — containment.
export function raiseAssignStore() {
  try {
    JSON.parse('{');
  } catch (e) {
    const holder = {};
    Object.assign(holder, { x: e });
    holder.x.code = 'FIXTURE_ASSIGN_STORE';
    throw e;
  }
}

// (137) a super.<key> write lands on the instance: opaque this-write, and the
// direct write above it must NOT be read as the class's code.
export class SuperWriteFault extends Error {
  constructor() {
    super('super write');
    this.code = 'FIXTURE_SUPER_WRITE_SAFE';
    super.code = 'FIXTURE_SUPER_WRITE';
  }
}

export function raiseSuperWrite() {
  throw new SuperWriteFault();
}

// (138) a mutator invoked through .apply: arguments unindexable — refused.
export function raiseMutatorApply() {
  try {
    JSON.parse('{');
  } catch (e) {
    Object.assign.apply(null, [e, { code: 'FIXTURE_MUTATOR_APPLY' }]);
    throw e;
  }
}

// (139) control: a binding initialized to a codeless literal and assigned the
// caught error — every value it may hold is codeless or proved. Accepted.
export function raiseLiteralInitAlias() {
  let failure = null;
  try {
    JSON.parse('{');
  } catch (e) {
    failure = e;
  }
  if (failure !== null) {
    throw failure;
  }
}

// --- round-19 shapes: static blocks, class-rooted mutators, pattern sinks ----

// (140) a static block runs at class definition and may install a prototype
// code every instance inherits (verified against the engine). Refused — and
// the reader must not crash on the member shape.
export class StaticBlockFault extends Error {
  static {
    this.prototype.code = 'FIXTURE_STATIC_BLOCK';
  }
}

export function raiseStaticBlock() {
  throw new StaticBlockFault();
}

// (141) a mutator target rooted at a CLASS binding: voids the declaration's
// proof, exactly like a direct `A.prototype.code = …` write.
export class MutatorClassFault extends Error {
  constructor() {
    super('mutator class');
    this.code = 'FIXTURE_MUTATOR_CLASS_SAFE';
  }
}

export function installMutatorClassCode() {
  Object.assign(MutatorClassFault.prototype, { code: 'FIXTURE_MUTATOR_CLASS' });
}

export function raiseMutatorClass() {
  throw new MutatorClassFault();
}

// (142) the same install inside a function body (late install).
export class LateInstallFault extends Error {
  constructor() {
    super('late install');
    this.code = 'FIXTURE_LATE_INSTALL_SAFE';
  }
}

export function installLateCode() {
  Object.defineProperty(LateInstallFault.prototype, 'code', { value: 'FIXTURE_LATE_INSTALL' });
}

export function raiseLateInstall() {
  throw new LateInstallFault();
}

// (143)-(145) the renderer bound through a destructuring pattern, then
// CALLED: namespace extraction and same-name extraction are read; the array
// extraction puts the renderer in an array literal — an escape, refused.
const { codedLine: patternSink } = cliError;
const { codedLine } = cliError;
const [arraySink] = [reviewLine];

export function refuseThroughPatternSink(stderr) {
  stderr.write(patternSink('noise visual-diff review', 'FIXTURE_PATTERN_SINK', 'x'));
}

export function refuseThroughSameNameExtraction(stderr) {
  stderr.write(codedLine('noise visual-diff review', 'FIXTURE_SAME_NAME_SINK', 'x'));
}

export function refuseThroughArrayExtraction(stderr) {
  stderr.write(arraySink('noise visual-diff review', 'FIXTURE_ARRAY_SINK', 'x'));
}

// (146) the renderer through Reflect.apply: the renderer is a call ARGUMENT
// — an escape, refused.
export function refuseThroughReflectApply(stderr) {
  stderr.write(Reflect.apply(reviewLine, null, ['noise visual-diff review', 'FIXTURE_REFLECT_APPLY', 'x']));
}

// --- round-20 shapes: class-group voiding, namespaces, proxy, eval -----------

// (147) a class ALIAS's prototype is the class's prototype: the write voids
// the declaration's proof (verified against the engine).
export class AliasTargetFault extends Error {
  constructor() {
    super('alias target');
    this.code = 'FIXTURE_ALIAS_TARGET_SAFE';
  }
}

const KAlias = AliasTargetFault;

export function installThroughAlias() {
  KAlias.prototype.code = 'FIXTURE_ALIAS_TARGET';
}

export function raiseAliasTarget() {
  throw new AliasTargetFault();
}

// (148) the prototype itself held in a variable: same group.
export class ProtoHeldFault extends Error {
  constructor() {
    super('proto held');
    this.code = 'FIXTURE_PROTO_HELD_SAFE';
  }
}

const heldProto = ProtoHeldFault.prototype;

export function installThroughHeldProto() {
  heldProto.code = 'FIXTURE_PROTO_HELD';
}

export function raiseProtoHeld() {
  throw new ProtoHeldFault();
}

// (149) `this` in a static member IS the class: a prototype write there hits
// every instance.
export class StaticInstallFault extends Error {
  constructor() {
    super('static install');
    this.code = 'FIXTURE_STATIC_INSTALL_SAFE';
  }

  static install() {
    this.prototype.code = 'FIXTURE_STATIC_INSTALL';
  }
}

export function raiseStaticInstall() {
  throw new StaticInstallFault();
}

// (150) a mutator target rooted at a class ALIAS (identity group).
export class AliasMutatorFault extends Error {
  constructor() {
    super('alias mutator');
    this.code = 'FIXTURE_ALIAS_MUTATOR_SAFE';
  }
}

export function installThroughAliasMutator() {
  const k = AliasMutatorFault;
  Object.assign(k.prototype, { code: 'FIXTURE_ALIAS_MUTATOR' });
}

export function raiseAliasMutator() {
  throw new AliasMutatorFault();
}

// (151) a member write rooted at a BUILTIN name mutates the language's own
// prototype: every later `new Error(…)` inherits it. Refused.
export function raiseBuiltinProtoWrite() {
  Error.prototype.code = 'FIXTURE_BUILTIN_PROTO';
  throw new Error('builtin proto write');
}

// (152) the renderer through a re-exported NAMESPACE (`export * as nsx`):
// resolved — read.
export function refuseThroughNsStar(stderr) {
  stderr.write(nsx.codedLine('noise visual-diff review', 'FIXTURE_NSSTAR_SINK', 'x'));
}

// (153) the renderer through a namespace import re-exported by a local list.
export function refuseThroughNsList(stderr) {
  stderr.write(nsl.codedLine('noise visual-diff review', 'FIXTURE_NSLIST_SINK', 'x'));
}

// (154) Proxy is not provably codeless: a trap can invent a code.
export function raiseProxy() {
  throw new Proxy({}, { get: () => 'FIXTURE_PROXY_TRAP' });
}

// (155) `new Object(x)` returns x: not provably codeless either.
export function raiseNewObject() {
  throw new Object({ code: 'FIXTURE_NEW_OBJECT' });
}

// (156) indirect eval is still eval.
export function raiseIndirectEval() {
  (0, eval)('throw { code: \'FIXTURE_INDIRECT_EVAL\' }');
}

// (157) calling the Function global compiles invisible code.
export function raiseFunctionCall() {
  Function('throw 1')();
}

// --- round-21 shapes: the renderer reached through a value -------------------
//
// Since round 26 every shape in rounds 21 to 25 is REFUSED where the renderer
// escapes into the value — the literal, the store, the field, the return —
// and the call through the value is then provably not the renderer and is
// left alone. The calls' codes are never read; the partition asserts that.

// (158)-(162) the renderer reached through a VALUE: container member, array
// element, stored member, conditional callee, sequence callee, class field.
const sinkHolder = { line: reviewLine };

export function refuseThroughContainerMember(stderr) {
  stderr.write(sinkHolder.line('noise visual-diff review', 'FIXTURE_CONTAINER_SINK', 'x'));
}

export function refuseThroughArrayElementCallee(stderr) {
  stderr.write([reviewLine][0]('noise visual-diff review', 'FIXTURE_ARRAY_ELEMENT_SINK', 'x'));
}

export function refuseThroughStoredMemberCallee(stderr) {
  const box = {};
  box.f = reviewLine;
  stderr.write(box.f('noise visual-diff review', 'FIXTURE_STORED_SINK', 'x'));
}

export function refuseThroughConditionalCallee(stderr) {
  stderr.write((reviewLine ? reviewLine : null)('noise visual-diff review', 'FIXTURE_COND_CALLEE', 'x'));
}

export function refuseThroughSequenceCallee(stderr) {
  stderr.write((0, reviewLine)('noise visual-diff review', 'FIXTURE_SEQ_CALLEE', 'x'));
}

export class SinkFieldHolder {
  line = reviewLine;

  getSink() {
    return reviewLine;
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_FIELD_SINK', 'x'));
  }
}

// (163) a conditional callee MIXING the sink with another value: refused.
export function refuseMixedCallee(stderr, other) {
  stderr.write((other ? reviewLine : other)('noise visual-diff review', 'FIXTURE_MIXED_CALLEE', 'x'));
}

// (164)-(165) globalThis.eval is eval through a member.
export function raiseGlobalThisEval() {
  globalThis.eval('throw 1');
}

export function raiseGlobalThisEvalComputed() {
  globalThis['eval']('throw 1');
}

// (166) `new Function(…)` builds invisible code just like `Function(…)`:
// refused; the sandbox snippets in src/capture.mjs are reviewed sites.
export function raiseNewFunction() {
  throw new Function('return 1')();
}

// --- round-22 shapes: dynamic import, ctor/inherited members, call results ---

// (167) the renderer through an awaited dynamic import's namespace: read.
export async function refuseThroughDynamicImportSink(stderr) {
  const m = await import('../../../src/cli-error.mjs');
  stderr.write(m.codedLine('noise visual-diff review', 'FIXTURE_DYNAMIC_IMPORT_SINK', 'x'));
}

// (168) a member callee assigned in the CONSTRUCTOR with no field declaration.
export class CtorAssignedSink {
  constructor() {
    this.line = reviewLine;
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_CTOR_MEMBER_SINK', 'x'));
  }
}

// (169) a field declaration overridden by the constructor: the ctor wins.
export class OverriddenFieldSink {
  line = null;

  constructor() {
    this.line = reviewLine;
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_OVERRIDDEN_FIELD_SINK', 'x'));
  }
}

// (170) a field inherited from the superclass.
export class BaseSinkHolder {
  line = reviewLine;
}

export class ChildSinkHolder extends BaseSinkHolder {
  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_INHERITED_FIELD_SINK', 'x'));
  }
}

// (171) a callee that is a CALL RESULT whose returns are provably the sink.
function pickSink() {
  return reviewLine;
}

export function refuseThroughCallResult(stderr) {
  stderr.write(pickSink()('noise visual-diff review', 'FIXTURE_CALL_RESULT_SINK', 'x'));
}

// (172) a getter on a literal container returning the sink.
const getterHolder = {
  get line() {
    return reviewLine;
  },
};

export function refuseThroughGetter(stderr) {
  stderr.write(getterHolder.line('noise visual-diff review', 'FIXTURE_GETTER_SINK', 'x'));
}

// (173) store-then-extract: the stored member is known through the container.
export function refuseThroughStoreExtract(stderr) {
  const box = {};
  box.f = reviewLine;
  const { f: extractedSink } = box;
  stderr.write(extractedSink('noise visual-diff review', 'FIXTURE_STORE_EXTRACT_SINK', 'x'));
}

// (174) global.eval is eval too.
export function raiseGlobalEval() {
  global.eval('throw 1');
}

// (175) a call-result callee whose returns are a PARAMETER: nothing here
// escapes the renderer, so nothing is refused and nothing is read — a caller
// handing the renderer in would be refused at the argument. Control.
function pickMaybe(x) {
  return x;
}

export function refuseUnprovableCallResult(stderr, other) {
  stderr.write(pickMaybe(other)('noise visual-diff review', 'FIXTURE_UNPROVABLE_CALL_RESULT', 'x'));
}

// --- round-23 shapes: method results, method writes, class-expression bases --

// (176) a method-call RESULT as the callee — the shape that crashed the
// reader (`a.b()(…)`): the method's returns decide.
const methodHolder = {
  getSink() {
    return reviewLine;
  },
};

export function refuseThroughMethodResult(stderr) {
  stderr.write(methodHolder.getSink()('noise visual-diff review', 'FIXTURE_METHOD_RESULT_SINK', 'x'));
}

// (177) a method (not the constructor) writing the callee's slot: unordered —
// refused, not "provably inert".
export class MethodWrittenSink {
  line = null;

  arm() {
    this.line = reviewLine;
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_METHOD_WRITTEN', 'x'));
  }
}

// (178) the same through an arrow inside the constructor: w.fn is the arrow,
// not the ctor — the write is unordered, so refused.
export class ArrowCtorSink {
  constructor() {
    const arm = () => {
      this.line = reviewLine;
    };
    arm();
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_ARROW_CTOR', 'x'));
  }
}

// (179) a superclass bound through a const CLASS EXPRESSION: resolved and read.
const ExprBaseSink = class {
  line = reviewLine;
};

export class ExprChildSink extends ExprBaseSink {
  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_EXPR_BASE_SINK', 'x'));
  }
}

// (180) a member call nothing in the chain declares: no escape, so silent —
// the class holds no renderer and the call cannot be one. Control.
export class UndeclaredMemberCall {
  callIt(stderr) {
    stderr.write(this.anything('noise visual-diff review', 'FIXTURE_UNDECLARED_MEMBER', 'x'));
  }
}

// (181) a class GETTER returning the sink, called as this.line(…): read.
export class GetterSinkHolder {
  get line() {
    return reviewLine;
  }

  callIt(stderr) {
    stderr.write(this.line('noise visual-diff review', 'FIXTURE_CLASS_GETTER_SINK', 'x'));
  }
}

// (182) an instance member call from OUTSIDE the class.
export function refuseThroughInstanceMember(stderr) {
  const h = new SinkFieldHolder();
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_INSTANCE_MEMBER_SINK', 'x'));
}

// (183) a static field callee.
export class StaticSinkHolder {
  static line = reviewLine;
}

export function refuseThroughStaticField(stderr) {
  stderr.write(StaticSinkHolder.line('noise visual-diff review', 'FIXTURE_STATIC_FIELD_SINK', 'x'));
}

// (184) a binding destructured from `this`, then called.
export class DestructThisSink {
  line = reviewLine;

  callIt(stderr) {
    const { line } = this;
    stderr.write(line('noise visual-diff review', 'FIXTURE_DESTRUCT_THIS_SINK', 'x'));
  }
}

// --- round-24 shapes: instance roots, partial paths, freeze -------------------

// (186) a member call on a FRESH instance: the class decides — read.
export function refuseThroughFreshInstance(stderr) {
  stderr.write(new SinkFieldHolder().line('noise visual-diff review', 'FIXTURE_FRESH_INSTANCE_SINK', 'x'));
}

// (187) a call-result root (`const h = mk()`) crosses the call boundary:
// 'boundary', silently skipped per the ceiling — never "provably not the
// sink". This fixture asserts only that it produces NEITHER code nor refusal.
function mkHolder() {
  return new SinkFieldHolder();
}

export function readThroughCallResultRoot(stderr) {
  const h = mkHolder();
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_CALL_ROOT_NEVER_READ', 'x'));
}

// (188) an instance held in an array literal: the partial path resolves.
export function refuseThroughArrayHeldInstance(stderr) {
  const hs = [new SinkFieldHolder()];
  stderr.write(hs[0].line('noise visual-diff review', 'FIXTURE_ARRAY_HELD_INSTANCE', 'x'));
}

// (189) a frozen literal container: Object.freeze returns its argument.
export function refuseThroughFrozenContainer(stderr) {
  const c = Object.freeze({ line: reviewLine });
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_FROZEN_SINK', 'x'));
}

// (190) the same read with a computed string key.
export function refuseThroughComputedKeyRead(stderr) {
  const c = Object.freeze({ line: reviewLine });
  stderr.write(c['line']('noise visual-diff review', 'FIXTURE_COMPUTED_KEY_READ', 'x'));
}

// (191) an instance held in a NESTED literal: the partial path resolves.
export function refuseThroughNestedInstance(stderr) {
  const box = { h: new SinkFieldHolder() };
  stderr.write(box.h.line('noise visual-diff review', 'FIXTURE_NESTED_INSTANCE', 'x'));
}

// (192) a method-call result on a known instance.
export function refuseThroughInstanceMethodResult(stderr) {
  const h = new SinkFieldHolder();
  stderr.write(h.getSink()('noise visual-diff review', 'FIXTURE_INSTANCE_METHOD_SINK', 'x'));
}

// (193) the assignment form of this-destructuring (`let line; ({ line } =
// this); line(…)`) — one hop, resolved like the declaration form.
export class AssignDestructThisSink {
  line = reviewLine;

  callIt(stderr) {
    let line;
    ({ line } = this);
    stderr.write(line('noise visual-diff review', 'FIXTURE_ASSIGN_DESTRUCT_THIS_SINK', 'x'));
  }
}

// --- round-25 shapes: stores beat fields, seal vs freeze, intermediate hops --

// A class with an inert field: every fixture below starts from it.
export class PlainHolder {
  line = null;
}

// (194) a store on a known instance wins over the field: read.
export function refuseThroughInstanceStore() {
  const h = new PlainHolder();
  h.line = reviewLine;
  let stderr = null;
  // a local writable stand-in keeps the fixture inert while the call is read
  const calls = [];
  stderr = { write: (x) => calls.push(x) };
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_INSTANCE_STORE_SINK', 'x'));
  return calls;
}

// (195) the same through an alias of the instance (identity group).
export function refuseThroughInstanceAliasStore() {
  const h = new PlainHolder();
  const g = h;
  g.line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_INSTANCE_ALIAS_STORE', 'x'));
  return calls;
}

// (196) a store through an array-held instance.
export function refuseThroughArrayStore() {
  const hs = [new PlainHolder()];
  hs[0].line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(hs[0].line('noise visual-diff review', 'FIXTURE_ARRAY_STORE_SINK', 'x'));
  return calls;
}

// (197) a store through a nested-literal instance.
export function refuseThroughNestedStore() {
  const box = { h: new PlainHolder() };
  box.h.line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(box.h.line('noise visual-diff review', 'FIXTURE_NESTED_STORE_SINK', 'x'));
  return calls;
}

// (198) a stored arrow replacing a method slot, then a call result: the
// arrow's returns decide.
export function refuseThroughStoredMethodResult() {
  const h = new SinkFieldHolder();
  h.getSink = () => reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(h.getSink()('noise visual-diff review', 'FIXTURE_STORED_METHOD_RESULT', 'x'));
  return calls;
}

// (199) mirror control: a store REPLACING a sink field with an inert value
// reads nothing and refuses nothing.
const inertLine = (p, c, m) => `${p}${c}${m}`;

export function readThroughOverwrittenSink() {
  const h = new SinkFieldHolder();
  h.line = inertLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_OVERWRITTEN_NEVER_READ', 'x'));
  return calls;
}

// (200) Object.seal keeps properties writable: the store wins — read.
export function refuseThroughSealedStore() {
  const c = Object.seal({ line: null });
  c.line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_SEALED_STORE_SINK', 'x'));
  return calls;
}

// (201) Object.freeze makes the store throw: the literal wins — read.
export function refuseThroughFrozenStore() {
  const c = Object.freeze({ line: reviewLine });
  try {
    c.line = inertLine;
  } catch {
    // strict mode: the store throws; the literal stands
  }
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_FROZEN_STORE_SINK', 'x'));
  return calls;
}

// (202) a store on an intermediate binding wins over its literal member.
export function refuseThroughIntermediateStore() {
  const inner = { line: null };
  const outer = { i: inner };
  inner.line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(outer.i.line('noise visual-diff review', 'FIXTURE_INTERMEDIATE_STORE_SINK', 'x'));
  return calls;
}

// --- round-26 shapes: the renderer never escapes --------------------------
//
// Rounds 21 to 25 taught the reader to FOLLOW the renderer into containers,
// stores, class fields, getters and return values, and each round's probes
// found the next shape it followed wrongly. The reader now proves the
// negative instead: the renderer, and any namespace carrying it, may stand
// only as a direct callee, a const alias, a namespace member, or an export.
// Every other reference is refused where the renderer ESCAPES into a value,
// and a callee that is not import-rooted is then provably not the renderer.
// The round-21 to round-25 shapes above are all refused at their escape now
// (the object literal, the `this.line = …`, the `box.f = …`), which is why
// their calls no longer read. The shapes below are the round-26 probes —
// every one fires the renderer at runtime — plus one fixture per escape
// position, and controls that must stay silent.

// (203) a store to an INTERMEDIATE key on the root, then a call through the
// stale literal: refused at the store.
export function refuseIntermediateKeyStore() {
  const outer = { i: { line: null } };
  outer.i = { line: reviewLine };
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(outer.i.line('noise visual-diff review', 'FIXTURE_R26_INTERMEDIATE_KEY', 'x'));
  return calls;
}

// (204) a store on an intermediate binding whose remaining path is dropped.
export function refuseDroppedRestPath() {
  const inner = { box: null };
  const outer = { i: inner };
  const holder2 = { line: reviewLine };
  inner.box = holder2;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(outer.i.box.line('noise visual-diff review', 'FIXTURE_R26_REST_PATH', 'x'));
  return calls;
}

// (205) a deep store through one name, read through the other.
export function refuseDeepStoreOtherName() {
  const inner = {};
  const outer = { i: inner };
  outer.i.f = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(inner.f('noise visual-diff review', 'FIXTURE_R26_DEEP_STORE', 'x'));
  return calls;
}

// (206) a frozen container read through an alias, with a store that throws.
export function refuseFrozenAliasRead() {
  const c = Object.freeze({ line: reviewLine });
  const d = c;
  try {
    d.line = inertLine;
  } catch {
    // strict mode: the store throws; the literal stands
  }
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(d.line('noise visual-diff review', 'FIXTURE_R26_FROZEN_ALIAS', 'x'));
  return calls;
}

// (207) freeze as a statement, not an initializer.
export function refuseFrozenStatement() {
  const c = { line: reviewLine };
  Object.freeze(c);
  try {
    c.line = inertLine;
  } catch {
    // the store throws
  }
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_R26_FROZEN_STATEMENT', 'x'));
  return calls;
}

// (208) a sealed container with a getter-only accessor: the store throws.
export function refuseSealedGetterOnly() {
  const c = Object.seal({ get line() { return reviewLine; } });
  try {
    c.line = inertLine;
  } catch {
    // no setter: the store throws
  }
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_R26_SEALED_GETTER', 'x'));
  return calls;
}

// (209) a call result stored into a slot, and held in a plain binding.
export function refuseStoredCallResult() {
  const h = new PlainHolder();
  h.line = pickSink();
  const f = pickSink();
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(h.line('noise visual-diff review', 'FIXTURE_R26_STORED_RESULT', 'x'));
  stderr.write(f('noise visual-diff review', 'FIXTURE_R26_HELD_RESULT', 'x'));
  return calls;
}

// (210) a member extracted into a binding AFTER a store, three ways.
export function refuseExtractAfterStore() {
  const h = new PlainHolder();
  h.line = reviewLine;
  const g = h.line;
  const { line } = h;
  const box = {};
  box.f = reviewLine;
  const g2 = box.f;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(g('noise visual-diff review', 'FIXTURE_R26_EXTRACT_MEMBER', 'x'));
  stderr.write(line('noise visual-diff review', 'FIXTURE_R26_EXTRACT_PATTERN', 'x'));
  stderr.write(g2('noise visual-diff review', 'FIXTURE_R26_EXTRACT_LITERAL', 'x'));
  return calls;
}

// (211) a __proto__ initializer on a container, then a store on the proto.
export function refuseProtoContainer() {
  const proto = { line: null };
  const c = { __proto__: proto };
  proto.line = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(c.line('noise visual-diff review', 'FIXTURE_R26_PROTO_CONTAINER', 'x'));
  return calls;
}

// (212) a store and a call through a PARAMETER root in one function.
export function refuseParamRootStore(h) {
  h.line = reviewLine;
  return h.line('noise visual-diff review', 'FIXTURE_R26_PARAM_ROOT', 'x');
}

// (213) the renderer as a call ARGUMENT: whatever the callee does with it is
// the interprocedural ceiling — so the handover itself is refused.
function emit(fn) {
  return fn('noise visual-diff review', 'FIXTURE_R26_ARGUMENT', 'x');
}

export function refuseAsArgument() {
  return emit(reviewLine);
}

// (214) the renderer RETURNED from a function (pickSink above is the same
// shape, refused at its return): a bare return in an arrow.
export const pickArrow = () => reviewLine;

// (215) a `let` alias and a `var` alias: only a const alias is followed.
export function refuseMutableAlias() {
  let l = reviewLine;
  var v = reviewLine;
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(l('noise visual-diff review', 'FIXTURE_R26_LET_ALIAS', 'x'));
  stderr.write(v('noise visual-diff review', 'FIXTURE_R26_VAR_ALIAS', 'x'));
  return calls;
}

// (216) the renderer in a comparison, under typeof, and as a bare statement.
export function refuseValueUses() {
  const isFn = typeof reviewLine === 'function';
  const same = reviewLine === inertLine;
  reviewLine;
  return isFn && same;
}

// (217) the renderer CONSTRUCTED: the body runs, the return is discarded.
export function refuseConstructed() {
  return new reviewLine('noise visual-diff review', 'FIXTURE_R26_CONSTRUCTED', 'x');
}

// (218) a member of the renderer other than .call/.apply/.bind.
export function refuseMemberRead() {
  return reviewLine.length;
}

// (219) the NAMESPACE escaping into a container, and a namespace member
// escaping into one.
const nsBox = { ns: cliError };
const memberBox = { line: cliError.codedLine };

export function refuseNamespaceContainer() {
  const calls = [];
  const stderr = { write: (x) => calls.push(x) };
  stderr.write(nsBox.ns.codedLine('noise visual-diff review', 'FIXTURE_R26_NS_CONTAINER', 'x'));
  stderr.write(memberBox.line('noise visual-diff review', 'FIXTURE_R26_NS_MEMBER_CONTAINER', 'x'));
  return calls;
}

// (220) a namespace member through .call: the code position shifts — read.
export function readNamespaceMemberCall(stderr) {
  stderr.write(cliError.codedLine.call(null, 'noise visual-diff review', 'FIXTURE_R26_NS_CALL', 'x'));
}

// (221) the awaited dynamic import called directly, and DESTRUCTURED: the
// first is a namespace member callee (read); the second is not an import
// binding, so the extraction is not recorded — refused.
export async function readAwaitedImportMember(stderr) {
  stderr.write((await import('../../../src/cli-error.mjs')).codedLine('noise visual-diff review', 'FIXTURE_R26_AWAIT_MEMBER', 'x'));
}

export async function refuseAwaitedImportPattern(stderr) {
  const { codedLine: fromAwait } = await import('../../../src/cli-error.mjs');
  stderr.write(fromAwait('noise visual-diff review', 'FIXTURE_R26_AWAIT_PATTERN', 'x'));
}

// (222) a dynamic import whose specifier is not a literal may load anything.
export async function refuseComputedImport(which) {
  const m = await import(which);
  return m.codedLine('noise visual-diff review', 'FIXTURE_R26_COMPUTED_IMPORT', 'x');
}

// (223) a namespace member with a computed name.
export function refuseComputedNamespaceMember(key) {
  return cliError[key]('noise visual-diff review', 'FIXTURE_R26_COMPUTED_NS', 'x');
}

// (224) an import from a repository module OUTSIDE the scanned tree: that
// module holds the renderer in a container, and nothing here checks it.
import { outsideHolder } from '../outside-relay.mjs';

export function refuseOutsideRelay(stderr) {
  stderr.write(outsideHolder.line('noise visual-diff review', 'FIXTURE_R26_OUTSIDE_RELAY', 'x'));
}

// (225) controls: a namespace member that is NOT the renderer, a const alias
// of the namespace, and a `.call` on a const alias — silent, read, read.
const nsAgain = cliError;

export function readControls(stderr) {
  cliError.errorCode(new Error('not the renderer'));
  stderr.write(nsAgain.codedLine('noise visual-diff review', 'FIXTURE_R26_NS_AGAIN', 'x'));
  const alias = reviewLine;
  stderr.write(alias.call(null, 'noise visual-diff review', 'FIXTURE_R26_ALIAS_CALL', 'x'));
}

// (226) the renderer exported under another name: sanctioned, and read by the
// importer's binding (see aliased.mjs for the same shape one hop earlier).
export { reviewLine as reExportedLine };
export default reviewLine;

// --- round-27 shapes: the scope model under shadowing -------------------------
//
// A reference is the renderer when the IMPORT is the binding in scope at
// runtime. Three declaration forms used to land in the wrong scope in the
// reader — a named class expression's id in the enclosing scope, a `switch`
// case's `let`/`class` in the function scope, a loop head's declaration
// outside the loop — so a same-named local hid the import and the real
// renderer call was skipped as "not import-rooted". Each shape below calls
// the renderer at runtime and must be READ.

// (227) a named class EXPRESSION binds its name only inside its body.
export function readPastClassExpressionName(stderr) {
  const H = class reviewLine {};
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_CLASS_EXPR_NAME', 'x'));
  return H;
}

// (228)-(229) a `let` and a `class` in a switch case are scoped to the switch.
export function readPastSwitchLet(stderr, x) {
  switch (x) {
    case 1: {
      break;
    }
    default:
      // eslint-disable-next-line no-case-declarations
      let reviewLine = null;
      void reviewLine;
      break;
  }
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_SWITCH_LET', 'x'));
}

export function readPastSwitchClass(stderr, x) {
  switch (x) {
    default:
      // eslint-disable-next-line no-case-declarations
      class reviewLine {}
      void reviewLine;
  }
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_SWITCH_CLASS', 'x'));
}

// (230)-(233) loop-head declarations are scoped to the loop: for-of, for,
// for-in, and a for-of shadowing the NAMESPACE.
export function readPastForOfLet(stderr) {
  for (let reviewLine of [1]) void reviewLine;
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_FOR_OF_LET', 'x'));
}

export function readPastForLet(stderr) {
  for (let reviewLine = 0; reviewLine < 1; reviewLine++) void reviewLine;
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_FOR_LET', 'x'));
}

export function readPastForInLet(stderr) {
  for (let reviewLine in { a: 1 }) void reviewLine;
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_FOR_IN_LET', 'x'));
}

export function readPastForOfNamespace(stderr) {
  for (const cliError of [1]) void cliError;
  stderr.write(cliError.codedLine('noise visual-diff review', 'FIXTURE_R27_FOR_OF_NAMESPACE', 'x'));
}

// (234)-(235) the same two scope gaps on the THROWN-ERROR side: the
// construction resolves to the module-level ReviewFault, and its code is read.
export function raisePastClassExpressionShadow() {
  const Other = class ReviewFault {};
  void Other;
  throw new ReviewFault('FIXTURE_R27_CLASS_EXPR_CTOR', 'x');
}

export function raisePastSwitchClassShadow(x = 1) {
  switch (x) {
    default:
      // eslint-disable-next-line no-case-declarations
      class ReviewFault {}
      void ReviewFault;
  }
  throw new ReviewFault('FIXTURE_R27_SWITCH_CTOR', 'x');
}

// (236) control: the shadow IS in scope inside its own body — a call there
// is the local, not the renderer, and is silent.
export function silentInsideShadow(stderr) {
  for (const reviewLine of [(p, c, m) => `${p}${c}${m}`]) {
    stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R27_SHADOW_NEVER_READ', 'x'));
  }
}

// --- round-28 shapes: a named function expression's own name ------------------

// (237) a named FUNCTION expression binds its name inside its body only: the
// self-reference is the function, not the renderer — silent, never read.
export const selfNamedRenderer = function reviewLine(n, stderr) {
  if (n > 0) return reviewLine(n - 1, stderr);
  stderr.write(String(n));
  return reviewLine.length;
};

// (238) the same on the thrown-error side: `new ReviewFault(…)` inside a
// function expression named ReviewFault constructs the FUNCTION, whose
// return is what the engine yields — not the module-level class. Refused.
export const selfNamedRaiser = function ReviewFault(n) {
  if (n > 0) throw new ReviewFault(n - 1, 'FIXTURE_R28_SELF_CTOR_NEVER_READ');
  return { code: 'FIXTURE_R28_SELF_RETURN_NEVER_READ' };
};

// (239) control: the same names as parameters shadow the expression's id.
export const paramShadowsName = function reviewLine(reviewLine, stderr) {
  stderr.write(reviewLine('noise visual-diff review', 'FIXTURE_R28_PARAM_NEVER_READ', 'x'));
};
