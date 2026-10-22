// A renderer imported, then re-exported through a LOCAL export list — not an
// `export … from`, which is what an earlier reader keyed on.
import { codedLine } from '../../../src/cli-error.mjs';

export { codedLine as localRelay };
