import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import draco3d from 'draco3dgltf';

const SUPPORTED_GEMSTONE_TYPES = new Set([
  'diamond',
  'sapphire',
  'ruby',
  'emerald',
  'amethyst',
]);

const DEFAULT_ASSETS = [
  {
    tier: 'HIGH',
    path: 'public/models/nhan-high.glb',
    maxTriangles: 45_000,
    maxBytes: 1_500_000,
  },
  {
    tier: 'MEDIUM',
    path: 'public/models/nhan-medium.glb',
    maxTriangles: 20_000,
    maxBytes: 900_000,
  },
  {
    tier: 'LOW',
    path: 'public/models/nhan-low.glb',
    maxTriangles: 8_000,
    maxBytes: 500_000,
  },
];

const EXPLICIT_CONTRACT =
  'explicit extras are required on every production primitive';

const decoder = await draco3d.createDecoderModule();
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': decoder });

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

function primitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);

  const position = primitive.getAttribute('POSITION');
  return position ? Math.floor(position.getCount() / 3) : 0;
}

function inferTierFromPath(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name.includes('-high.')) return 'HIGH';
  if (name.includes('-medium.')) return 'MEDIUM';
  if (name.includes('-low.')) return 'LOW';
  return undefined;
}

function configuredAssets() {
  const args = process.argv.slice(2);

  if (args.length === 0) return DEFAULT_ASSETS;

  return args.map((input) => {
    const tier = inferTierFromPath(input);
    const budget = DEFAULT_ASSETS.find((entry) => entry.tier === tier);

    if (!budget) {
      throw new Error(
        `Cannot infer HIGH/MEDIUM/LOW release budget from custom asset path: ${input}`,
      );
    }

    return {
      ...budget,
      path: input,
    };
  });
}

async function auditAsset(spec) {
  const absolutePath = path.resolve(spec.path);

  if (!existsSync(absolutePath)) {
    throw new Error(`${spec.tier}: missing production asset ${spec.path}.`);
  }

  const bytes = statSync(absolutePath).size;
  if (bytes <= 0) {
    throw new Error(`${spec.tier}: production asset is empty: ${spec.path}.`);
  }

  const document = await io.read(absolutePath);
  const root = document.getRoot();

  let triangles = 0;
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
      triangles += primitiveTriangles(primitive);

      const material = primitive.getMaterial();
      const label = [
        `${spec.tier}`,
        `node="${node.getName() || '(unnamed)'}"`,
        `mesh="${mesh.getName() || '(unnamed)'}"`,
        `primitive=${primitiveIndex}`,
      ].join(' ');

      try {
        const role = oneExplicitValue(
          'materialRole',
          node,
          mesh,
          material,
          label,
        );

        if (role !== 'metal' && role !== 'gemstone') {
          failures.push(
            `${label}: ${EXPLICIT_CONTRACT}; `
            + 'expected extras.materialRole="metal" or "gemstone".',
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
    failures.push(`${spec.tier}: asset contains no mesh primitives.`);
  }

  if (metalCount === 0) {
    failures.push(
      `${spec.tier}: production asset requires at least one explicit metal primitive.`,
    );
  }

  if (gemstoneCount === 0) {
    failures.push(
      `${spec.tier}: production asset requires at least one explicit gemstone primitive.`,
    );
  }

  if (triangles > spec.maxTriangles) {
    failures.push(
      `${spec.tier}: triangle budget exceeded: `
      + `${triangles.toLocaleString()} > ${spec.maxTriangles.toLocaleString()}.`,
    );
  }

  if (bytes > spec.maxBytes) {
    failures.push(
      `${spec.tier}: file-size budget exceeded: `
      + `${bytes.toLocaleString()} > ${spec.maxBytes.toLocaleString()} bytes.`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Production ring asset audit failed for ${spec.path}:\n`
      + failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }

  console.log(
    `${spec.tier} PASS: ${spec.path} | `
    + `${triangles.toLocaleString()} triangles | `
    + `${bytes.toLocaleString()} bytes | `
    + `metal=${metalCount} gemstone=${gemstoneCount} | `
    + `gemstoneTypes=${[...gemstoneTypes].sort().join(',')}`,
  );
}

const assets = configuredAssets();
const failures = [];

for (const asset of assets) {
  try {
    await auditAsset(asset);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

if (failures.length > 0) {
  console.error('\nProduction ring asset release gate FAILED.');
  failures.forEach((failure) => console.error(failure));
  process.exit(1);
}

console.log(
  `Production ring asset release gate PASSED (${assets.length} tier${assets.length === 1 ? '' : 's'}).`,
);
