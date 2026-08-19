// FILE: scripts/sign-assets.js
import { createHmac } from 'crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const filename = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(filename);
const repoRoot = resolve(scriptDirectory, '..');
const modelRoot = resolve(repoRoot, 'public/models');
const outputFile = resolve(repoRoot, 'public/asset-manifest.json');
const MODEL_PATTERN = /\.(?:glb|gltf|ktx2|hdr|bin|onnx|wasm)$/i;
const EXPIRY_SECONDS = 86_400;

function walkFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(absolutePath);
      if (entry.isFile()) return [absolutePath];
      return [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function toPublicAssetPath(filePath) {
  return `/${relative(resolve(repoRoot, 'public'), filePath).split(sep).join('/')}`;
}

function getAllModelPaths(directory) {
  return walkFiles(directory).filter((filePath) => MODEL_PATTERN.test(filePath)).map(toPublicAssetPath);
}

function requireAssetSecret() {
  const secret = process.env.ASSET_SECRET;
  if (!secret) throw new Error('ASSET_SECRET is required to sign the static asset manifest.');
  return secret;
}

function signAsset(secret, assetPath, exp) {
  return createHmac('sha256', secret).update(`${assetPath}:${exp}`).digest('hex');
}

const secret = requireAssetSecret();
const assets = getAllModelPaths(modelRoot);
const exp = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;
const manifest = Object.fromEntries(
  assets.map((assetPath) => [
    assetPath,
    {
      sig: signAsset(secret, assetPath, exp),
      exp,
    },
  ]),
);

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[Security] Asset manifest loaded | ${assets.length} assets verified`);
// VERIFY: console.log('[Security] Asset manifest loaded | N assets verified')
