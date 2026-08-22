import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { runtimeAssetContract, viteBase } from './asset-config.mjs';

function projectEnv(root, processEnv) {
  const mode = processEnv.NODE_ENV === 'development' ? 'development' : 'production';
  return { ...loadEnv(mode, root, ''), ...processEnv };
}

export function validateAssets({ root = process.cwd(), env = process.env } = {}) {
  const mergedEnv = projectEnv(root, env);
  const contract = runtimeAssetContract(mergedEnv);
  const required = contract.required;
  const optional = contract.optional;

  const missing = required.filter((path) => {
    const file = resolve(root, 'public', path);
    return !existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0;
  });

  const wasmDir = resolve(root, 'public', 'wasm');
  const wasmFiles = existsSync(wasmDir) ? readdirSync(wasmDir) : [];
  if (!wasmFiles.some((name) => /^vision_wasm_.*\.js$/.test(name))) missing.push('wasm/vision_wasm_*.js');
  if (!wasmFiles.some((name) => /^vision_wasm_.*\.wasm$/.test(name))) missing.push('wasm/vision_wasm_*.wasm');

  if (missing.length) {
    throw new Error(`Required asset preflight failed (Vite base ${viteBase(mergedEnv.GITHUB_REPOSITORY)}):\n${missing.map((path) => ` - public/${path}`).join('\n')}`);
  }
  return { required, optional, base: viteBase(mergedEnv.GITHUB_REPOSITORY) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    const result = validateAssets();
    console.log(`Asset preflight passed: ${result.required.length} required; ${result.optional.length} explicitly optional; base=${result.base}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
