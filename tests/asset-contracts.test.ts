import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runAssetContractTests(): Promise<void> {
  const root = process.cwd();

  const [
    lod,
    semanticGate,
    audit,
    workflow,
    authoringGuide,
  ] = await Promise.all([
    readFile(join(root, 'scripts/generate-lod.js'), 'utf8'),
    readFile(join(root, 'scripts/semanticize-ring-glb.mjs'), 'utf8'),
    readFile(join(root, 'scripts/audit-ring-assets.mjs'), 'utf8'),
    readFile(join(root, '.github/workflows/asset-pipeline.yml'), 'utf8'),
    readFile(join(root, 'assets/models/raw/README.md'), 'utf8'),
  ]);

  // LOD targets retain measurable headroom below the hard release budgets.
  assert.match(lod, /maxTriangles:\s*44_000/);
  assert.match(lod, /maxTriangles:\s*19_000/);
  assert.match(lod, /maxTriangles:\s*7_500/);
  assert.match(lod, /never flatten\/join globally/i);

  // Production semantics are explicit metadata, never object-name inference.
  assert.match(semanticGate, /materialRole/);
  assert.match(semanticGate, /gemstoneType/);
  assert.match(semanticGate, /SUPPORTED_GEMSTONE_TYPES/);
  assert.doesNotMatch(
    semanticGate,
    /stableName|GEM_NAMES|METAL_NAMES|node\.getName\(\)\s*===\s*['"]model['"]/,
    'semantic release gate must not infer material roles from names',
  );

  // The production audit must work with no CLI args because package.json invokes
  // `node scripts/audit-ring-assets.mjs` directly.
  assert.match(audit, /public\/models\/nhan-high\.glb/);
  assert.match(audit, /public\/models\/nhan-medium\.glb/);
  assert.match(audit, /public\/models\/nhan-low\.glb/);
  assert.match(audit, /maxTriangles:\s*45_000/);
  assert.match(audit, /maxTriangles:\s*20_000/);
  assert.match(audit, /maxTriangles:\s*8_000/);
  assert.match(audit, /materialRole/);
  assert.match(audit, /gemstoneType/);

  // The generated-asset workflow must authenticate GitHub CLI before dispatch.
  assert.match(
    workflow,
    /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    'asset workflow must expose github.token to gh CLI',
  );
  assert.match(workflow, /npm run build:assets/);
  assert.match(workflow, /gh workflow run quality\.yml --ref main/);

  // Documentation points authors to the canonical non-public source location.
  assert.match(authoringGuide, /assets\/models\/raw\/nhan\.glb/);
}
