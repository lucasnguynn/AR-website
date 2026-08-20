import assert from 'node:assert/strict';
import * as THREE from 'three';
import { classifyRingMaterial, createRingMaterialStrategy } from '../src/materials/ringMaterialStrategy';

function mesh(name: string, material: THREE.Material): THREE.Mesh {
  const result = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  result.name = name;
  return result;
}

export function runMaterialStrategyTests(): void {
  const exportedMetal = new THREE.MeshStandardMaterial({ name: 'model', metalness: 0.05 });
  assert.deepEqual(classifyRingMaterial(mesh('model', exportedMetal), exportedMetal), {
    role: 'metal', source: 'name',
  });

  const explicitGem = new THREE.MeshStandardMaterial({ name: 'opaque-export-name' });
  explicitGem.userData = { materialRole: 'gemstone', gemstoneType: 'ruby' };
  assert.equal(classifyRingMaterial(mesh('Part_02', explicitGem), explicitGem).gemstone, 'ruby');

  const authoritativeMetal = new THREE.MeshStandardMaterial({ name: 'Diamond' });
  authoritativeMetal.userData = { materialRole: 'metal', gemstoneType: 'ruby' };
  assert.equal(classifyRingMaterial(mesh('Ruby', authoritativeMetal), authoritativeMetal).role, 'metal', 'materialRole has priority over gemstoneType and naming');

  const pbrMetal = new THREE.MeshStandardMaterial({ name: 'unlabeled', metalness: 0.8 });
  assert.equal(classifyRingMaterial(mesh('unlabeled', pbrMetal), pbrMetal).role, 'metal');
  const pbrAccent = new THREE.MeshStandardMaterial({ name: 'unlabeled', metalness: 0.1 });
  assert.equal(classifyRingMaterial(mesh('unlabeled', pbrAccent), pbrAccent).role, 'accent');

  const webgl = createRingMaterialStrategy('webgl', 'silver');
  const liveMetal = mesh('model', exportedMetal);
  liveMetal.material = webgl.materialFor(liveMetal, exportedMetal);
  assert.ok(liveMetal.material instanceof THREE.MeshPhysicalMaterial);
  assert.equal((liveMetal.material as THREE.Material).name, 'JewelryFactoryWebGL_silver');

  const beforePreset = liveMetal.material;
  webgl.setPreset('rose-gold');
  assert.equal(liveMetal.material, beforePreset, 'preset changes update the bound material in place');
  assert.equal((liveMetal.material as THREE.Material).name, 'JewelryFactoryWebGL_rose-gold');

  const gemSource = new THREE.MeshStandardMaterial({ name: 'Stone' });
  gemSource.userData = { materialRole: 'gemstone', gemstoneType: 'sapphire' };
  const gemMesh = mesh('CenterStone', gemSource);
  const gemFallback = webgl.materialFor(gemMesh, gemSource);
  assert.ok(gemFallback instanceof THREE.MeshPhysicalMaterial);
  assert.equal(gemFallback.name, 'GemstoneWebGL_sapphire_HIGH');

  const webgpu = createRingMaterialStrategy('webgpu', 'silver');
  const gpuMetal = webgpu.materialFor(mesh('model', exportedMetal), exportedMetal);
  assert.equal(gpuMetal.userData.jewelryMode, 'webgpu-tsl');
  const gpuGem = webgpu.materialFor(gemMesh, gemSource);
  assert.equal(gpuGem.userData.gemstoneType, 'sapphire');
  assert.deepEqual(gpuGem.userData.opticalTerms, ['cauchy-dispersion', 'beer-lambert-absorption', 'fresnel', 'total-internal-reflection', 'caustics']);
  assert.equal(gpuGem.userData.spectralSampleCount, 8);
  webgpu.setQuality('LOW');
  assert.equal((gemMesh.material as THREE.Material).userData.spectralSampleCount, 3);
  assert.equal((gemMesh.material as THREE.Material).userData.gemstoneUniforms.causticStrength.value, 0);

  let disposed = 0;
  (liveMetal.material as THREE.Material).addEventListener('dispose', () => { disposed += 1; });
  webgl.dispose();
  webgl.dispose();
  assert.equal(disposed, 1, 'owned materials dispose exactly once');
  webgpu.dispose();
}
