import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPTIONAL_PUBLIC_ASSETS, REQUIRED_PUBLIC_ASSETS, viteBase } from './asset-config.mjs';

export function validateAssets({ root = process.cwd(), env = process.env } = {}) {
  const required = [...REQUIRED_PUBLIC_ASSETS];
  const optional = [];
  for (const asset of OPTIONAL_PUBLIC_ASSETS) {
    if (env[asset.enabledBy] === 'true') required.push(asset.path);
    else optional.push(`${asset.path} (${asset.enabledBy} is disabled)`);
  }
  const missing = required.filter((path) => {
    const file = resolve(root, 'public', path);
    return !existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0;
  });
  if (missing.length) throw new Error(`Required asset preflight failed (Vite base ${viteBase(env.GITHUB_REPOSITORY)}):\n${missing.map((path) => ` - public/${path}`).join('\n')}`);
  return { required, optional, base: viteBase(env.GITHUB_REPOSITORY) };
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
