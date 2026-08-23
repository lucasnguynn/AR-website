// FILE: scripts/run-tests.mjs
// Node test harness for TypeScript suites.
//
// Production asset/worker URL imports are handled by Vite (`?worker&url`, `?url`).
// Unit tests are bundled with esbuild directly, so we provide a small test-only
// resolver that replaces those URL imports with inert strings. The real Vite
// resolution is still validated later by `npm run build`.

if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
}

if (typeof globalThis.window.dispatchEvent === 'undefined') {
  globalThis.window.dispatchEvent = () => true;
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
    ['tests/asset-contracts.test.ts', 'runAssetContractTests'],
    ['tests/pose-pipeline.test.ts', 'runPosePipelineTests'],
    ['tests/performance-accessibility.test.ts', 'runPerformanceAccessibilityTests'],
    ['tests/coordinate-tracking.test.ts', 'runCoordinateTrackingTests'],
    ['tests/worker-protocol.test.ts', 'runWorkerProtocolTests'],
  ],

  integration: [
    ['tests/browser-contracts.test.ts', 'runBrowserContractTests'],
  ],
};

const selection = process.argv[2] ?? 'unit';

if (!(selection in suites)) {
  throw new Error(`Unknown test suite: ${selection}`);
}

/**
 * esbuild does not implement Vite's query-import semantics.
 *
 * Examples used by the production app:
 *
 *   import workerUrl from './worker.ts?worker&url';
 *   import wasmUrl from 'package/file.wasm?url';
 *
 * During Node unit tests these assets are never executed or fetched.
 *
 * Therefore the test harness replaces Vite URL imports with inert URL strings.
 *
 * IMPORTANT:
 * This affects ONLY the Node unit-test bundler.
 *
 * The real production worker/WASM resolution is still checked later by:
 *
 *   npm run build
 *
 * which runs Vite itself.
 */
const viteUrlStubPlugin = {
  name: 'vite-url-stub-for-node-tests',

  setup(buildContext) {
    buildContext.onResolve(
      {
        filter: /\?(?:worker&url|url)$/,
      },
      (args) => ({
        path: args.path,
        namespace: 'vite-url-stub',
      }),
    );

    buildContext.onLoad(
      {
        filter: /.*/,
        namespace: 'vite-url-stub',
      },
      (args) => ({
        contents: `
          export default ${JSON.stringify(
            `/__vite_test_asset__/${encodeURIComponent(args.path)}`,
          )};
        `,
        loader: 'js',
      }),
    );
  },
};

try {
  for (const [source, exported] of suites[selection]) {
    const output = join(
      directory,
      `${exported}.mjs`,
    );

    await build({
      entryPoints: [source],

      outfile: output,

      bundle: true,

      platform: 'node',

      format: 'esm',

      target: 'node20',

      sourcemap: 'inline',

      plugins: [
        viteUrlStubPlugin,
      ],
    });

    const module = await import(
      pathToFileURL(output).href,
    );

    const runner = module[exported];

    if (typeof runner !== 'function') {
      throw new TypeError(
        `${source} does not export a callable ${exported}() test runner.`,
      );
    }

    await runner();
  }

  console.log(
    `${selection} test suite passed (${suites[selection].length} files).`,
  );
} finally {
  await rm(
    directory,
    {
      recursive: true,
      force: true,
    },
  );
}
