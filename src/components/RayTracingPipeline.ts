import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export const RING_RAY_TRACING_LAYER = 7;
export const MIN_REFLECTION_BOUNCES = 2;
export const MIN_REFRACTION_BOUNCES = 4;

export type RayTracingPipelineOptions = {
  enabled?: boolean;
  ringRoot?: THREE.Object3D | null;
  backgroundBlurRadius?: number;
};

export type IrradianceVolume = {
  probeGridSize: THREE.Vector3;
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
  sphericalHarmonics: THREE.SphericalHarmonics3;
};

const WGSL_DOF_COMPUTE = /* wgsl */ `
@group(0) @binding(0) var sourceFrame: texture_2d<f32>;
@group(0) @binding(1) var outputFrame: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dimensions = textureDimensions(outputFrame);
  if (id.x >= dimensions.x || id.y >= dimensions.y) {
    return;
  }

  let uv = vec2<i32>(id.xy);
  var color = vec4<f32>(0.0);
  let radius = 3;
  var samples = 0.0;

  for (var y = -radius; y <= radius; y = y + 1) {
    for (var x = -radius; x <= radius; x = x + 1) {
      let coord = clamp(uv + vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(dimensions) - vec2<i32>(1));
      color = color + textureLoad(sourceFrame, coord, 0);
      samples = samples + 1.0;
    }
  }

  textureStore(outputFrame, uv, vec4<f32>(color.rgb / samples, 1.0));
}
`;

export class RayTracingPipelineController {
  readonly reflectionBounces = MIN_REFLECTION_BOUNCES;
  readonly refractionBounces = MIN_REFRACTION_BOUNCES;
  readonly targetLayer = RING_RAY_TRACING_LAYER;
  readonly computeShader = WGSL_DOF_COMPUTE;
  readonly irradianceVolume: IrradianceVolume;

  private targetObjects = new Set<THREE.Object3D>();

  constructor() {
    this.irradianceVolume = this.createNeutralStudioIrradianceVolume();
  }

  attachRingTarget(root: THREE.Object3D): void {
    root.traverse((object) => {
      object.layers.enable(this.targetLayer);
      this.targetObjects.add(object);

      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.applyJewelryRayTracingMaterial(mesh);
      }
    });
  }

  dispose(): void {
    this.targetObjects.forEach((object) => object.layers.disable(this.targetLayer));
    this.targetObjects.clear();
  }

  private applyJewelryRayTracingMaterial(mesh: THREE.Mesh): void {
    const applyMaterial = (material: THREE.Material) => {
      material.userData.rayTracing = {
        enabled: true,
        reflectionBounces: this.reflectionBounces,
        refractionBounces: this.refractionBounces,
        target: 'ring-only',
      };

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
    };

    if (Array.isArray(mesh.material)) mesh.material.forEach(applyMaterial);
    else if (mesh.material) applyMaterial(mesh.material);
  }

  private createNeutralStudioIrradianceVolume(): IrradianceVolume {
    const sphericalHarmonics = new THREE.SphericalHarmonics3();
    sphericalHarmonics.coefficients[0].set(0.78, 0.76, 0.72);
    sphericalHarmonics.coefficients[1].set(0.22, 0.21, 0.2);
    sphericalHarmonics.coefficients[2].set(0.08, 0.09, 0.1);
    sphericalHarmonics.coefficients[3].set(-0.04, -0.035, -0.03);
    sphericalHarmonics.coefficients[4].set(0.025, 0.022, 0.02);
    sphericalHarmonics.coefficients[5].set(-0.015, -0.014, -0.013);
    sphericalHarmonics.coefficients[6].set(0.06, 0.055, 0.05);
    sphericalHarmonics.coefficients[7].set(0.018, 0.017, 0.016);
    sphericalHarmonics.coefficients[8].set(0.035, 0.033, 0.03);

    return {
      probeGridSize: new THREE.Vector3(4, 3, 4),
      boundsMin: new THREE.Vector3(-1.5, -1.0, -1.5),
      boundsMax: new THREE.Vector3(1.5, 1.8, 1.5),
      sphericalHarmonics,
    };
  }
}

export function useRayTracingPipeline({ enabled = true, ringRoot }: RayTracingPipelineOptions) {
  const pipeline = useMemo(() => new RayTracingPipelineController(), []);

  useEffect(() => {
    if (!enabled || !ringRoot) return undefined;
    pipeline.attachRingTarget(ringRoot);
    return () => pipeline.dispose();
  }, [enabled, pipeline, ringRoot]);

  return pipeline;
}
