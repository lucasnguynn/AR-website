import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import path from 'node:path';
import process from 'node:process';
import draco3d from 'draco3dgltf';

const [, , inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error('Usage: node scripts/semanticize-ring-glb.mjs <input.glb> [output.glb]');
  process.exit(2);
}

const SUPPORTED_GEMSTONE_TYPES = new Set([
  'diamond',
  'sapphire',
  'ruby',
  'emerald',
  'amethyst',
]);

const input = path.resolve(inputArg);
const output = outputArg ? path.resolve(outputArg) : undefined;

const decoder = await draco3d.createDecoderModule();
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': decoder });

const document = await io.read(input);
const root = document.getRoot();

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function explicitValues(key, node, mesh, material) {
  return [
    normalizeText(node.getExtras()?.[key]),
    normalizeText(mesh.getExtras()?.[key]),
    normalizeText(material?.getExtras()?.[key]),
  ].filter(Boolean);
}

function oneExplicitValue(key, node, mesh, material, label) {
  const values = [...new Set(explicitValues(key, node, mesh, material))];

  if (values.length === 0) return undefined;

  if (values.length > 1) {
    throw new Error(
      `${label}: conflicting explicit extras.${key} values: ${values.join(', ')}.`,
    );
  }

  return values[0];
}

let primitiveCount = 0;
let metalCount = 0;
let gemstoneCount = 0;
const gemstoneTypes = new Set();
const failures = [];

for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;

  for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
    primitiveCount += 1;

    const material = primitive.getMaterial();
    const label = [
      `node="${node.getName() || '(unnamed)'}"`,
      `mesh="${mesh.getName() || '(unnamed)'}"`,
      `primitive=${primitiveIndex}`,
    ].join(' ');

    try {
      const role = oneExplicitValue('materialRole', node, mesh, material, label);

      if (!role) {
        failures.push(
          `${label}: missing explicit extras.materialRole="metal" or "gemstone".`,
        );
        continue;
      }

      if (role !== 'metal' && role !== 'gemstone') {
        failures.push(
          `${label}: unsupported extras.materialRole="${role}". `
          + 'Expected "metal" or "gemstone".',
        );
        continue;
      }

      if (role === 'metal') {
        metalCount += 1;
        continue;
      }

      const gemstoneType = oneExplicitValue(
        'gemstoneType',
        node,
        mesh,
        material,
        label,
      );

      if (!gemstoneType) {
        failures.push(
          `${label}: gemstone primitive requires explicit extras.gemstoneType.`,
        );
        continue;
      }

      if (!SUPPORTED_GEMSTONE_TYPES.has(gemstoneType)) {
        failures.push(
          `${label}: unsupported extras.gemstoneType="${gemstoneType}". `
          + `Supported: ${[...SUPPORTED_GEMSTONE_TYPES].join(', ')}.`,
        );
        continue;
      }

      gemstoneCount += 1;
      gemstoneTypes.add(gemstoneType);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}

if (primitiveCount === 0) {
  failures.push('GLB contains no mesh primitives.');
}

if (metalCount === 0) {
  failures.push(
    'GLB semantic gate requires at least one primitive with explicit extras.materialRole="metal".',
  );
}

if (gemstoneCount === 0) {
  failures.push(
    'GLB semantic gate requires at least one primitive with explicit extras.materialRole="gemstone".',
  );
}

if (failures.length > 0) {
  console.error('GLB semantic gate failed:');
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(
    'Production semantics are explicit-only. '
    + 'Object/material names are never used as a release fallback.',
  );
  process.exit(1);
}

if (output) {
  // Validation is intentionally non-destructive. The source authoring file must
  // already contain explicit semantics; this gate never invents them from names.
  await io.write(output, document);
}

console.log(
  'GLB semantic gate passed: '
  + `primitives=${primitiveCount}, `
  + `metal=${metalCount}, `
  + `gemstone=${gemstoneCount}, `
  + `gemstoneTypes=${[...gemstoneTypes].sort().join(',') || 'none'}`
  + (output ? `; wrote ${output}` : ''),
);
