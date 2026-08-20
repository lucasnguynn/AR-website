import { NodeIO } from '@gltf-transform/core';
import path from 'node:path';
import process from 'node:process';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error('Usage: node scripts/semanticize-ring-glb.mjs <input.glb> [output.glb]');
  process.exit(2);
}

const input = path.resolve(inputArg);
const output = outputArg ? path.resolve(outputArg) : undefined;
const document = await new NodeIO().read(input);
const root = document.getRoot();
const roles = new Set();

for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const primitive of mesh.listPrimitives()) {
    const material = primitive.getMaterial();
    const metadata = { ...material?.getExtras(), ...mesh.getExtras(), ...node.getExtras() };
    let role = typeof metadata.materialRole === 'string' ? metadata.materialRole.toLowerCase() : undefined;
    const gemstoneType = typeof metadata.gemstoneType === 'string' ? metadata.gemstoneType.toLowerCase() : undefined;
    const stableName = `${node.getName()} ${mesh.getName()} ${material?.getName() ?? ''}`;

    if (!role && gemstoneType) role = 'gemstone';
    if (!role && /(?:diamond|sapphire|ruby|emerald|amethyst|gem|stone|crystal)/i.test(stableName)) role = 'gemstone';
    if (!role && /(?:silver|gold|platinum|metal|band|shank|setting|ring)/i.test(stableName)) role = 'metal';
    if (!role && node.getName() === 'model' && mesh.getName() === 'model') role = 'metal';

    if (role === 'metal' || role === 'gemstone') {
      roles.add(role);
      if (output) {
        node.setExtras({ ...node.getExtras(), materialRole: role, ...(role === 'gemstone' ? { gemstoneType: gemstoneType ?? 'diamond' } : {}) });
      }
    }
  }
}

const missing = ['metal', 'gemstone'].filter((role) => !roles.has(role));
if (missing.length) {
  console.error(`GLB semantic gate failed: missing explicit ${missing.join(' and ')} mesh. Split the source geometry and name or annotate each node before release.`);
  process.exit(1);
}

if (output) await new NodeIO().write(output, document);
console.log(`GLB semantic gate passed: ${[...roles].sort().join(', ')}${output ? `; wrote ${output}` : ''}`);
