// FILE: scripts/run-tests.mjs
// Node/esbuild test harness for TypeScript suites.
//
// Production behavior is still validated separately by:
//   - npm run validate:assets
//   - npm run build
//
// This harness only provides the minimum Vite compatibility required for
// Node-based unit/integration tests:
//   1. ?worker&url and ?url import stubs
//   2. a deterministic import.meta.env object
//   3. a minimal `vite` module stub for loadEnv()

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

/**
 * Deterministic Vite env exposed ONLY inside esbuild-generated Node test files.
 *
 * These values intentionally mirror the safe production defaults while keeping
 * optional production features disabled.
 *
 * Do not inject process.env wholesale here:
 * GitHub Actions may contain unrelated environment variables or secrets.
 */
const TEST_IMPORT_META_ENV = Object.freeze({
  BASE_URL: '/AR-website/',
  MODE: 'test',
  DEV: false,
  PROD: false,
  SSR: true,

  VITE_PRODUCT_SKU: 'RING-DEMO-001',
  VITE_PRODUCT_NAME: 'Classic Ring',
  VITE_ASSET_VERSION: '1',

  VITE_RING_OUTER_DIAMETER_MM: '18',

  VITE_RING_MODEL_HIGH: 'models/nhan.glb',
  VITE_RING_MODEL_MEDIUM: 'models/nhan.glb',
  VITE_RING_MODEL_LOW: 'models/nhan.glb',

  VITE_RING_USDZ: 'models/nhan.usdz',
  VITE_RING_PREVIEW: 'models/nhan-preview.png',

  VITE_ENABLE_MONOCULAR_DEPTH: 'false',
  VITE_DEPTH_MODEL: 'models/depth/depth_anything_v2_small.onnx',

  VITE_ENABLE_METRIC_SIZING: 'false',
  VITE_METRIC_CALIBRATION_VALIDATED: 'false',

  VITE_ENABLE_PRIVACY_TELEMETRY: 'false',
  VITE_TELEMETRY_ENDPOINT: '/telemetry/ar',
});

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
 * The real Vite behavior is NOT replaced in production. GitHub Actions later
 * runs Vite itself through `npm run build`.
 */
const testCompatibilityPlugin = {
  name: 'ar-test-vite-compatibility',

  setup(buildContext) {
    /**
     * -----------------------------------------------------------
     * Vite URL imports
     * -----------------------------------------------------------
     *
     * Examples:
     *
     *   import workerUrl from './worker.ts?worker&url';
     *   import wasmUrl from 'package/file.wasm?url';
     *
     * Unit tests do not execute/fetch these browser resources, so stop esbuild
     * from traversing into workers/WASM and expose an inert URL string.
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
     * Minimal Vite package boundary
     * -----------------------------------------------------------
     *
     * Node-side asset validation imports `loadEnv` from `vite`.
     *
     * Bundling the entire Vite package with standalone esbuild pulls Vite
     * optional internals such as lightningcss into a unit-test bundle.
     *
     * Tests pass explicit env objects where feature behavior matters, so an
     * empty loadEnv result is deterministic and sufficient here.
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

    /**
     * Vite normally replaces import.meta.env during transformation.
     *
     * Since these tests use esbuild directly, perform the equivalent
     * deterministic replacement here.
     */
    define: {
      'import.meta.env': JSON.stringify(
        TEST_IMPORT_META_ENV,
      ),
    },

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
