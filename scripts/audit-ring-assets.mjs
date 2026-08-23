import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import draco3d from 'draco3dgltf';

const MAX = {
  high: { bytes: 1_500_000, triangles: 45_000 },
  medium: { bytes: 900_000, triangles: 20_000 },
  low: { bytes: 500_000, triangles: 8_000 },
};

const SUPPORTED_GEMSTONE_TYPES = new Set(['diamond', 'sapphire', 'ruby', 'emerald', 'amethyst']);
const args = process.argv.slice(2);
const files = args.length ? args : [
  'public/models/nhan-high.glb',
  'public/models/nhan-medium.glb',
  'public/models/nhan-low.glb',
];

function tierOf(file) {
  if (/-low\.glb$/i.test(file)) return 'low';
  if (/-medium\.glb$/i.test(file)) return 'medium';
  return 'high';
}

function text(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function explicitMetadata(node, mesh, material) {
  const sources = [node.getExtras(), mesh.getExtras(), material?.getExtras()];
  const unique = (key) => [...new Set(sources.map((source) => text(source?.[key])).filter(Boolean))];
  const roles = unique('materialRole');
  const gemstoneTypes = unique('gemstoneType');

  if (roles.length !== 1) return { role: 'unknown', reason: roles.length === 0 ? 'missing materialRole' : 'conflicting materialRole' };
  const role = roles[0];
  if (role !== 'metal' && role !== 'gemstone') return { role: 'unknown', reason: `unsupported materialRole=${role}` };

  if (role === 'gemstone') {
    if (gemstoneTypes.length !== 1) return { role: 'unknown', reason: gemstoneTypes.length === 0 ? 'missing gemstoneType' : 'conflicting gemstoneType' };
    if (!SUPPORTED_GEMSTONE_TYPES.has(gemstoneTypes[0])) return { role: 'unknown', reason: `unsupported gemstoneType=${gemstoneTypes[0]}` };
    return { role, gemstoneType: gemstoneTypes[0] };
  }

  return { role };
}

function triangleCount(primitive) {
  const indices = primitive.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);
  const position = primitive.getAttribute('POSITION');
  return position ? Math.floor(position.getCount() / 3) : 0;
}

const decoder = await draco3d.createDecoderModule();
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': decoder });

let failed = false;

for (const relative of files) {
  const file = path.resolve(relative);
  if (!existsSync(file)) {
    console.error(`MISSING ${relative}`);
    failed = true;
    continue;
  }

  const document = await io.read(file);
  let triangles = 0;
  let metal = 0;
  let gemstone = 0;
  let unknown = 0;
  const semanticFailures = [];

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      triangles += triangleCount(primitive);
      const semantic = explicitMetadata(node, mesh, primitive.getMaterial());
      if (semantic.role === 'metal') metal += 1;
      else if (semantic.role === 'gemstone') gemstone += 1;
      else {
        unknown += 1;
        semanticFailures.push(`${node.getName() || '(unnamed)'}/${mesh.getName() || '(unnamed)'}#${primitiveIndex}: ${semantic.reason}`);
      }
    }
  }

  const bytes = statSync(file).size;
  const tier = tierOf(relative);
  const limit = MAX[tier];
  const semanticPass = metal > 0 && gemstone > 0 && unknown === 0;
  const budgetPass = bytes <= limit.bytes && triangles <= limit.triangles;

  console.log(`${relative}: ${(bytes / 1024).toFixed(0)} KiB, ${triangles.toLocaleString()} triangles, metal=${metal}, gemstone=${gemstone}, unknown=${unknown}`);

  if (!semanticPass) {
    console.error('  FAIL semantic contract: explicit extras are required on every production primitive.');
    semanticFailures.forEach((item) => console.error(`    - ${item}`));
    failed = true;
  }

  if (!budgetPass) {
    console.error(`  FAIL ${tier} budget: <= ${(limit.bytes / 1024).toFixed(0)} KiB and <= ${limit.triangles.toLocaleString()} triangles.`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Ring production asset audit passed.');
