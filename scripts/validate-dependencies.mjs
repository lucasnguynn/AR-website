import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const lockedThree = lock.packages?.['node_modules/three']?.version;
const requiredRelease = 170;
const match = typeof lockedThree === 'string' ? /^0\.(\d+)\.(\d+)/.exec(lockedThree) : null;
const release = match ? Number(match[1]) : -1;
if (release < requiredRelease) {
  throw new Error(`Dependency lock is incompatible: Three.js ${lockedThree ?? 'missing'} cannot resolve three/webgpu or three/tsl; require r${requiredRelease}+ (${packageJson.dependencies.three}). Regenerate package-lock.json from an allowed registry.`);
}

for (const entryPoint of ['three', 'three/webgpu', 'three/tsl']) {
  try {
    import.meta.resolve(entryPoint);
  } catch (error) {
    throw new Error(`Dependency lock installed Three.js ${lockedThree}, but ${entryPoint} is not resolvable.`, { cause: error });
  }
}

if (lock.packages?.['node_modules/@svenflow/micro-handpose']) {
  throw new Error('Forbidden dependency @svenflow/micro-handpose remains in package-lock.json.');
}

console.log(`Dependency lock and installation resolve Three.js WebGPU/TSL entry points (${lockedThree}); forbidden handpose package absent.`);
