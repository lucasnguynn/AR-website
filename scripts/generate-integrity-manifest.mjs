import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const output = join(dist, 'integrity-manifest.json');
const eligible = /(?:worker[^/]*\.(?:js|mjs)|\.(?:task|wasm|glb|gltf|bin|onnx|usdz|png|jpe?g))$/i;
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]); }
if (!existsSync(dist)) throw new Error(`Build output does not exist: ${dist}`);
const assets = Object.fromEntries(walk(dist).filter((file) => eligible.test(relative(dist, file).split(sep).join('/'))).sort().map((file) => {
  const bytes = readFileSync(file);
  return [relative(dist, file).split(sep).join('/'), { sha384: `sha384-${createHash('sha384').update(bytes).digest('base64')}`, size: statSync(file).size }];
}));
const canonical = JSON.stringify(assets);
const manifest = { version: 1, buildId: createHash('sha256').update(canonical).digest('hex').slice(0, 20), assets };
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Integrity manifest written for ${Object.keys(assets).length} final artifacts (${manifest.buildId}).`);
