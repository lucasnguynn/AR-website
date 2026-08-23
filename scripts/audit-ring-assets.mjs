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

const SUPPORTED_GEMSTONE_TYPES = new Set(['diamond', 'sapphire', 'ruby', 'emerald', 'amethyst']);
const input = path.resolve(inputArg);
const output = outputArg ? path.resolve(outputArg) : undefined;

const decoder = await draco3d.createDecoderModule();
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': decoder });

const document = await io.read(input);
const root = document.getRoot();

function text(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function valuesFor(key, node, mesh, material) {
  return [
    text(node.getExtras()?.[key]),
    text(mesh.getExtras()?.[key]),
    text(material?.getExtras()?.[key]),
  ].filter(Boolean);
}

function oneExplicitValue(key, node, mesh, material, label) {
  const values = [...new Set(valuesFor(key, node, mesh, material))];
  if (values.length === 0) return undefined;
  if (values.length > 1) {
    throw new Error(`${label}: conflicting explicit ${key} values: ${values.join(', ')}`);
  }
  return values[0];
}

let metal = 0;
let gemstone = 0;
let primitiveCount = 0;
const failures = [];

for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;

  for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
    primitiveCount += 1;
    const material = primitive.getMaterial();
    const label = `node="${node.getName() || '(unnamed)'}" mesh="${mesh.getName() || '(unnamed)'}" primitive=${primitiveIndex}`;

    try {
      const role = oneExplicitValue('materialRole', node, mesh, material, label);
      if (role !== 'metal' && role !== 'gemstone') {
        failures.push(`${label}: missing explicit extras.materialRole="metal" or "gemstone".`);
        continue;
      }

      if (role === 'metal') {
        metal += 1;
      } else {
        const gemstoneType = oneExplicitValue('gemstoneType', node, mesh, material, label);
        if (!gemstoneType) {
          failures.push(`${label}: gemstone primitive requires explicit extras.gemstoneType.`);
          continue;
        }
        if (!SUPPORTED_GEMSTONE_TYPES.has(gemstoneType)) {
          failures.push(`${label}: unsupported gemstoneType="${gemstoneType}". Supported: ${[...SUPPORTED_GEMSTONE_TYPES].join(', ')}.`);
          continue;
        }
        gemstone += 1;
      }

      if (output && material) {
        const gemstoneType = role === 'gemstone'
          ? oneExplicitValue('gemstoneType', node, mesh, material, label)
          : undefined;
        material.setExtras({
          ...material.getExtras(),
          materialRole: role,
          ...(gemstoneType ? { gemstoneType } : {}),
        });
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}

if (primitiveCount === 0) failures.push('GLB contains no mesh primitives.');
if (metal === 0) failures.push('GLB semantic gate requires at least one explicit metal primitive.');
if (gemstone === 0) failures.push('GLB semantic gate requires at least one explicit gemstone primitive.');

if (failures.length > 0) {
  console.error('GLB semantic gate failed:');
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error('Do not rely on object/material names for production. Export Blender/CAD custom properties as glTF extras.');
  process.exit(1);
}

if (output) await io.write(output, document);
console.log(`GLB semantic gate passed: primitives=${primitiveCount}, metal=${metal}, gemstone=${gemstone}${output ? `; wrote ${output}` : ''}`);
