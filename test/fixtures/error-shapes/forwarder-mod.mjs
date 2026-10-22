// A second fixture module for round 5: the forwarder whose callers reach it
// under RENAMED imports — shapes.mjs imports `make` twice, once renamed, and
// both call sites must resolve to this function by identity, not spelling.
import { ReviewFault } from './shapes.mjs';

export function make(code) {
  return new ReviewFault(code, 'from another module');
}

// A forwarder whose code sits at position 1, for the spread-shift fixture.
export function make2(label, code) {
  return new ReviewFault(code, label);
}
