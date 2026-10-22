// A repository module OUTSIDE the fixture tree that holds the renderer in a
// container. The fixture tree imports it (shape 224): the import is refused,
// because this module's own references are never checked by that scan.
import { codedLine } from '../../src/cli-error.mjs';

export const outsideHolder = { line: codedLine };
