import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { probeMaskElements } from '../src/masks.mjs';

let liveClient = null;
try {
  const req = createRequire(import.meta.url);
  liveClient = req('playwright');
} catch {
  liveClient = null;
}
const LIVE_ENDPOINT = process.env.NOISE_BROWSER_WS || '';
const canRunLive = Boolean(liveClient && LIVE_ENDPOINT);

test(
  'calc() ring radii fail measurement in live Chromium; plain px/% still resolve',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  async () => {
    const browser = await liveClient.chromium.connect(LIVE_ENDPOINT, { timeout: 10000 });
    try {
      const page = await browser.newPage();
      await page.setContent([
        '<style>body { margin: 0; } div { box-sizing: border-box; }</style>',
        '<div id="calc" style="width:100px;height:50px;border:2px solid;border-radius:calc(50% + 10px)"></div>',
        '<div id="px" style="width:100px;height:50px;border:2px solid;border-radius:8px 4px"></div>',
        '<div id="pct" style="width:100px;height:50px;border:2px solid;border-radius:50%"></div>',
      ].join(''));
      const computed = await page.$eval('#calc', (el) => getComputedStyle(el).borderTopLeftRadius);
      assert.equal(computed, 'calc(50% + 10px)', 'Chromium reaches the symbolic-value case under test');
      const probes = await page.evaluate(probeMaskElements, { calc: '#calc', px: '#px', pct: '#pct' });
      assert.deepEqual(probes.calc, {
        matches: 1,
        visible: 1,
        box: { x: 0, y: 0, width: 100, height: 50 },
        radiusError: { property: 'border-top-left-radius', value: 'calc(50% + 10px)' },
      });
      assert.equal(probes.calc.radii, undefined, 'no zero-radius ring fallback crosses the browser boundary');
      assert.deepEqual(probes.px.radii.tl, { rx: 8, ry: 8 });
      assert.deepEqual(probes.px.radii.tr, { rx: 4, ry: 4 });
      assert.deepEqual(probes.pct.radii.tl, { rx: 50, ry: 25 });
    } finally {
      await browser.close();
    }
  },
);
