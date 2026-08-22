import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { runtimeAssetContract } from './asset-config.mjs';

const dist = resolve(process.argv[2] ?? 'dist');
const root = process.cwd();
const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
const env = { ...loadEnv(mode, root, ''), ...process.env };
const manifest = JSON.parse(await readFile(resolve(dist, 'integrity-manifest.json'), 'utf8'));
if (manifest.version !== 1 || typeof manifest.buildId !== 'string' || typeof manifest.assets !== 'object') throw new Error('Invalid final integrity manifest schema.');
const requiredRuntimeAssets = runtimeAssetContract(env).required;
const manifestPaths = Object.keys(manifest.assets);
if (!manifestPaths.some((path) => /^assets\/mediapipe\.worker-[^/]+\.js$/.test(path))) {
  throw new Error('Final build has no compiled, integrity-covered MediaPipe worker.');
}
if (!manifestPaths.some((path) => /^wasm\/vision_wasm_.*\.js$/.test(path))) {
  throw new Error('Final build has no integrity-covered MediaPipe WASM loader JS.');
}
for (const relativePath of requiredRuntimeAssets) {
  const file = resolve(dist, relativePath);
  const details = await stat(file).catch(() => null);
  if (!details?.isFile() || details.size === 0) throw new Error(`Required final runtime asset is missing or empty: ${relativePath}`);
  if (!manifest.assets[relativePath]) throw new Error(`Required final runtime asset has no integrity entry: ${relativePath}`);
}
for (const [relativePath, expected] of Object.entries(manifest.assets)) {
  if (relativePath.startsWith('/') || relativePath.includes('..')) throw new Error(`Unsafe integrity path: ${relativePath}`);
  const file = resolve(dist, relativePath);
  const bytes = await readFile(file);
  const actual = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  if ((await stat(file)).size !== expected.size || actual !== expected.sha384) throw new Error(`Final artifact integrity mismatch: ${relativePath}`);
}
console.log(`Verified ${manifestPaths.length} final build artifacts, compiled MediaPipe worker, and ${requiredRuntimeAssets.length} required dist paths against SHA-384 manifest.`);
