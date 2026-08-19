import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'integrity-manifest.json'), 'utf8'));
if (manifest.version !== 1 || typeof manifest.buildId !== 'string' || typeof manifest.assets !== 'object') throw new Error('Invalid final integrity manifest schema.');
for (const [relativePath, expected] of Object.entries(manifest.assets)) {
  if (relativePath.startsWith('/') || relativePath.includes('..')) throw new Error(`Unsafe integrity path: ${relativePath}`);
  const file = resolve(dist, relativePath);
  const bytes = await readFile(file);
  const actual = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  if ((await stat(file)).size !== expected.size || actual !== expected.sha384) throw new Error(`Final artifact integrity mismatch: ${relativePath}`);
}
console.log(`Verified ${Object.keys(manifest.assets).length} final build artifacts against SHA-384 manifest.`);
