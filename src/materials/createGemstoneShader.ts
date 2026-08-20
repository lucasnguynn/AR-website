// FILE: src/materials/createGemstoneShader.ts
import * as THREE from 'three';
import {
  Fn,
  cameraPosition,
  dot,
  float,
  max,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  refract as tslRefract,
  step,
  texture,
  timerLocal,
  uniform,
  vec2,
  vec3,
  MeshPhysicalNodeMaterial,
} from 'three/tsl';
import { createCausticTexture } from './causticTexture';
import type { GemstoneNodeMaterial, GemstonePreset, GemstoneShaderOptions, GemstoneType } from '../types/gemstone.types';
import type { TSLNode } from 'three/tsl';
import type { GemstoneQuality } from './ringMaterialStrategy';

interface GemNode {
  readonly x: GemNode;
  readonly z: GemNode;
  readonly r: GemNode;
  add(value: unknown): GemNode;
  sub(value: unknown): GemNode;
  mul(value: unknown): GemNode;
  div(value: unknown): GemNode;
  negate(): GemNode;
  normalize(): GemNode;
  exp(): GemNode;
  sin(): GemNode;
  cos(): GemNode;
  asin(): GemNode;
}

function asGemNode(value: unknown): GemNode {
  return value as GemNode;
}

function asTslNode(value: unknown): TSLNode {
  return value as TSLNode;
}

/** Physically measured Cauchy and Beer-Lambert constants for supported gemstones. */
export const GEMS: Readonly<Record<GemstoneType, GemstonePreset>> = {
  diamond: { A: 2.3919, B: 0.01244, absorb: [0.001, 0.001, 0.001], caustic: 0.8, path: 0.003 },
  sapphire: { A: 1.7530, B: 0.00849, absorb: [0.32, 0.18, 0.01], caustic: 0.5, path: 0.005 },
  ruby: { A: 1.7531, B: 0.00854, absorb: [0.01, 0.40, 0.38], caustic: 0.5, path: 0.005 },
  emerald: { A: 1.5612, B: 0.00503, absorb: [0.28, 0.04, 0.30], caustic: 0.4, path: 0.006 },
  amethyst: { A: 1.5425, B: 0.00428, absorb: [0.10, 0.15, 0.01], caustic: 0.3, path: 0.006 },
};

const WAVELENGTHS = [0.38, 0.42, 0.47, 0.51, 0.55, 0.59, 0.63, 0.70] as const;
const CIE_RGB = [
  [0.06, 0.00, 0.32], [0.11, 0.01, 0.58], [0.18, 0.05, 0.92], [0.30, 0.25, 0.45],
  [0.37, 0.62, 0.12], [0.45, 0.79, 0.04], [0.53, 0.58, 0.01], [0.62, 0.35, 0.00],
] as const;

function envSample(direction: GemNode): GemNode {
  return direction.normalize().mul(0.5).add(asGemNode(vec3(0.5, 0.5, 0.5)));
}

function createGemstoneColorFn(sampleCount: number) { return Fn(([
  normalW,
  viewDir,
  worldPos,
  t,
  uA,
  uB,
  uAlpha,
  uPathLen,
  uCausticTex,
  uCausticScale,
  uCausticStrength,
]: readonly TSLNode[]) => {
  const normalNode = asGemNode(normalW);
  const viewNode = asGemNode(viewDir);
  const positionNode = asGemNode(worldPos);
  const timeNode = asGemNode(t);
  const cauchyANode = asGemNode(uA);
  const cauchyBNode = asGemNode(uB);
  const alphaNode = asGemNode(uAlpha);
  const pathNode = asGemNode(uPathLen);
  const causticTextureNode = asGemNode(uCausticTex);
  const causticScaleNode = asGemNode(uCausticScale);
  const causticStrengthNode = asGemNode(uCausticStrength);
  let acc = asGemNode(vec3(0, 0, 0));

  for (let i = 0; i < sampleCount; i += 1) {
    const lam = float(WAVELENGTHS[i]);
    const ior = cauchyANode.add(cauchyBNode.div(asGemNode(lam).mul(asGemNode(lam))));
    const refDir = asGemNode(tslRefract(asTslNode(viewNode.negate()), asTslNode(normalNode), asTslNode(asGemNode(float(1)).div(ior))));
    const spectralSample = envSample(refDir);
    const rgb = CIE_RGB[i];
    acc = acc.add(spectralSample.mul(asGemNode(vec3(rgb[0], rgb[1], rgb[2]))));
  }

  const transmitted = alphaNode.negate().mul(pathNode).exp();
  const absorbed = acc.div(float(sampleCount)).mul(transmitted);
  // Schlick Fresnel plus the internal critical-angle test. TIR forces reflection;
  // otherwise Fresnel continuously mixes the reflected and transmitted paths.
  const cosTheta = asGemNode(max(dot(asTslNode(viewNode), asTslNode(normalNode)), dot(asTslNode(viewNode.negate()), asTslNode(normalNode))));
  const oneMinusCos = asGemNode(float(1)).sub(cosTheta);
  const fresnelPower = oneMinusCos.mul(oneMinusCos).mul(oneMinusCos).mul(oneMinusCos).mul(oneMinusCos);
  const r0Base = cauchyANode.sub(float(1)).div(cauchyANode.add(float(1)));
  const r0 = r0Base.mul(r0Base);
  const fresnel = r0.add(asGemNode(float(1)).sub(r0).mul(fresnelPower));
  const sinThetaSquared = asGemNode(float(1)).sub(cosTheta.mul(cosTheta));
  const tirMask = asGemNode(step(float(1), cauchyANode.mul(cauchyANode).mul(sinThetaSquared)));
  const tirBounce = envSample(asGemNode(reflect(asTslNode(viewNode.negate()), asTslNode(normalNode))));
  const reflectionWeight = asGemNode(max(asTslNode(fresnel), asTslNode(tirMask)));
  const tirMixed = mix(absorbed, tirBounce, reflectionWeight);
  const causticOffset = timeNode.mul(0.5).sin().mul(0.02);
  const causticUV = asGemNode(vec2(positionNode.x, positionNode.z)).mul(causticScaleNode).add(asGemNode(vec2(causticOffset, causticOffset)));
  const caustic = asGemNode(texture(asTslNode(causticTextureNode), asTslNode(causticUV))).r.mul(causticStrengthNode);
  return asTslNode(asGemNode(tirMixed).add(asGemNode(vec3(caustic, caustic, caustic))));
}); }

/** Creates a rasterized TSL optical approximation with quality-scaled spectral samples and caustics. */
export function createGemstoneMaterial(type: GemstoneType, causticTex: THREE.Texture, quality: GemstoneQuality = 'HIGH'): GemstoneNodeMaterial {
  const g = GEMS[type];
  const uA = uniform(g.A);
  const uB = uniform(g.B);
  const uAlpha = uniform(vec3(g.absorb[0], g.absorb[1], g.absorb[2]));
  const uPathLen = uniform(g.path);
  const uCausticScale = uniform(2.0);
  const uCausticStrength = uniform(quality === 'LOW' ? 0 : g.caustic);
  const causticSampler = texture(causticTex);
  const sampleCount = quality === 'HIGH' ? 8 : quality === 'MEDIUM' ? 5 : 3;
  const gemstoneColorFn = createGemstoneColorFn(sampleCount);
  const mat = new MeshPhysicalNodeMaterial() as unknown as GemstoneNodeMaterial;

  mat.name = `GemstoneTSL_${type}_${quality}`;
  mat.metalness = 0;
  mat.roughness = 0.01;
  mat.transparent = true;
  mat.opacity = 0.82;
  mat.envMapIntensity = 1;
  Object.assign(mat, {
    transmissionNode: float(0.95),
    iorNode: uA,
    thicknessNode: float(0.5),
    colorNode: gemstoneColorFn(normalWorld, asTslNode(asGemNode(positionWorld).sub(asGemNode(cameraPosition)).normalize()), positionWorld, timerLocal(), uA, uB, uAlpha, uPathLen, causticSampler, uCausticScale, uCausticStrength),
    roughnessNode: float(0.008),
    metalnessNode: float(0),
  });
  mat.userData.gemstoneType = type;
  mat.userData.opticalTerms = ['cauchy-dispersion', 'beer-lambert-absorption', 'fresnel', 'total-internal-reflection', 'caustics'];
  mat.userData.spectralSampleCount = sampleCount;
  mat.userData.gemstoneCausticTexture = causticTex;
  mat.userData.gemstoneUniforms = {
    cauchyA: { value: g.A },
    cauchyB: { value: g.B },
    absorption: { value: new THREE.Vector3(g.absorb[0], g.absorb[1], g.absorb[2]) },
    pathLength: { value: g.path },
    causticScale: { value: 2.0 },
    causticStrength: uCausticStrength as unknown as { value: number },
    quality: { value: quality },
  };
  console.info(`[Gemstone] ${type} | IOR=${g.A.toFixed(3)} | ${sampleCount} spectral samples | caustics ${quality === 'LOW' ? 'OFF' : 'ON'}`);
  return mat;
}

/** WebGL approximation retaining transmission, IOR, absorption tint, and environment response. */
export function createGemstoneWebGLMaterial(type: GemstoneType, quality: GemstoneQuality = 'HIGH'): THREE.MeshPhysicalMaterial {
  const gem = GEMS[type];
  const color = new THREE.Color(1 - gem.absorb[0], 1 - gem.absorb[1], 1 - gem.absorb[2]);
  const material = new THREE.MeshPhysicalMaterial({
    name: `GemstoneWebGL_${type}_${quality}`,
    color,
    roughness: quality === 'LOW' ? 0.08 : 0.025,
    metalness: 0,
    transmission: quality === 'LOW' ? 0.75 : 0.92,
    ior: gem.A,
    thickness: gem.path * 100,
    attenuationColor: color,
    attenuationDistance: Math.max(gem.path * 30, 0.05),
    envMapIntensity: quality === 'HIGH' ? 1.6 : 1.25,
    transparent: true,
    opacity: 0.94,
  });
  material.userData.gemstoneType = type;
  material.userData.gemstoneQuality = quality;
  return material;
}

/** Backward-compatible factory that creates the requested gemstone shader with an optional generated caustic map. */
export function createGemstoneShader(options: GemstoneShaderOptions = {}): GemstoneNodeMaterial {
  return createGemstoneMaterial(options.preset ?? 'diamond', options.causticTexture ?? createCausticTexture());
}

/** Disables pass-5 caustics adaptively when the renderer exceeds the 33ms frame budget. */
export function updateGemstoneAdaptiveLod(material: THREE.Material, frameAvgMs: number): void {
  const gemstoneMaterial = material as GemstoneNodeMaterial;
  const uniforms = gemstoneMaterial.userData.gemstoneUniforms;
  if (uniforms !== undefined && frameAvgMs > 33) {
    uniforms.causticStrength.value = 0;
  }
}
