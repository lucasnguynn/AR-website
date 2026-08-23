// FILE: scripts/run-tests.mjs
// Node test harness for TypeScript suites.
//
// Production Vite-specific imports such as:
//   ?worker&url
//   ?url
// and Vite's loadEnv() are handled by the real Vite production pipeline.
//
// Unit/integration tests are bundled with esbuild directly. The test harness
// therefore replaces browser-only Vite URL modules and the Vite loadEnv module
// boundary with deterministic Node-test stubs.
//
// IMPORTANT:
// This does NOT weaken production validation.
// GitHub Actions runs the real:
//   npm run validate:assets
// and later:
//   npm run build
// with Vite itself.

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

const directory = await mkdtemp(
  join(tmpdir(), 'ar-tests-'),
);

const suites = {
  unit: [
    [
      'tests/orchestration.test.ts',
      'run',
    ],
    [
      'tests/camera-system.test.ts',
      'runCameraSystemTests',
    ],
    [
      'tests/webxr.test.ts',
      'runWebXRTests',
    ],
    [
      'tests/depth-pipeline.test.ts',
      'runDepthPipelineTests',
    ],
    [
      'tests/integrity.test.ts',
      'runIntegrityTests',
    ],
    [
      'tests/material-strategy.test.ts',
      'runMaterialStrategyTests',
    ],
    [
      'tests/asset-contracts.test.ts',
      'runAssetContractTests',
    ],
    [
      'tests/pose-pipeline.test.ts',
      'runPosePipelineTests',
    ],
    [
      'tests/performance-accessibility.test.ts',
      'runPerformanceAccessibilityTests',
    ],
    [
      'tests/coordinate-tracking.test.ts',
      'runCoordinateTrackingTests',
    ],
    [
      'tests/worker-protocol.test.ts',
      'runWorkerProtocolTests',
    ],
  ],

  integration: [
    [
      'tests/browser-contracts.test.ts',
      'runBrowserContractTests',
    ],
  ],
};

const selection = process.argv[2] ?? 'unit';

if (!(selection in suites)) {
  throw new Error(
    `Unknown test suite: ${selection}`,
  );
}

/**
 * Test-only compatibility layer for Vite module semantics.
 *
 * esbuild by itself does not understand:
 *
 *   import workerUrl from './worker.ts?worker&url';
 *   import wasmUrl from 'package/file.wasm?url';
 *
 * Unit tests also do not need to bundle the full Vite implementation merely
 * because a Node-side validation helper imports `loadEnv` from `vite`.
 *
 * The real Vite behavior is validated separately by the production build.
 */
const testCompatibilityPlugin = {
  name: 'ar-test-vite-compatibility',

  setup(buildContext) {
    /**
     * -----------------------------------------------------------
     * 1. Stub Vite URL imports.
     * -----------------------------------------------------------
     *
     * Prevent esbuild from traversing workers, WASM binaries, HDR assets, etc.
     * during Node unit tests.
     */
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
            `/__vite_test_asset__/${encodeURIComponent(
              args.path,
            )}`,
          )};
        `,
        loader: 'js',
      }),
    );

    /**
     * -----------------------------------------------------------
     * 2. Stub the Vite package boundary for Node tests.
     * -----------------------------------------------------------
     *
     * `scripts/validate-assets.mjs` imports:
     *
     *   import { loadEnv } from 'vite';
     *
     * Bundling the entire Vite package causes esbuild to inspect optional Vite
     * dependencies such as lightningcss. Unit tests do not need those modules.
     *
     * Tests that require feature flags pass an explicit env object to
     * validateAssets(), so returning an empty loaded env here is deterministic.
     *
     * Production still uses Vite's real loadEnv().
     */
    buildContext.onResolve(
      {
        filter: /^vite$/,
      },
      () => ({
        path: 'vite',
        namespace: 'vite-module-stub',
      }),
    );

    buildContext.onLoad(
      {
        filter: /.*/,
        namespace: 'vite-module-stub',
      },
      () => ({
        contents: `
          export function loadEnv() {
            return {};
          }

          export function defineConfig(config) {
            return config;
          }
        `,
        loader: 'js',
      }),
    );
  },
};

async function runTestFile(
  source,
  exported,
) {
  const output = join(
    directory,
    `${exported}.mjs`,
  );

  await build({
    entryPoints: [
      source,
    ],

    outfile: output,

    bundle: true,

    platform: 'node',

    format: 'esm',

    target: 'node20',

    sourcemap: 'inline',

    plugins: [
      testCompatibilityPlugin,
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

try {
  for (
    const [source, exported]
    of suites[selection]
  ) {
    await runTestFile(
      source,
      exported,
    );
  }

  console.log(
    `${selection} test suite passed `
    + `(${suites[selection].length} files).`,
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
