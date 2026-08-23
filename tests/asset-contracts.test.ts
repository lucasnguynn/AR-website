import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runAssetContractTests(): Promise<void> {
  const root = process.cwd();
  const [lod, semanticGate, audit, workflow, authoringGuide] = await Promise.all([
    readFile(join(root, 'scripts/generate-lod.js'), 'utf8'),
    readFile(join(root, 'scripts/semanticize-ring-glb.mjs'), 'utf8'),
    readFile(join(root, 'scripts/audit-ring-assets.mjs'), 'utf8'),
    readFile(join(root, '.github/workflows/asset-pipeline.yml'), 'utf8'),
    readFile(join(root, 'assets/models/raw/README.md'), 'utf8'),
  ]);

  assert.match(lod, /maxTriangles:\s*44_000/, 'HIGH LOD keeps headroom under the 45k release budget');
  assert.match(lod, /maxTriangles:\s*19_000/, 'MEDIUM LOD keeps headroom under the 20k release budget');
  assert.match(lod, /maxTriangles:\s*7_500/, 'LOW LOD keeps headroom under the 8k release budget');
  assert.match(lod, /never flatten\/join globally/i, 'LOD pipeline preserves semantic node boundaries');

  assert.match(semanticGate, /missing explicit extras\.materialRole/, 'source semantic gate requires explicit role metadata');
  assert.match(semanticGate, /gemstone primitive requires explicit extras\.gemstoneType/, 'gemstone source requires explicit gemstone type');
  assert.doesNotMatch(semanticGate, /stableName|GEM_NAMES|METAL_NAMES/, 'release semantic gate does not accept naming heuristics');

  assert.match(audit, /explicit extras are required on every production primitive/, 'generated LOD audit remains strict after compression');
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/, 'asset workflow authenticates GitHub CLI dispatch explicitly');
  assert.match(authoringGuide, /assets\/models\/raw\/nhan\.glb/, 'authoring contract points to the canonical source path');
}
