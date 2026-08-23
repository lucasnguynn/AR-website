import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  meshopt,
  prune,
  simplify,
  weld,
} from '@gltf-transform/functions';
import {
  MeshoptEncoder,
  MeshoptSimplifier,
} from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(
  fileURLToPath(import.meta.url),
);

const ROOT = path.resolve(
  __dirname,
  '..',
);

const INPUT = path.join(
  ROOT,
  'public/models/nhan.glb',
);

const OUTPUT_DIR = path.join(
  ROOT,
  'public/models',
);

/**
 * Conservative LOD targets for the CURRENT legacy ring.
 *
 * This model was not authored as a clean semantic production asset.
 * Therefore we preserve more geometry than the future production pipeline.
 */
const TARGETS = [
  {
    name: 'HIGH',
    suffix: 'high',
    maxTriangles: 90_000,

    errorSchedule: [
      0.00008,
      0.0002,
      0.0005,
      0.001,
      0.002,
      0.005,
      0.01,
    ],
  },

  {
    name: 'MEDIUM',
    suffix: 'medium',
    maxTriangles: 60_000,

    errorSchedule: [
      0.0002,
      0.0005,
      0.001,
      0.002,
      0.005,
      0.01,
      0.02,
    ],
  },

  {
    name: 'LOW',
    suffix: 'low',
    maxTriangles: 30_000,

    errorSchedule: [
      0.0005,
      0.001,
      0.002,
      0.005,
      0.01,
      0.02,
      0.05,
    ],
  },
];

function primitiveTriangles(
  primitive,
) {
  const indices =
    primitive.getIndices();

  if (indices) {
    return Math.floor(
      indices.getCount() / 3,
    );
  }

  const position =
    primitive.getAttribute(
      'POSITION',
    );

  return position
    ? Math.floor(
        position.getCount() / 3,
      )
    : 0;
}

function documentTriangles(
  document,
) {
  let triangles = 0;

  for (
    const mesh
    of document
      .getRoot()
      .listMeshes()
  ) {
    for (
      const primitive
      of mesh.listPrimitives()
    ) {
      triangles +=
        primitiveTriangles(
          primitive,
        );
    }
  }

  return triangles;
}

function kib(
  bytes,
) {
  return (
    bytes / 1024
  ).toFixed(0);
}

function reductionPercent(
  inputBytes,
  outputBytes,
) {
  return Number(
    (
      (
        1
        - outputBytes
          / inputBytes
      )
      * 100
    ).toFixed(1),
  );
}

if (
  !fs.existsSync(INPUT)
) {
  throw new Error(
    `Current runtime ring was not found: ${INPUT}`,
  );
}

fs.mkdirSync(
  OUTPUT_DIR,
  {
    recursive: true,
  },
);

await Promise.all([
  MeshoptSimplifier.ready,
  MeshoptEncoder.ready,
]);

const io =
  new NodeIO()
    .registerExtensions(
      ALL_EXTENSIONS,
    )
    .registerDependencies({
      'meshopt.encoder':
        MeshoptEncoder,
    });

const sourceDocument =
  await io.read(
    INPUT,
  );

const sourceTriangles =
  documentTriangles(
    sourceDocument,
  );

if (
  sourceTriangles <= 0
) {
  throw new Error(
    'public/models/nhan.glb contains no triangle geometry.',
  );
}

const inputBytes =
  fs.statSync(
    INPUT,
  ).size;

console.log(
  `Source: ${
    sourceTriangles
      .toLocaleString()
  } triangles | ${
    kib(inputBytes)
  } KiB`,
);

const report = [];

/**
 * Build one candidate from the ORIGINAL model.
 *
 * Every attempt starts again from nhan.glb so simplification
 * never compounds across attempts.
 */
async function buildCandidate(
  target,
  error,
  lockBorder,
) {
  const document =
    await io.read(
      INPUT,
    );

  const ratio =
    sourceTriangles
      <= target.maxTriangles

      ? 1

      : Math.max(
          0.01,

          Math.min(
            1,

            (
              target.maxTriangles
              / sourceTriangles
            )
            * 0.985,
          ),
        );

  const transforms = [
    dedup(),

    weld({
      tolerance:
        0.00001,
    }),
  ];

  if (
    ratio < 0.999
  ) {
    transforms.push(
      simplify({
        simplifier:
          MeshoptSimplifier,

        ratio,

        /**
         * simplify() may stop before reaching the requested ratio
         * if the error threshold is reached.
         *
         * Therefore we try progressively larger error thresholds.
         */
        error,

        lockBorder,
      }),
    );
  }

  transforms.push(
    prune(),
  );

  await document.transform(
    ...transforms,
  );

  return {
    document,

    triangles:
      documentTriangles(
        document,
      ),

    error,

    lockBorder,
  };
}

/**
 * Try increasingly relaxed simplification settings.
 *
 * First preserve mesh borders.
 * Only disable border locking if needed.
 */
async function chooseCandidate(
  target,
) {
  let best = null;
  let attempts = 0;

  const passes = [
    {
      lockBorder: true,

      errors:
        target.errorSchedule,
    },

    {
      lockBorder: false,

      errors: [
        ...target.errorSchedule,

        0.1,

        1.0,
      ],
    },
  ];

  for (
    const pass
    of passes
  ) {
    for (
      const error
      of pass.errors
    ) {
      attempts += 1;

      const candidate =
        await buildCandidate(
          target,
          error,
          pass.lockBorder,
        );

      console.log(
        `${
          target.name
        } attempt ${
          attempts
        }: `
        + `error=${
          error
        } `
        + `lockBorder=${
          pass.lockBorder
        } `
        + `=> ${
          candidate
            .triangles
            .toLocaleString()
        } triangles`,
      );

      if (
        !best
        || candidate.triangles
          < best.triangles
      ) {
        best =
          candidate;
      }

      if (
        candidate.triangles
        <= target.maxTriangles
      ) {
        return {
          ...candidate,

          attempts,

          targetMet:
            true,
        };
      }
    }
  }

  if (!best) {
    throw new Error(
      `${target.name}: no simplification candidate was produced.`,
    );
  }

  /**
   * Important:
   *
   * Do NOT fail the complete workflow just because a legacy mesh
   * cannot safely reach an aggressive target.
   *
   * Keep the smallest valid result and expose targetMet=false
   * in the report for review.
   */
  console.warn(
    `${
      target.name
    }: requested target ${
      target.maxTriangles
        .toLocaleString()
    } was not reached. `
    + `Using ${
      best.triangles
        .toLocaleString()
    } triangles.`,
  );

  return {
    ...best,

    attempts,

    targetMet:
      false,
  };
}

for (
  const target
  of TARGETS
) {
  const selected =
    await chooseCandidate(
      target,
    );

  /**
   * Apply Meshopt only AFTER choosing the final geometry.
   *
   * This keeps the iterative simplification stage fast
   * and reduces transfer size for WebAR.
   */
  await selected
    .document
    .transform(
      meshopt({
        encoder:
          MeshoptEncoder,

        level:
          'medium',
      }),
    );

  const output =
    path.join(
      OUTPUT_DIR,

      `nhan-${
        target.suffix
      }.glb`,
    );

  await io.write(
    output,
    selected.document,
  );

  const outputBytes =
    fs.statSync(
      output,
    ).size;

  /**
   * File-size reduction is still mandatory.
   *
   * If optimization makes a file larger than the original,
   * something is wrong and that result should not be deployed.
   */
  if (
    outputBytes
    >= inputBytes
  ) {
    throw new Error(
      `${
        target.name
      } did not reduce transfer size: `
      + `${
        outputBytes
      } >= ${
        inputBytes
      } bytes`,
    );
  }

  const reduction =
    reductionPercent(
      inputBytes,
      outputBytes,
    );

  report.push({
    tier:
      target.name,

    file:
      `public/models/nhan-${
        target.suffix
      }.glb`,

    sourceTriangles,

    requestedMaxTriangles:
      target.maxTriangles,

    outputTriangles:
      selected.triangles,

    targetMet:
      selected.targetMet,

    selectedError:
      selected.error,

    lockBorder:
      selected.lockBorder,

    attempts:
      selected.attempts,

    inputBytes,

    outputBytes,

    reductionPercent:
      reduction,
  });

  console.log(
    `${
      target.name
    } SELECTED: `
    + `${
      sourceTriangles
        .toLocaleString()
    } -> `
    + `${
      selected
        .triangles
        .toLocaleString()
    } triangles | `
    + `${
      kib(inputBytes)
    } KiB -> ${
      kib(outputBytes)
    } KiB | `
    + `${
      reduction
    }% smaller | `
    + `targetMet=${
      selected.targetMet
    } | `
    + `error=${
      selected.error
    } | `
    + `lockBorder=${
      selected.lockBorder
    }`,
  );
}

const reportPath =
  path.join(
    OUTPUT_DIR,

    'nhan-optimization-report.json',
  );

fs.writeFileSync(
  reportPath,

  `${JSON.stringify(
    {
      source:
        'public/models/nhan.glb',

      policy:
        'legacy-current-ring-conservative-lod',

      compression:
        'EXT_meshopt_compression',

      generatedAt:
        new Date()
          .toISOString(),

      tiers:
        report,
    },

    null,

    2,
  )}\n`,

  'utf8',
);

console.log(
  `Wrote ${
    path.relative(
      ROOT,
      reportPath,
    )
  }`,
);
