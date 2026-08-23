import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_MODELS_DIR = path.resolve(__dirname, '../assets/models/raw');
const GENERATED_DIR = path.resolve(__dirname, '../assets/models/generated');

// Keep headroom under the release audit budgets because simplification ratios are
// approximate and Draco/file-size results depend on topology.
const LOD_TARGETS = [
  { suffix: 'high', maxTriangles: 44_000, error: 0.00008 },
  { suffix: 'medium', maxTriangles: 19_000, error: 0.0007 },
  { suffix: 'low', maxTriangles: 7_500, error: 0.003 },
];

fs.mkdirSync(GENERATED_DIR, { recursive: true });
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function modelName(file) {
  return path.basename(file, path.extname(file));
}

function primitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);
  const position = primitive.getAttribute('POSITION');
  return position ? Math.floor(position.getCount() / 3) : 0;
}

function documentTriangles(document) {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) triangles += primitiveTriangles(primitive);
  }
  return triangles;
}

async function buildLod(inputPath, outputPath, target) {
  const document = await io.read(inputPath);
  const sourceTriangles = documentTriangles(document);
  if (sourceTriangles <= 0) throw new Error(`${path.basename(inputPath)} contains no triangles.`);

  // Leave ~2% headroom below the absolute target. The simplify transform applies
  // the ratio to each primitive while preserving node/primitive boundaries.
  const ratio = sourceTriangles <= target.maxTriangles
    ? 1
    : Math.max(0.01, Math.min(1, (target.maxTriangles / sourceTriangles) * 0.98));

  const transforms = [
    dedup(),
    resample(),
    weld({ tolerance: 0.00001 }),
  ];

  if (ratio < 0.999) {
    transforms.push(simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error: target.error,
      lockBorder: true,
    }));
  }

  transforms.push(prune());

  // IMPORTANT: never flatten/join globally here. Metal and Gemstone nodes are a
  // runtime semantic contract and must remain separate after optimization.
  await document.transform(...transforms);

  const outputTriangles = documentTriangles(document);
  await io.write(outputPath, document);

  const kib = (fs.statSync(outputPath).size / 1024).toFixed(0);
  console.log(
    `LOD ${target.suffix}: ${path.basename(outputPath)} | `
    + `${sourceTriangles.toLocaleString()} -> ${outputTriangles.toLocaleString()} triangles | ${kib} KiB`,
  );

  if (outputTriangles > target.maxTriangles) {
    throw new Error(
      `LOD ${target.suffix} exceeded its pre-compression triangle target: `
      + `${outputTriangles.toLocaleString()} > ${target.maxTriangles.toLocaleString()}. `
      + 'Reduce source topology or author a dedicated LOD.',
    );
  }
}

if (!fs.existsSync(RAW_MODELS_DIR)) {
  console.error(`Raw model directory not found: ${RAW_MODELS_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(RAW_MODELS_DIR)
  .filter((file) => file.toLowerCase().endsWith('.glb'));

if (!files.length) {
  console.error('Place the authored semantic GLB in assets/models/raw before running npm run build:assets.');
  process.exit(1);
}

for (const file of files) {
  const input = path.join(RAW_MODELS_DIR, file);
  for (const target of LOD_TARGETS) {
    await buildLod(input, path.join(GENERATED_DIR, `${modelName(file)}-${target.suffix}.glb`), target);
  }
}
