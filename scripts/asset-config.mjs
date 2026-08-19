export const REQUIRED_PUBLIC_ASSETS = [
  'models/hand_landmarker.task',
  'wasm/vision_wasm_internal.wasm',
  'models/nhan.glb',
  'models/nhan.usdz',
  'models/nhan-preview.png',
];

export const OPTIONAL_PUBLIC_ASSETS = [
  { path: 'models/depth/depth_anything_v2_small.onnx', enabledBy: 'VITE_ENABLE_MONOCULAR_DEPTH' },
];

export function viteBase(repository = process.env.GITHUB_REPOSITORY ?? '') {
  const name = repository.split('/')[1] ?? '';
  return name ? `/${name}/` : '/';
}
