// Export-hygiene gate: the public release snapshot is `git archive HEAD`
// (curated by .gitattributes export-ignore), so this test scans the ACTUAL
// archive payload — not the working tree — and fails when the payload
// references an export-ignored path or carries private process vocabulary
// (requirement-tracker citations, review-round pointers, private paths or
// identities). It exists because a working-tree grep once passed while the
// archive still shipped dangling references.
//
// The patterns are assembled from fragments so this file never matches
// itself; it is also excluded from the scan by name as a second guard.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const SELF = 'test/export.test.mjs';

// Paths that must not appear in the payload (they are export-ignored, so a
// reference to them in shipped text is a dangling pointer). Split so this
// file's own source does not contain the literal.
const EXCLUDED_PATH_REFS = [
  'AGENTS' + '.md',
  'PROPOSAL' + '.md',
  'TASKS_' + 'FEEDBACK.md',
  '.' + 'tasks/',
  'spikes' + '/',
  'docs/' + 'proposal-',
  'docs/' + 'spike-node-sea',
].map((p) => new RegExp(p.replace(/[.\\/]/g, '\\$&')));

// Private process vocabulary and identities. Assembled from fragments.
const PRIVATE_VOCAB = [
  new RegExp('P' + 'RD' + '\\b'),
  new RegExp('[Tt]' + 'ask' + '[ -]\\d+'),
  new RegExp('pre-' + 'task' + '-\\d+'),
  new RegExp('PR' + ' ?#\\d+'),
  new RegExp('review' + ' round' + '[ -]?\\d+', 'i'),
  new RegExp('round' + '[ -]\\d+ (gate|finding|regression)', 'i'),
  new RegExp('(de' + 'ck|item)' + ' handoff|handoff' + ' \\d'),
  new RegExp('NOISE' + 'DE' + 'CK'),
  new RegExp('\\bde' + 'ck\\b', 'i'),
  new RegExp('blue' + 'print', 'i'),
  new RegExp('/work' + 'space/'),
  new RegExp('noisefloor' + '-app'),
  new RegExp('brain' + 'company'),
  new RegExp('doug' + '@'),
  // The field-report register. Scoped hard, because this class is not
  // reliably detectable by vocabulary: what makes "the reporter's comp
  // shape" a leak is that the reader cannot see the reporter, and no
  // pattern knows who is visible. These match only ADJACENT constructions
  // that cannot mean anything else — a definite possessive, or a crediting
  // verb immediately after the bare noun. Any modifier between them ("the
  // error reporter's output", "the crash reporter found") names a
  // component and passes, as do plurals and ordinary prose about field or
  // stress testing. What this misses is a review responsibility, not a gap
  // the gate pretends to cover.
  new RegExp('\\bthe (?:report|test)' + 'er[\u2019\']s\\b', 'i'),
  new RegExp('\\bthe (?:report|test)' + 'er (?:said|found|reported|observed|noted|filed|flagged|hit)\\b', 'i'),
  new RegExp('\\bfield[ -]' + 'report\\b', 'i'),
];

/** Every banned pattern a line trips, so the rules are testable directly. */
function privateReferenceHits(line) {
  return [...EXCLUDED_PATH_REFS, ...PRIVATE_VOCAB].filter((re) => re.test(line));
}

const SCAN_EXT = new Set(['.mjs', '.md', '.yml', '.yaml', '.json']);
const SKIP_FILES = new Set([SELF, 'package-lock.json']);

function* walk(dir, root) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p, root);
    else yield relative(root, p);
  }
}

test('export: git archive payload has no dangling refs or private vocabulary', () => {
  const out = tmpDir('vd-export-scan');
  mkdirSync(out, { recursive: true });
  const tar = execFileSync('git', ['archive', 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', out], { input: tar });

  const findings = [];
  for (const rel of walk(out, out)) {
    if (SKIP_FILES.has(rel)) continue;
    const dot = rel.lastIndexOf('.');
    if (dot === -1 || !SCAN_EXT.has(rel.slice(dot))) continue;
    const lines = readFileSync(join(out, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of privateReferenceHits(line)) {
        findings.push(`${rel}:${i + 1}: ${re} :: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(findings, [], `private references in the export payload:\n${findings.join('\n')}`);
});

// These fixtures are only safe here because this file is in SKIP_FILES —
// the archive scan never reads it, so the leak examples below cannot trip
// the gate they define.
test('export: the rules catch report-context gestures without banning ordinary prose', () => {
  for (const leak of [
    "The reporter's comp shape: a real SPA export",
    'The reporter\u2019s comp shape is private',
    'the tester found a blocker in the ladder',
    'from the field report, two failures',
  ]) {
    assert.ok(privateReferenceHits(leak).length > 0, `must be caught: ${leak}`);
  }
  for (const legit of [
    'The stress test verifies memory behaviour under load',
    'a battlefield test of the discovery ladder',
    'the error reporter emits JSON on stderr',
    'Error reporters collect stack traces',
    'The error reporter found no matching source map',
    'The field test verifies radio behaviour outdoors',
    'The crash reporter\u2019s output is a JSON blob',
    'Issues are open for bug reports and feedback',
    'the report verb prints the published verdict',
    'a test error is reported with its exit code',
  ]) {
    assert.deepEqual(privateReferenceHits(legit), [], `must stay exportable: ${legit}`);
  }
});
