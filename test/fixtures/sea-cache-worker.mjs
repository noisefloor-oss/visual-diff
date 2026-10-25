import { readFile } from 'node:fs/promises';
import { materializeToCache } from '../../src/playwright-loader.mjs';

async function main() {
  const [cacheRoot, manifestPath, assetsPath, holdFirstAsset] = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const assetFiles = JSON.parse(await readFile(assetsPath, 'utf8'));
  let extractionReads = 0;
  let openGoGate;
  let openExtractionGate;
  const goGate = new Promise((resolve) => {
    openGoGate = resolve;
  });
  const extractionGate = new Promise((resolve) => {
    openExtractionGate = resolve;
  });

  process.on('message', (message) => {
    if (message.type === 'go') openGoGate();
    if (message.type === 'release') openExtractionGate();
  });

  const sea = {
    async getAssetAsBlob(name) {
      if (name === 'manifest') return new Blob([JSON.stringify(manifest)]);
      extractionReads += 1;
      if (holdFirstAsset === '--hold-first-asset' && extractionReads === 1) {
        process.send({ type: 'extracting', pid: process.pid });
        await extractionGate;
      }
      return new Blob([assetFiles[name]]);
    },
  };

  process.send({ type: 'ready', pid: process.pid });
  await goGate;
  try {
    const nodeModulesDir = await materializeToCache(sea, cacheRoot);
    process.send({ type: 'result', ok: true, extractionReads, nodeModulesDir });
  } catch (err) {
    process.send({ type: 'result', ok: false, extractionReads, error: err.stack });
  }
}

if (process.argv[2] !== undefined) await main();
