import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const source = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const destination = resolve('public/wasm');

let entries;
try {
  entries = await readdir(source, { withFileTypes: true });
} catch {
  throw new Error('MediaPipe WASM source is missing. Run npm ci before dev/build.');
}

const runtimeFiles = entries
  .filter((entry) => entry.isFile() && /^vision_wasm_.*\.(?:js|wasm)$/.test(entry.name))
  .map((entry) => entry.name);

if (!runtimeFiles.some((name) => name.endsWith('.js')) || !runtimeFiles.some((name) => name.endsWith('.wasm'))) {
  throw new Error('MediaPipe package does not contain the expected JS/WASM runtime files.');
}

await mkdir(destination, { recursive: true });
for (const name of (await readdir(destination)).filter((name) => /^vision_wasm_.*\.(?:js|wasm)$/.test(name))) {
  await rm(join(destination, name), { force: true });
}
for (const name of runtimeFiles) await cp(join(source, name), join(destination, name));
console.log(`Synced ${runtimeFiles.length} MediaPipe runtime files to public/wasm from the pinned npm package.`);
