import * as THREE from 'three';

export type JewelryMaterialType = 'gold-18k' | 'white-gold' | 'rose-gold' | 'silver' | 'diamond-accent';

export interface JewelryShaderOptions {
  type?: JewelryMaterialType;
  color?: THREE.ColorRepresentation;
  metalColor?: THREE.ColorRepresentation;
  clearCoatColor?: THREE.ColorRepresentation;
  anisotropy?: number;
  roughness?: number;
  clearCoatStrength?: number;
  facetScale?: number;
  envMap?: THREE.Texture | null;
  environmentIntensity?: number;
  exposure?: number;
}

type JewelryPreset = Required<Pick<JewelryShaderOptions,
  'color' | 'metalColor' | 'clearCoatColor' | 'anisotropy' | 'roughness' | 'clearCoatStrength' | 'facetScale' | 'environmentIntensity' | 'exposure'
>>;

const PRESETS: Record<JewelryMaterialType, JewelryPreset> = {
  'gold-18k': {
    color: '#f4c56a',
    metalColor: '#ffe6a1',
    clearCoatColor: '#fff8da',
    anisotropy: 0.74,
    roughness: 0.15,
    clearCoatStrength: 0.86,
    facetScale: 176,
    environmentIntensity: 0.88,
    exposure: 1.0,
  },
  'white-gold': {
    color: '#d8d6cf',
    metalColor: '#f8f6ed',
    clearCoatColor: '#ffffff',
    anisotropy: 0.68,
    roughness: 0.13,
    clearCoatStrength: 0.9,
    facetScale: 212,
    environmentIntensity: 0.92,
    exposure: 1.04,
  },
  'rose-gold': {
    color: '#e3a184',
    metalColor: '#ffd0ba',
    clearCoatColor: '#fff1e9',
    anisotropy: 0.7,
    roughness: 0.17,
    clearCoatStrength: 0.84,
    facetScale: 168,
    environmentIntensity: 0.82,
    exposure: 1.0,
  },
  silver: {
    color: '#c8cbd0',
    metalColor: '#f2f7ff',
    clearCoatColor: '#ffffff',
    anisotropy: 0.62,
    roughness: 0.11,
    clearCoatStrength: 0.88,
    facetScale: 196,
    environmentIntensity: 0.78,
    exposure: 1.06,
  },
  'diamond-accent': {
    color: '#edf7ff',
    metalColor: '#ffffff',
    clearCoatColor: '#ccecff',
    anisotropy: 0.54,
    roughness: 0.045,
    clearCoatStrength: 1.0,
    facetScale: 340,
    environmentIntensity: 1.0,
    exposure: 1.16,
  },
};

const liveMaterials = new Set<THREE.ShaderMaterial>();
const clampEnv = (value: number) => THREE.MathUtils.clamp(value, 0.65, 1.0);

export function updateJewelryEnvironment(envMap: THREE.Texture | null, intensity = 0.88): void {
  liveMaterials.forEach((material) => {
    material.uniforms.envMap.value = envMap;
    material.uniforms.environmentIntensity.value = clampEnv(intensity);
    material.needsUpdate = true;
  });
}

export function updateJewelryExposure(exposure: number): void {
  liveMaterials.forEach((material) => {
    material.uniforms.exposure.value = Math.max(0.0, exposure);
  });
}

export function createJewelryShaderMaterial(
  typeOrOptions: JewelryMaterialType | JewelryShaderOptions = 'gold-18k',
  overrides: JewelryShaderOptions = {},
): THREE.ShaderMaterial {
  const options = typeof typeOrOptions === 'string' ? { ...overrides, type: typeOrOptions } : typeOrOptions;
  const preset = PRESETS[options.type ?? 'gold-18k'];
  const material = new THREE.ShaderMaterial({
    name: `JewelryFactoryAnisotropic_${options.type ?? 'gold-18k'}`,
    uniforms: {
      baseColor: { value: new THREE.Color(options.color ?? preset.color) },
      metalColor: { value: new THREE.Color(options.metalColor ?? preset.metalColor) },
      clearCoatColor: { value: new THREE.Color(options.clearCoatColor ?? preset.clearCoatColor) },
      anisotropy: { value: options.anisotropy ?? preset.anisotropy },
      roughness: { value: options.roughness ?? preset.roughness },
      clearCoatStrength: { value: options.clearCoatStrength ?? preset.clearCoatStrength },
      facetScale: { value: options.facetScale ?? preset.facetScale },
      environmentIntensity: { value: clampEnv(options.environmentIntensity ?? preset.environmentIntensity) },
      exposure: { value: options.exposure ?? preset.exposure },
      envMap: { value: options.envMap ?? null },
    },
    vertexShader: /* glsl */`
      attribute vec4 tangent;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec3 vTangent;
      varying vec2 vUv;
      varying float vVertexAo;

      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec3 sourceTangent = tangent.xyz;
        if (length(sourceTangent) < 0.001) sourceTangent = vec3(1.0, 0.0, 0.0);
        vTangent = normalize(mat3(modelMatrix) * sourceTangent);
        vVertexAo = clamp(0.58 + normal.y * 0.28 + position.y * 0.045, 0.36, 1.0);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 baseColor; uniform vec3 metalColor; uniform vec3 clearCoatColor;
      uniform float anisotropy; uniform float roughness; uniform float clearCoatStrength;
      uniform float facetScale; uniform float environmentIntensity; uniform float exposure;
      uniform sampler2D envMap;
      varying vec3 vWorldPosition; varying vec3 vNormal; varying vec3 vTangent; varying vec2 vUv; varying float vVertexAo;
      float saturate(float v) { return clamp(v, 0.0, 1.0); }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise(vec2 p) { vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x),u.y); }
      vec2 matcapUv(vec3 r) { float m = 2.0 * sqrt(r.x*r.x + r.y*r.y + (r.z + 1.0)*(r.z + 1.0)); return r.xy / max(m, 0.001) + 0.5; }
      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorldPosition);
        vec3 T = normalize(vTangent - N * dot(N, vTangent));
        vec3 B = normalize(cross(N, T));
        vec3 L = normalize(vec3(0.35, 0.82, 0.44));
        vec3 H = normalize(V + L);
        float micro = noise(vUv * facetScale) * 2.0 - 1.0;
        vec3 FN = normalize(N + (T * micro + B * (noise(vUv.yx * facetScale * 0.73) - 0.5)) * 0.06);
        float NoL = saturate(dot(FN, L)); float NoV = saturate(dot(FN, V)); float NoH = saturate(dot(FN, H));
        float ToH = dot(T, H); float BoH = dot(B, H);
        float ax = max(0.018, roughness * roughness * (1.0 + anisotropy));
        float ay = max(0.018, roughness * roughness * (1.0 - anisotropy * 0.82));
        float d = 1.0 / max(0.001, 3.14159265 * ax * ay * pow((ToH*ToH)/(ax*ax) + (BoH*BoH)/(ay*ay) + NoH*NoH, 2.0));
        float fresnel = pow(1.0 - NoV, 5.0);
        vec3 reflection = texture2D(envMap, matcapUv(reflect(-V, FN))).rgb * environmentIntensity;
        vec3 spec = mix(baseColor, metalColor, 0.72) * d * NoL;
        vec3 coat = clearCoatColor * pow(NoH, mix(96.0, 560.0, clearCoatStrength)) * (0.1 + 0.9 * fresnel) * clearCoatStrength;
        vec3 edgeGlow = clearCoatColor * fresnel * 0.28;
        vec3 bounce = baseColor * (0.16 * NoL + 0.035) * vVertexAo;
        gl_FragColor = vec4((bounce + spec + coat + edgeGlow + reflection * (0.2 + fresnel * 0.5)) * exposure, 1.0);
      }
    `,
    lights: false,
  });

  const baseDispose = material.dispose.bind(material);
  material.dispose = () => {
    liveMaterials.delete(material);
    baseDispose();
  };
  liveMaterials.add(material);
  return material;
}
