// Tests for src/run.mjs — atomic run staging and publication (FR-18 /
// FR-30).
//
// Real temp projects under TMPDIR only; no browser, no network, no fakes
// beyond tiny JSON/Png fixtures staged by hand. Run with node --test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { dirname, join } from 'node:path';

import { init, LayoutError, RUN_ID_RE } from '../src/artifact-layout.mjs';
import {
  RunError,
  initRunDir,
  isRunComplete,
  newRunId,
  pruneUnpublishedRuns,
  publishRun,
  readCurrentRun,
  runStatus,
} from '../src/run.mjs';

const RUN = '20260812-083000-aaa111';
const RUN2 = '20260812-093000-bbb222';

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

async function withProject(fn) {
  const dir = tmpDir('vd-run');
const layout = await init(dir);
return await fn(dir, layout);
}

// --- fixture helpers --------------------------------------------------------

async function stageCapture(dir, runId, states) {
  for (const s of states) {
    const base = join(dir, '.visual-diff', 'captures', runId);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, `${s}.png`), Buffer.from(`png-${s}`));
    await writeFile(join(base, `${s}.provenance.json`), JSON.stringify({ kind: 'capture', state: s }));
  }
}

async function stageDiff(dir, runId, states) {
  for (const s of states) {
    const base = join(dir, '.visual-diff', 'diffs', runId);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, `${s}.png`), Buffer.from(`diff-${s}`));
  }
}

async function stageReport(dir, runId, body) {
  const file = join(dir, '.visual-diff', 'diffs', runId, 'report.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body === undefined ? JSON.stringify({ states: ['home'] }) : body);
}

async function stageCompleteRun(dir, runId, { states = ['home'] } = {}) {
  await stageCapture(dir, runId, states);
  await stageDiff(dir, runId, states);
  await stageReport(dir, runId);
}

// ===========================================================================
// run-id generation
// ===========================================================================

describe('newRunId', () => {
  test('matches the layout RUN_ID_RE and encodes UTC wall time', () => {
    const id = newRunId(new Date('2026-08-12T08:30:00Z'));
    assert.match(id, RUN_ID_RE);
    assert.equal(id.slice(0, 15), '20260812-083000');
    // 64-character maximum enforced by RUN_ID_RE: timestamp + '-xxxxxx' fits.
    assert.ok(id.length <= 64);
  });
});

// ===========================================================================
// initRunDir — capture staging directory
// ===========================================================================

describe('initRunDir', () => {
  test('creates captures/<run-id>/ under the project', async () => {
    await withProject(async (dir, layout) => {
      await initRunDir(layout, RUN);
      await assert.doesNotReject(access(join(dir, '.visual-diff', 'captures', RUN)));
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false, 'a fresh staging dir is never complete');
    });
  });

  test('an invalid run-id is refused before anything touches disk', async () => {
    await withProject(async (dir, layout) => {
      await assert.rejects(() => initRunDir(layout, '../escape'), (err) => err instanceof LayoutError && err.exitCode === 2);
    });
  });
});

// ===========================================================================
// runStatus / isRunComplete (FR-18)
// ===========================================================================

describe('runStatus', () => {
  test('a complete run reports every artifact and no missing items', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN, { states: ['home', 'settings'] });
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, true);
      assert.deepEqual(st.missing, []);
      assert.deepEqual(st.captures, ['home', 'settings']);
      assert.deepEqual(st.diffs, ['home', 'settings']);
      assert.equal(st.report, true);
      assert.equal(await isRunComplete(layout, RUN), true);
    });
  });

  test('a capture-only state is complete (diffs may be a subset of captures)', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home', 'solo']);
      await stageDiff(dir, RUN, ['home']);
      await stageReport(dir, RUN);
      assert.equal((await runStatus(layout, RUN)).complete, true);
    });
  });

  test('missing report.json leaves the run incomplete and names the gap', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageDiff(dir, RUN, ['home']);
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('report.json')));
    });
  });

  test('missing diffs leaves the run incomplete', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageReport(dir, RUN);
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('diffs')));
    });
  });

  test('a capture whose provenance record is missing is incomplete', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      // drop the provenance record, keep the PNG — a strand of an interrupt
      await rm(join(dir, '.visual-diff', 'captures', RUN, 'home.provenance.json'));
      await stageDiff(dir, RUN, ['home']);
      await stageReport(dir, RUN);
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('home.provenance.json')));
    });
  });

  test('an orphan provenance record without its PNG is incomplete', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home', 'settings']);
      await rm(join(dir, '.visual-diff', 'captures', RUN, 'settings.png'));
      await stageDiff(dir, RUN, ['home', 'settings']);
      await stageReport(dir, RUN);
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('settings.png')));
    });
  });

  test('a diff for a state that was never captured is incomplete', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageDiff(dir, RUN, ['home', 'ghost']);
      await stageReport(dir, RUN);
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('ghost.png')));
    });
  });

  test('a report.json that is present but not valid JSON is incomplete', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageDiff(dir, RUN, ['home']);
      await stageReport(dir, RUN, '{ not json');
      const st = await runStatus(layout, RUN);
      assert.equal(st.complete, false);
      assert.equal(st.report, false);
      assert.ok(st.missing.some((m) => m.includes('report.json')));
    });
  });

  test('a missing run directory reports every artifact missing', async () => {
    await withProject(async (dir, layout) => {
      const st = await runStatus(layout, '20260812-000000-deadbe');
      assert.equal(st.complete, false);
      assert.ok(st.missing.some((m) => m.includes('captures')));
      assert.ok(st.missing.some((m) => m.includes('diffs')));
    });
  });
});

// ===========================================================================
// publishRun (FR-18)
// ===========================================================================

describe('publishRun', () => {
  test('a complete run flips the current-run pointer atomically', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      assert.equal(await readCurrentRun(layout), null, 'nothing published yet');
      const out = await publishRun(layout, RUN, { log: sink() });
      assert.equal(out.runId, RUN);
      assert.equal(out.pointer, layout.currentRunFile);
      assert.equal(await readFile(layout.currentRunFile, 'utf8'), `${RUN}\n`);
      assert.equal((await readCurrentRun(layout)).runId, RUN);
    });
  });

  test('publication is idempotent for an already-complete run', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      await publishRun(layout, RUN);
      await publishRun(layout, RUN);
      assert.equal((await readCurrentRun(layout)).runId, RUN);
      assert.equal(await readFile(layout.currentRunFile, 'utf8'), `${RUN}\n`, 'pointer rewritten to the same value');
    });
  });

  test('a run missing report.json is refused and leaves the pointer untouched', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN2);
      await publishRun(layout, RUN2); // current-run := RUN2
      await stageCapture(dir, RUN, ['home']);
      await stageDiff(dir, RUN, ['home']); // no report.json -> interrupted
      await assert.rejects(
        () => publishRun(layout, RUN),
        (err) => err instanceof RunError && err.code === 'RUN_INCOMPLETE' && err.exitCode === 3 && /report\.json/.test(err.message),
      );
      assert.equal((await readCurrentRun(layout)).runId, RUN2, 'the pointer still names the previous complete run');
    });
  });

  test('a run missing diffs is refused and never becomes latest', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageReport(dir, RUN); // captures + report but no diff heatmaps
      await assert.rejects(() => publishRun(layout, RUN), (err) => err instanceof RunError && err.code === 'RUN_INCOMPLETE');
      assert.equal(await readCurrentRun(layout), null, 'an interrupted run must not publish');
    });
  });

  test('a never-published incomplete run cannot be published, pointer stays absent', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']); // nothing else
      await assert.rejects(() => publishRun(layout, RUN), RunError);
      assert.equal(await readCurrentRun(layout), null);
    });
  });

  test('an invalid run-id is a usage error (exit 2), never a partial publish', async () => {
    await withProject(async (dir, layout) => {
      for (const bad of ['../escape', 'a/b', 'bad state', '']) {
        await assert.rejects(() => publishRun(layout, bad), (err) => err instanceof LayoutError && err.exitCode === 2, `expected LayoutError for ${JSON.stringify(bad)}`);
      }
      assert.equal(await readCurrentRun(layout), null);
    });
  });
});

// ===========================================================================
// readCurrentRun (report-side seam, FR-24)
// ===========================================================================

describe('readCurrentRun', () => {
  test('returns null when nothing has been published', async () => {
    await withProject(async (dir, layout) => {
      assert.equal(await readCurrentRun(layout), null);
    });
  });

  test('returns the run-id a completed publish wrote', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      await publishRun(layout, RUN);
      assert.deepEqual(await readCurrentRun(layout), { runId: RUN });
    });
  });

  test('a malformed pointer fails closed with a trust error (exit 3)', async () => {
    await withProject(async (dir, layout) => {
      for (const content of ['not a run id', '../escape', '', '20260812-083000-aaa111\njunk']) {
        await writeFile(layout.currentRunFile, content);
        await assert.rejects(
          () => readCurrentRun(layout),
          (err) => err instanceof RunError && err.code === 'RUN_POINTER_INVALID' && err.exitCode === 3,
          `expected RUN_POINTER_INVALID for ${JSON.stringify(content)}`,
        );
      }
    });
  });
});

// ===========================================================================
// concurrency (best-effort single-pointer semantics)
// ===========================================================================

describe('concurrent publication', () => {
  test('many concurrent publishes of complete runs always leave a complete pointer', async () => {
    await withProject(async (dir, layout) => {
      const runs = ['20260812-100000-r001aa', '20260812-100001-r002bb', '20260812-100002-r003cc'];
      for (const r of runs) await stageCompleteRun(dir, r, { states: [r.endsWith('aa') ? 'home' : 'settings'] });
      await Promise.all(runs.flatMap((r) => [publishRun(layout, r), publishRun(layout, r), publishRun(layout, r)]));
      const pointer = await readCurrentRun(layout);
      assert.ok(runs.includes(pointer.runId), `pointer names one of the published runs (got ${pointer.runId})`);
      assert.equal(await isRunComplete(layout, pointer.runId), true, 'a complete run wins the race');
    });
  });

  test('an incomplete run racing a complete one never wins the pointer', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      await stageCapture(dir, RUN2, ['home']); // RUN2 incomplete: no diffs, no report
      const settled = await Promise.allSettled([publishRun(layout, RUN2), publishRun(layout, RUN)]);
      assert.equal(settled[0].status, 'rejected', 'the incomplete run is refused');
      assert.equal(settled[1].status, 'fulfilled', 'the complete run publishes');
      const pointer = await readCurrentRun(layout);
      assert.equal(pointer.runId, RUN);
      assert.equal(await isRunComplete(layout, pointer.runId), true);
    });
  });
});

// ===========================================================================
// pruneUnpublishedRuns (interrupted-run housekeeping)
// ===========================================================================

describe('pruneUnpublishedRuns', () => {
  test('removes incomplete staged runs but keeps complete, current, and kept ones', async () => {
    await withProject(async (dir, layout) => {
      const complete = '20260812-110000-d001aa'; // complete, will be current
      const completeUnpublished = '20260812-110001-d002bb'; // complete but not current
      const broken = '20260812-110002-d003cc'; // partial capture only
      const kept = '20260812-110003-d004dd'; // partial, but in `keep`
      await stageCompleteRun(dir, complete);
      await stageCompleteRun(dir, completeUnpublished);
      await stageCapture(dir, broken, ['home']); // interrupted mid-capture
      await stageCapture(dir, kept, ['home']); // interrupted mid-capture
      await publishRun(layout, complete);

      const log = sink();
      const removed = await pruneUnpublishedRuns(layout, { keep: [kept], log });
      assert.ok(removed.includes(broken), 'an interrupted capture-only run is pruned');
      assert.ok(!removed.includes(complete), 'a complete run is never pruned');
      assert.ok(!removed.includes(completeUnpublished), 'a complete (unpublished) run is never pruned');
      assert.ok(!removed.includes(kept), 'a kept run is never pruned');
      assert.ok(!removed.includes(complete), 'the current-run is never pruned');

      await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', broken, 'home.png')), /ENOENT/);
      await assert.doesNotReject(readFile(join(dir, '.visual-diff', 'captures', kept, 'home.png')));
      await assert.doesNotReject(readFile(join(dir, '.visual-diff', 'captures', complete, 'home.png')));
      await assert.doesNotReject(readFile(join(dir, '.visual-diff', 'captures', completeUnpublished, 'home.png')));
    });
  });

  test('removes both the captures and diffs halves of a partial run', async () => {
    await withProject(async (dir, layout) => {
      await stageCapture(dir, RUN, ['home']);
      await stageDiff(dir, RUN, ['home']); // report missing -> incomplete
      await pruneUnpublishedRuns(layout);
      await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', RUN, 'home.png')), /ENOENT/);
      await assert.rejects(() => readFile(join(dir, '.visual-diff', 'diffs', RUN, 'home.png')), /ENOENT/);
    });
  });

  test('is a no-op when every staged run is complete', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      await stageCompleteRun(dir, RUN2);
      assert.deepEqual(await pruneUnpublishedRuns(layout), []);
      await assert.doesNotReject(readFile(join(dir, '.visual-diff', 'captures', RUN, 'home.png')));
      await assert.doesNotReject(readFile(join(dir, '.visual-diff', 'captures', RUN2, 'home.png')));
    });
  });

  test('never prunes the currently published run even though it is complete', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN);
      await publishRun(layout, RUN);
      assert.deepEqual(await pruneUnpublishedRuns(layout), []);
      assert.equal((await readCurrentRun(layout)).runId, RUN);
    });
  });
});
