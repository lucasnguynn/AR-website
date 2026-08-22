// Cung cấp biến môi trường giả lập (Polyfill) cho Node.js để chạy test
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
// Giả lập DOM Events cho Node.js
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.options = options;
    }
  };
}
if (typeof globalThis.window.dispatchEvent === 'undefined') {
  globalThis.window.dispatchEvent = () => true; // Hàm rỗng (no-op)
}

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'ar-tests-'));
const suites = {
  unit: [
    ['tests/orchestration.test.ts', 'run'], 
    ['tests/camera-system.test.ts', 'runCameraSystemTests'],
    ['tests/webxr.test.ts', 'runWebXRTests'], 
    ['tests/depth-pipeline.test.ts', 'runDepthPipelineTests'], 
    ['tests/integrity.test.ts', 'runIntegrityTests'], 
    ['tests/material-strategy.test.ts', 'runMaterialStrategyTests'],
    ['tests/pose-pipeline.test.ts', 'runPosePipelineTests'],
    ['tests/performance-accessibility.test.ts', 'runPerformanceAccessibilityTests'],
    ['tests/coordinate-tracking.test.ts', 'runCoordinateTrackingTests'],
    ['tests/worker-protocol.test.ts', 'runWorkerProtocolTests'],
  ],
  integration: [['tests/browser-contracts.test.ts', 'runBrowserContractTests']],
};
const selection = process.argv[2] ?? 'unit';
if (!(selection in suites)) throw new Error(`Unknown test suite: ${selection}`);
try {
  for (const [source, exported] of suites[selection]) {
    const output = join(directory, `${exported}.mjs`);
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
    await (await import(pathToFileURL(output).href))[exported]();
  }
  console.log(`${selection} test suite passed (${suites[selection].length} files).`);
} finally { 
  await rm(directory, { recursive: true, force: true }); 
}
