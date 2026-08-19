// FILE: scripts/check-bundle-size.js
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const distAssetsDirectory = resolve(scriptDirectory, '..', 'dist', 'assets');
const budget = JSON.parse(readFileSync(resolve(scriptDirectory, 'bundle-budget.json'), 'utf8'));
const maxChunkBytes = budget.maxChunkGzipKiB * 1024;
const maxTotalBytes = budget.maxTotalJsGzipKiB * 1024;

if (!existsSync(distAssetsDirectory) || !statSync(distAssetsDirectory).isDirectory()) {
  throw new Error(`Missing Vite assets directory: ${distAssetsDirectory}`);
}

const javaScriptFiles = readdirSync(distAssetsDirectory)
  .filter((fileName) => fileName.endsWith('.js'))
  .sort((left, right) => left.localeCompare(right));

let totalBytes = 0;
let failed = false;
const categories = new Map(Object.keys(budget.categories).map((key) => [key, 0]));

for (const fileName of javaScriptFiles) {
  const buffer = readFileSync(join(distAssetsDirectory, fileName));
  const gzippedBytes = gzipSync(buffer).length;
  totalBytes += gzippedBytes;
  for (const [category, rule] of Object.entries(budget.categories)) {
    if (new RegExp(rule.pattern, 'i').test(fileName)) categories.set(category, (categories.get(category) ?? 0) + gzippedBytes);
  }

  if (gzippedBytes > maxChunkBytes) {
    console.error(`ERROR ${fileName}: ${(gzippedBytes / 1024).toFixed(0)}KiB gzipped (chunk limit ${budget.maxChunkGzipKiB}KiB)`);
    failed = true;
  } else {
    console.log(`✓ ${fileName}: ${(gzippedBytes / 1024).toFixed(0)}KB`);
  }
}

for (const [category, bytes] of categories) {
  const limit = budget.categories[category].maxGzipKiB * 1024;
  console.log(`${category}: ${(bytes / 1024).toFixed(0)}KiB gzip (limit ${budget.categories[category].maxGzipKiB}KiB)`);
  if (bytes > limit) { console.error(`ERROR ${category} bundle budget exceeded`); failed = true; }
}
console.log(`Total JS: ${(totalBytes / 1024).toFixed(0)}KiB gzip (limit ${budget.maxTotalJsGzipKiB}KiB)`);

if (totalBytes > maxTotalBytes) {
  console.error('ERROR total JavaScript bundle budget exceeded');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('✅ Bundle size check PASSED');
// VERIFY: console.log('✅ Bundle size check PASSED')
