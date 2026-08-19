import * as THREE from 'three';
// Three's TSL examples package is JavaScript in this dependency version.
// @ts-ignore Missing bundled declarations for examples/jsm/nodes/Nodes.js.
import * as TSL from 'three/examples/jsm/nodes/Nodes.js';
import { createCausticTexture } from './causticTexture';
import type { GemstoneNodeMaterial, GemstonePresetName, GemstoneShaderOptions, GemstoneShaderUniforms } from '../types/gemstone.types';

const { ShaderNode: Fn, acos, asin, cameraPosition, clamp, dot, exp, float, max, mix, normalize, positionWorld, pow, reflect, refract: tslRefract, texture, timerGlobal, transformedNormalWorld, vec2, vec3 } = TSL as Record<string, any>;

const DIAMOND_CAUCHY_A = 2.3919;
const DIAMOND_CAUCHY_B = 0.01244;

const PRESETS: Record<GemstonePresetName, Required<Pick<GemstoneShaderOptions,
  'baseColor' | 'absorptionColor' | 'absorptionStrength' | 'pathLength' | 'causticStrength' | 'causticScale' | 'dispersionStrength' | 'facetStrength' | 'environmentIntensity'
>>> = {
  diamond: { baseColor: '#f7fbff', absorptionColor: '#e9f7ff', absorptionStrength: 0.06, pathLength: 0.88, causticStrength: 0.42, causticScale: 3.8, dispersionStrength: 1.0, facetStrength: 0.34, environmentIntensity: 1.0 },
  sapphire: { baseColor: '#244dff', absorptionColor: '#08218a', absorptionStrength: 0.72, pathLength: 1.15, causticStrength: 0.25, causticScale: 3.2, dispersionStrength: 0.46, facetStrength: 0.28, environmentIntensity: 0.9 },
  ruby: { baseColor: '#ff174d', absorptionColor: '#7a061a', absorptionStrength: 0.68, pathLength: 1.08, causticStrength: 0.24, causticScale: 3.1, dispersionStrength: 0.42, facetStrength: 0.27, environmentIntensity: 0.88 },
  emerald: { baseColor: '#00b86b', absorptionColor: '#043f2a', absorptionStrength: 0.62, pathLength: 1.12, causticStrength: 0.22, causticScale: 3.0, dispersionStrength: 0.38, facetStrength: 0.26, environmentIntensity: 0.86 },
};

function makeUniforms(options: GemstoneShaderOptions, presetName: GemstonePresetName): GemstoneShaderUniforms {
  const preset = PRESETS[presetName];
  const cauchy = options.cauchy ?? { a: DIAMOND_CAUCHY_A, b: DIAMOND_CAUCHY_B };
  return {
    baseColor: { value: new THREE.Color(options.baseColor ?? preset.baseColor) },
    absorptionColor: { value: new THREE.Color(options.absorptionColor ?? preset.absorptionColor) },
    absorptionStrength: { value: options.absorptionStrength ?? preset.absorptionStrength },
    pathLength: { value: options.pathLength ?? preset.pathLength },
    cauchyA: { value: cauchy.a },
    cauchyB: { value: cauchy.b },
    causticStrength: { value: options.causticStrength ?? preset.causticStrength },
    causticScale: { value: options.causticScale ?? preset.causticScale },
    dispersionStrength: { value: options.dispersionStrength ?? preset.dispersionStrength },
    facetStrength: { value: options.facetStrength ?? preset.facetStrength },
    environmentIntensity: { value: options.environmentIntensity ?? preset.environmentIntensity },
    time: { value: options.time ?? 0 },
  };
}

export function createGemstoneShader(options: GemstoneShaderOptions = {}): THREE.MeshPhysicalMaterial {
  const presetName = options.preset ?? 'diamond';
  const uniforms = makeUniforms(options, presetName);
  const causticTexture = options.causticTexture ?? createCausticTexture();

  const uBaseColor = vec3(uniforms.baseColor.value);
  const uAbsorptionColor = vec3(uniforms.absorptionColor.value);
  const uAbsorptionStrength = float(uniforms.absorptionStrength.value);
  const uPathLength = float(uniforms.pathLength.value);
  const uCauchyA = float(uniforms.cauchyA.value);
  const uCauchyB = float(uniforms.cauchyB.value);
  const uCausticStrength = float(uniforms.causticStrength.value);
  const uCausticScale = float(uniforms.causticScale.value);
  const uDispersionStrength = float(uniforms.dispersionStrength.value);
  const uFacetStrength = float(uniforms.facetStrength.value);
  const uEnvironmentIntensity = float(uniforms.environmentIntensity.value);
  const uTime = float(uniforms.time.value).add(timerGlobal().mul(0.12));

  const opticalFivePass = Fn(() => {
    const normal = normalize(transformedNormalWorld);
    const viewDir = normalize(positionWorld.sub(cameraPosition));

    const cauchyIndex = (lambdaMicrometers: number) => uCauchyA.add(uCauchyB.div(float(lambdaMicrometers * lambdaMicrometers)));
    const refracted = (lambdaMicrometers: number) => tslRefract(viewDir, normal, float(1).div(cauchyIndex(lambdaMicrometers)));

    const r0 = refracted(0.700).mul(vec3(0.7347, 0.2653, 0.0000));
    const r1 = refracted(0.620).mul(vec3(0.4498, 0.5520, 0.0000));
    const r2 = refracted(0.580).mul(vec3(0.3016, 0.6923, 0.0061));
    const r3 = refracted(0.540).mul(vec3(0.1636, 0.7823, 0.0541));
    const r4 = refracted(0.500).mul(vec3(0.0082, 0.5384, 0.4534));
    const r5 = refracted(0.470).mul(vec3(0.0139, 0.0971, 0.8890));
    const r6 = refracted(0.440).mul(vec3(0.1649, 0.0086, 0.8265));
    const r7 = refracted(0.410).mul(vec3(0.3285, 0.0010, 0.6705));

    const xyz = r0.add(r1).add(r2).add(r3).add(r4).add(r5).add(r6).add(r7).mul(0.125).abs();
    const srgb = vec3(
      xyz.x.mul(3.2406).sub(xyz.y.mul(1.5372)).sub(xyz.z.mul(0.4986)),
      xyz.x.mul(-0.9689).add(xyz.y.mul(1.8758)).add(xyz.z.mul(0.0415)),
      xyz.x.mul(0.0557).sub(xyz.y.mul(0.2040)).add(xyz.z.mul(1.0570)),
    );

    const absorption = exp(uAbsorptionColor.mul(uAbsorptionStrength).mul(uPathLength).negate());
    const nDiamond = cauchyIndex(0.589);
    const criticalAngle = asin(float(1).div(nDiamond));
    const incidence = acos(clamp(dot(viewDir.negate(), normal), 0, 1));
    const tirMask = max(float(0), incidence.sub(criticalAngle).mul(7));
    const bounceOne = reflect(viewDir, normal);
    const bounceTwo = reflect(bounceOne, normalize(normal.add(vec3(0.17, 0.29, 0.11))));
    const tirEnergy = bounceOne.abs().mul(0.42).add(bounceTwo.abs().mul(0.18)).mul(clamp(tirMask, 0, 1));

    const causticUv = vec2(positionWorld.x, positionWorld.z).mul(uCausticScale).add(vec2(uTime, uTime.mul(0.73)));
    const caustic = texture(causticTexture, causticUv).rgb.mul(uCausticStrength);
    const facetFire = pow(max(dot(normal, normalize(vec3(0.37, 0.71, 0.59))), 0), 18).mul(uFacetStrength);

    return mix(uBaseColor.mul(absorption), srgb.mul(absorption).add(tirEnergy).add(caustic), uDispersionStrength).add(facetFire).mul(uEnvironmentIntensity);
  });

  const material = new THREE.MeshPhysicalMaterial({
    name: 'GemstoneFivePassTSL_' + presetName,
    color: uniforms.baseColor.value,
    metalness: 0,
    roughness: 0.015,
    transmission: 1,
    thickness: uniforms.pathLength.value,
    ior: uniforms.cauchyA.value,
    envMapIntensity: uniforms.environmentIntensity.value,
    transparent: true,
    opacity: 0.78,
  }) as GemstoneNodeMaterial;

  material.colorNode = opticalFivePass();
  material.emissiveNode = texture(causticTexture, vec2(positionWorld.x, positionWorld.z).mul(uCausticScale).add(vec2(uTime))).rgb.mul(uCausticStrength).mul(0.18);
  material.roughnessNode = float(0.012);
  material.metalnessNode = float(0);
  material.userData.gemstoneUniforms = uniforms;
  material.userData.gemstoneCausticTexture = causticTexture;
  return material;
}

export function updateGemstoneTime(material: THREE.Material, time: number): void {
  const gemstoneMaterial = material as GemstoneNodeMaterial;
  if (gemstoneMaterial.userData.gemstoneUniforms) {
    gemstoneMaterial.userData.gemstoneUniforms.time.value = time;
  }
}
