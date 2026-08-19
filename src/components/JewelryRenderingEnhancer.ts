import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export type JewelryRenderingEnhancerOptions = {
  enabled?: boolean;
  ringRoot?: THREE.Object3D | null;
};

/**
 * Applies raster/PBR quality settings to the active ring materials. This is
 * deliberately not described as ray tracing: Three.js renders these settings
 * through its supported WebGPU/WebGL material pipelines.
 */
export class JewelryRenderingEnhancer {
  private targetObjects = new Set<THREE.Object3D>();

  attach(root: THREE.Object3D): void {
    root.traverse((object) => {
      this.targetObjects.add(object);
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
          material.envMapIntensity = Math.max(material.envMapIntensity, 1.35);
          material.needsUpdate = true;
        }
        if (material instanceof THREE.MeshPhysicalMaterial) {
          material.transmission = Math.max(material.transmission, 0.6);
          material.thickness = Math.max(material.thickness, 0.08);
          material.ior = Math.max(material.ior, 2.35);
          material.attenuationDistance = Math.min(material.attenuationDistance, 0.45);
        }
      }
    });
  }

  dispose(): void {
    this.targetObjects.clear();
  }
}

export function useJewelryRenderingEnhancer({ enabled = true, ringRoot }: JewelryRenderingEnhancerOptions): JewelryRenderingEnhancer {
  const enhancer = useMemo(() => new JewelryRenderingEnhancer(), []);
  useEffect(() => {
    if (!enabled || !ringRoot) return undefined;
    enhancer.attach(ringRoot);
    return () => enhancer.dispose();
  }, [enabled, enhancer, ringRoot]);
  return enhancer;
}
