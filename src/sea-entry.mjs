// Packaging entry — the single CJS main esbuild flattens for the Node SEA
// (FR-1/NFR-3; the SEA strategy validated by spike). A thin dispatch shim
// over src/cli.mjs so the packaged binary behaves identically to
// `node src/cli.mjs` for every real launch path:
//
//   - standalone       exec <entry> <verb> ...         argv[1:] = verb...
//   - noise host       `noise visual-diff <verb> ...`  argv[1:] = verb...
//   - host-noun form   exec <entry> visual-diff <verb> argv[1:] = noun verb...
//
// The host drops the noun (verified against the real host: `noise tasks
// version` execs a sibling plugin with `version` only). The contract test's
// documented substitution keeps it (exec with `visual-diff ...`), so a
// leading `visual-diff` token is dropped before the verb parser runs — both
// forms then converge on the same argv as `node src/cli.mjs`.
import { run, EXIT } from './cli.mjs';
import { errorLine } from './cli-error.mjs';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'visual-diff') argv.shift();

  let code;
  try {
    code = await run(argv, process.env, process.cwd(), {
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } catch (err) {
    // Mirrors src/cli.mjs main(): an unexpected throw is the trust bucket.
    process.stderr.write(errorLine('noise visual-diff', err));
    code = EXIT.TRUST;
  }
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(errorLine('noise visual-diff', err));
  process.exit(EXIT.TRUST);
});
