import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const lockedRoot = lock.packages?.['']?.dependencies ?? {};

for (const [name, requested] of Object.entries(packageJson.dependencies ?? {})) {
  if (lockedRoot[name] !== requested) {
    throw new Error(`Dependency lock root disagrees for ${name}: package.json=${requested}; package-lock.json=${lockedRoot[name] ?? 'missing'}.`);
  }
  if (!lock.packages?.[`node_modules/${name}`]) {
    throw new Error(`Dependency lock has no resolved package entry for production dependency ${name}.`);
  }
}

for (const name of Object.keys(lockedRoot)) {
  if (!(name in (packageJson.dependencies ?? {}))) {
    throw new Error(`Dependency lock root contains undeclared production dependency ${name}.`);
  }
}

const lockedThree = lock.packages?.['node_modules/three']?.version;
const requiredRelease = 170;
const match = typeof lockedThree === 'string' ? /^0\.(\d+)\.(\d+)/.exec(lockedThree) : null;
const release = match ? Number(match[1]) : -1;
if (release < requiredRelease) {
  throw new Error(`Dependency lock is incompatible: Three.js ${lockedThree ?? 'missing'} cannot resolve three/webgpu or three/tsl; require r${requiredRelease}+ (${packageJson.dependencies.three}). Regenerate package-lock.json from an allowed registry.`);
}
console.log(`Dependency lock supports Three.js WebGPU/TSL entry points (${lockedThree}).`);
