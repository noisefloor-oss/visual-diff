// The shared drive grammar's EXECUTION half (FR-37 / FR-39).
//
// One step list, one grammar, one execution loop, two sides:
//   - `compDrive` drives the COMP (src/import.mjs's driven render) into the
//     runtime state its reference must show;
//   - `drive` drives the IMPLEMENTATION (src/capture.mjs) into the same state.
// The grammar and its validation live in src/config.mjs (validateDriveSteps —
// one implementation, one error vocabulary, both keys); this module is the
// matching single execution implementation, so the two sides can never drift
// into disagreeing about what a step MEANS.
//
// Each step waits for its target to become VISIBLE, acts, then settles. A
// target that never becomes visible is a loud failure, never a screenshot of
// the wrong state: the caller supplies `onTargetMissing`, which must throw its
// side's typed error (import: the `drive-target-missing` trust error; capture:
// a CaptureError, both exit 3).

import { isTimeoutError } from './render.mjs';

/**
 * Execute an ordered, validated drive step list against a page.
 *
 * @param page               Playwright page.
 * @param steps              Validated steps (config.mjs validateDriveSteps).
 * @param timeout            Per-step visibility timeout (ms) — readiness.timeout.
 * @param settle             Post-step settle delay (ms) — readiness.settle.
 * @param onTargetMissing    (index, action, selector) => never; MUST throw.
 */
export async function runDriveSteps(page, steps, { timeout, settle, onTargetMissing }) {
  for (const [i, step] of steps.entries()) {
    const [action, arg] = Object.entries(step)[0];
    // Pointer-release and keyboard actions — { mouse: "away" } parks the
    // pointer OUTSIDE the viewport (a full-viewport click-catcher holds
    // :hover for any in-viewport position); { press: { selector, key } }
    // activates by keyboard.
    if (action === 'mouse') {
      await page.mouse.move(-1, -1);
      if (settle > 0) await page.waitForTimeout(settle);
      continue;
    }
    const selector = action === 'press' ? arg.selector : arg;
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      onTargetMissing(i, action, selector);
      // onTargetMissing is contracted to throw; a caller that returns instead
      // must not silently proceed into a frame of the wrong state.
      throw new Error(`drive step ${i} (${action} ${JSON.stringify(selector)}) target never became visible`);
    }
    if (action === 'press') await page.press(selector, arg.key);
    else await page[action](selector);
    if (settle > 0) await page.waitForTimeout(settle);
  }
}
