import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'ar-tests-'));
try {
  for (const [source, exported] of [['tests/orchestration.test.ts', 'run'], ['tests/webxr.test.ts', 'runWebXRTests'], ['tests/depth-pipeline.test.ts', 'runDepthPipelineTests'], ['tests/integrity.test.ts', 'runIntegrityTests'], ['tests/material-strategy.test.ts', 'runMaterialStrategyTests']]) {
    const output = join(directory, `${exported}.mjs`);
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
    await (await import(pathToFileURL(output).href))[exported]();
  }
  console.log('Orchestration, WebXR lifecycle/depth, protocol, integrity, materials, base-path, and asset-preflight tests passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
