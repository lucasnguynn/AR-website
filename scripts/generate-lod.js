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
const LOD_TARGETS = [
  { suffix: 'high', ratio: 0.38, error: 0.00008 },
  { suffix: 'medium', ratio: 0.16, error: 0.0007 },
  { suffix: 'low', ratio: 0.06, error: 0.003 },
];

fs.mkdirSync(GENERATED_DIR, { recursive: true });
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function modelName(file) { return path.basename(file, path.extname(file)); }

async function buildLod(inputPath, outputPath, target) {
  const document = await io.read(inputPath);
  // IMPORTANT: never flatten/join globally here. Metal and Gemstone nodes are a
  // runtime semantic contract and must remain separate after optimization.
  await document.transform(
    dedup(),
    resample(),
    weld({ tolerance: 0.00001 }),
    simplify({ simplifier: MeshoptSimplifier, ratio: target.ratio, error: target.error, lockBorder: true }),
    prune(),
  );
  await io.write(outputPath, document);
  console.log(`LOD ${target.suffix}: ${path.basename(outputPath)} (${(fs.statSync(outputPath).size / 1024).toFixed(0)} KiB)`);
}

if (!fs.existsSync(RAW_MODELS_DIR)) {
  console.error(`Raw model directory not found: ${RAW_MODELS_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(RAW_MODELS_DIR).filter((file) => file.toLowerCase().endsWith('.glb'));
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
