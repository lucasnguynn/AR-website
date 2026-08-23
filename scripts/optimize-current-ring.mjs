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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'public/models/nhan.glb');
const OUTPUT_DIR = path.join(ROOT, 'public/models');

const TARGETS = [
  {
    name: 'HIGH',
    suffix: 'high',
    maxTriangles: 44_000,
    simplifyError: 0.00008,
  },
  {
    name: 'MEDIUM',
    suffix: 'medium',
    maxTriangles: 19_000,
    simplifyError: 0.0007,
  },
  {
    name: 'LOW',
    suffix: 'low',
    maxTriangles: 7_500,
    simplifyError: 0.003,
  },
];

function primitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);

  const position = primitive.getAttribute('POSITION');
  return position ? Math.floor(position.getCount() / 3) : 0;
}

function documentTriangles(document) {
  let triangles = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      triangles += primitiveTriangles(primitive);
    }
  }

  return triangles;
}

function kib(bytes) {
  return (bytes / 1024).toFixed(0);
}

if (!fs.existsSync(INPUT)) {
  throw new Error(`Current runtime ring was not found: ${INPUT}`);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

await Promise.all([
  MeshoptSimplifier.ready,
  MeshoptEncoder.ready,
]);

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
  });

const inputBytes = fs.statSync(INPUT).size;
const report = [];

for (const target of TARGETS) {
  // Re-read the original for every tier so simplification never compounds.
  const document = await io.read(INPUT);
  const sourceTriangles = documentTriangles(document);

  if (sourceTriangles <= 0) {
    throw new Error('public/models/nhan.glb contains no triangle geometry.');
  }

  const ratio = sourceTriangles <= target.maxTriangles
    ? 1
    : Math.max(
        0.01,
        Math.min(
          1,
          (target.maxTriangles / sourceTriangles) * 0.98,
        ),
      );

  const transforms = [
    dedup(),
    weld({ tolerance: 0.00001 }),
  ];

  if (ratio < 0.999) {
    transforms.push(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        error: target.simplifyError,
        lockBorder: true,
      }),
    );
  }

  transforms.push(
    prune(),
    // Meshopt is chosen instead of Draco for the current MVP because Drei's
    // useGLTF already enables Meshopt decoding without an external decoder CDN.
    meshopt({
      encoder: MeshoptEncoder,
      level: 'medium',
    }),
  );

  await document.transform(...transforms);

  const outputTriangles = documentTriangles(document);
  const output = path.join(
    OUTPUT_DIR,
    `nhan-${target.suffix}.glb`,
  );

  await io.write(output, document);

  const outputBytes = fs.statSync(output).size;

  if (outputTriangles > target.maxTriangles) {
    throw new Error(
      `${target.name} exceeded triangle target: `
      + `${outputTriangles} > ${target.maxTriangles}`,
    );
  }

  if (outputBytes >= inputBytes) {
    throw new Error(
      `${target.name} did not reduce transfer size: `
      + `${outputBytes} >= ${inputBytes} bytes`,
    );
  }

  const reduction = (
    (1 - outputBytes / inputBytes) * 100
  ).toFixed(1);

  report.push({
    tier: target.name,
    sourceTriangles,
    outputTriangles,
    inputBytes,
    outputBytes,
    reductionPercent: Number(reduction),
    file: `public/models/nhan-${target.suffix}.glb`,
  });

  console.log(
    `${target.name}: `
    + `${sourceTriangles.toLocaleString()} -> `
    + `${outputTriangles.toLocaleString()} triangles | `
    + `${kib(inputBytes)} KiB -> ${kib(outputBytes)} KiB | `
    + `${reduction}% smaller`,
  );
}

const reportPath = path.join(
  OUTPUT_DIR,
  'nhan-optimization-report.json',
);

fs.writeFileSync(
  reportPath,
  `${JSON.stringify({
    source: 'public/models/nhan.glb',
    compression: 'EXT_meshopt_compression',
    generatedAt: new Date().toISOString(),
    tiers: report,
  }, null, 2)}\n`,
  'utf8',
);

console.log(`Wrote ${path.relative(ROOT, reportPath)}`);
