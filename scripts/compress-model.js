import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco, dedup, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.resolve(__dirname, '../assets/models/generated');
const OUTPUT_DIR = path.resolve(__dirname, '../public/models');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const encoder = await draco3d.createEncoderModule();
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.encoder': encoder });

if (!fs.existsSync(GENERATED_DIR)) {
  console.error(`Generated LOD directory not found: ${GENERATED_DIR}. Run npm run lod first.`);
  process.exit(1);
}

const files = fs.readdirSync(GENERATED_DIR).filter((file) => /-(high|medium|low)\.glb$/i.test(file));
if (!files.length) {
  console.error('No generated LOD GLBs found. Run npm run lod first.');
  process.exit(1);
}

for (const file of files) {
  const input = path.join(GENERATED_DIR, file);
  const output = path.join(OUTPUT_DIR, file);
  const document = await io.read(input);
  await document.transform(
    dedup(),
    prune(),
    draco(),
  );
  await io.write(output, document);
  const sourceBytes = fs.statSync(input).size;
  const outputBytes = fs.statSync(output).size;
  console.log(`Compressed ${file}: ${(sourceBytes / 1024).toFixed(0)} KiB -> ${(outputBytes / 1024).toFixed(0)} KiB`);
}
