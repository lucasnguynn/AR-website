import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, prune, resample, simplify, weld } from '@gltf-transform/functions';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RAW_MODELS_DIR = path.resolve(__dirname, '../assets/models/raw');
const OUTPUT_MODELS_DIR = path.resolve(__dirname, '../public/models');
const LOD_TARGETS = [
  { suffix: 'high', ratio: 1.0, error: 0.0001 },
  { suffix: 'medium', ratio: 0.55, error: 0.0015 },
  { suffix: 'low', ratio: 0.25, error: 0.006 },
];

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function modelName(file) {
  return path.basename(file, path.extname(file));
}

async function writeLod(io, inputPath, outputPath, target) {
  const document = await io.read(inputPath);
  const transforms = [dedup(), resample(), prune()];

  if (target.ratio < 1) {
    transforms.push(weld({ tolerance: 0.0001 }));
    transforms.push(simplify({ ratio: target.ratio, error: target.error, lockBorder: true }));
    transforms.push(flatten());
    transforms.push(join());
    transforms.push(prune());
  }

  await document.transform(...transforms);
  await io.write(outputPath, document);

  const sourceKb = (fs.statSync(inputPath).size / 1024).toFixed(1);
  const outputKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`✅ ${path.basename(outputPath)} (${sourceKb} KB → ${outputKb} KB)`);
}

async function main() {
  ensureDirectory(OUTPUT_MODELS_DIR);

  if (!fs.existsSync(RAW_MODELS_DIR)) {
    console.warn(`⚠️ Raw model directory not found: ${RAW_MODELS_DIR}`);
    return;
  }

  const glbFiles = fs.readdirSync(RAW_MODELS_DIR).filter((file) => file.toLowerCase().endsWith('.glb'));
  if (glbFiles.length === 0) {
    console.warn('⚠️ No .glb files found in assets/models/raw; skipping LOD generation.');
    return;
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  for (const file of glbFiles) {
    const inputPath = path.join(RAW_MODELS_DIR, file);
    for (const target of LOD_TARGETS) {
      const outputPath = path.join(OUTPUT_MODELS_DIR, `${modelName(file)}-${target.suffix}.glb`);
      await writeLod(io, inputPath, outputPath, target);
    }
  }
}

main().catch((error) => {
  console.error('❌ LOD generation failed:', error);
  process.exit(1);
});
