// FILE: scripts/check-bundle-size.js
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const distAssetsDirectory = resolve(scriptDirectory, '..', 'dist', 'assets');
const maxChunkBytes = 500_000;
const maxTotalBytes = 4_000_000;

if (!existsSync(distAssetsDirectory) || !statSync(distAssetsDirectory).isDirectory()) {
  throw new Error(`Missing Vite assets directory: ${distAssetsDirectory}`);
}

const javaScriptFiles = readdirSync(distAssetsDirectory)
  .filter((fileName) => fileName.endsWith('.js'))
  .sort((left, right) => left.localeCompare(right));

let totalBytes = 0;
let failed = false;

for (const fileName of javaScriptFiles) {
  const buffer = readFileSync(join(distAssetsDirectory, fileName));
  const gzippedBytes = gzipSync(buffer).length;
  totalBytes += gzippedBytes;

  if (gzippedBytes > maxChunkBytes) {
    console.error(`❌ ${fileName}: ${(gzippedBytes / 1024).toFixed(0)}KB gzipped (limit 500KB)`);
    failed = true;
  } else {
    console.log(`✓ ${fileName}: ${(gzippedBytes / 1024).toFixed(0)}KB`);
  }
}

console.log(`Total: ${(totalBytes / 1024).toFixed(0)}KB gzipped (limit 4MB)`);

if (totalBytes > maxTotalBytes) {
  console.error('❌ Total bundle exceeds 4MB');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('✅ Bundle size check PASSED');
// VERIFY: console.log('✅ Bundle size check PASSED')
