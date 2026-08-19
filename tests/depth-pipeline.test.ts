import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WebXRDepthManager } from '../src/services/WebXRDepthManager';
import { inferenceFrameSize } from '../src/utils/coordinateMapping';
import { validateAssets } from '../scripts/validate-assets.mjs';

export async function runDepthPipelineTests(): Promise<void> {
  const manager = new WebXRDepthManager();
  assert.equal(manager.getTier(), 'geometric-proxy', 'missing depth starts with the safe geometric fallback');
  const geometry = manager.geometricProxy.geometry;
  manager.updateGeometricProxy([{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }]);
  manager.updateGeometricProxy([{ x: 0, y: 0 }, { x: 0.7, y: 0.3 }]);
  assert.equal(manager.geometricProxy.geometry, geometry, 'tracking updates reuse geometric GPU resources');
  manager.update({});
  assert.equal(manager.getTier(), 'geometric-proxy', 'an absent camera/model remains usable');
  manager.dispose();
  assert.equal((geometry as THREE.BufferGeometry).attributes.position.count > 0, true, 'owned geometry existed before deterministic disposal');

  assert.deepEqual(inferenceFrameSize(1920, 1080), { width: 384, height: 216 }, 'camera preprocessing preserves aspect ratio and caps readback');
  assert.deepEqual(inferenceFrameSize(320, 240), { width: 320, height: 240 }, 'small camera frames are not enlarged');

  const assets = validateAssets({ root: process.cwd(), env: {} });
  assert.equal(assets.optional.some((entry: string) => entry.includes('depth_anything_v2_small.onnx')), true, 'missing ONNX remains explicit and optional when the feature flag is disabled');
  assert.throws(() => validateAssets({ root: process.cwd(), env: { VITE_ENABLE_MONOCULAR_DEPTH: 'true' } }), /depth_anything_v2_small\.onnx/, 'enabling monocular depth fails closed when its validated model is absent');
}
