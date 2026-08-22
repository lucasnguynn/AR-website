const BASE_REQUIRED_PUBLIC_ASSETS = [
  'models/hand_landmarker.task',
  'models/nhan.usdz',
  'models/nhan-preview.png',
];

const RING_MODEL_ENV = [
  ['VITE_RING_MODEL_HIGH', 'models/nhan.glb'],
  ['VITE_RING_MODEL_MEDIUM', 'models/nhan.glb'],
  ['VITE_RING_MODEL_LOW', 'models/nhan.glb'],
];

export const OPTIONAL_PUBLIC_ASSETS = [
  { path: 'models/depth/depth_anything_v2_small.onnx', envPath: 'VITE_DEPTH_MODEL', enabledBy: 'VITE_ENABLE_MONOCULAR_DEPTH' },
];

function cleanPublicPath(value, fallback) {
  const source = String(value || fallback || '').trim();
  if (!source) throw new Error('Runtime asset path cannot be empty.');
  if (/^(?:https?:)?\/\//i.test(source)) {
    throw new Error(`External runtime asset URL is not allowed by the current same-origin release contract: ${source}`);
  }
  return source.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Resolve the exact public files referenced by the production runtime.
 * This mirrors src/config/arRuntimeConfig.ts so CI validates what Vite will ship.
 */
export function runtimeAssetContract(env = process.env) {
  const required = [...BASE_REQUIRED_PUBLIC_ASSETS];

  for (const [key, fallback] of RING_MODEL_ENV) {
    required.push(cleanPublicPath(env[key], fallback));
  }

  if (env.VITE_RING_USDZ) {
    const index = required.indexOf('models/nhan.usdz');
    if (index >= 0) required.splice(index, 1);
    required.push(cleanPublicPath(env.VITE_RING_USDZ));
  }
  if (env.VITE_RING_PREVIEW) {
    const index = required.indexOf('models/nhan-preview.png');
    if (index >= 0) required.splice(index, 1);
    required.push(cleanPublicPath(env.VITE_RING_PREVIEW));
  }

  // MediaPipe loader has multiple generated filenames; fixed WASM is still a useful hard gate.
  required.push('wasm/vision_wasm_internal.wasm');

  const optional = [];
  for (const asset of OPTIONAL_PUBLIC_ASSETS) {
    const path = cleanPublicPath(env[asset.envPath], asset.path);
    if (env[asset.enabledBy] === 'true') required.push(path);
    else optional.push(`${path} (${asset.enabledBy} is disabled)`);
  }

  return {
    required: [...new Set(required)],
    optional,
  };
}

// Backward-compatible export for scripts importing a static list.
export const REQUIRED_PUBLIC_ASSETS = runtimeAssetContract({}).required;

export function viteBase(repository = process.env.GITHUB_REPOSITORY ?? '') {
  const name = repository.split('/')[1] ?? '';
  return name ? `/${name}/` : '/';
}
