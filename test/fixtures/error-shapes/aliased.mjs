// A second fixture module: the source of the re-exported and dynamically
// imported constructors used by shapes.mjs.

class InnerFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InnerFault';
    this.code = code;
    this.exitCode = 3;
  }
}

export { InnerFault as AliasedFault };

// A two-hop re-export chain of the renderer: cli-error -> here -> hop2 -> the
// caller's alias. Binding resolution must follow it all the way.
export { codedLine } from '../../../src/cli-error.mjs';
