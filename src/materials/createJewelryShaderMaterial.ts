import * as THREE from 'three';

export interface JewelryShaderOptions {
  color?: THREE.ColorRepresentation;
  metalColor?: THREE.ColorRepresentation;
  clearCoatColor?: THREE.ColorRepresentation;
  anisotropy?: number;
  roughness?: number;
  clearCoatStrength?: number;
  facetScale?: number;
  envMap?: THREE.Texture | null;
}

export function createJewelryShaderMaterial(options: JewelryShaderOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PremiumJewelryClearCoatAnisotropic',
    uniforms: {
      baseColor: { value: new THREE.Color(options.color ?? '#f6d365') },
      metalColor: { value: new THREE.Color(options.metalColor ?? '#fff0b3') },
      clearCoatColor: { value: new THREE.Color(options.clearCoatColor ?? '#ffffff') },
      anisotropy: { value: options.anisotropy ?? 0.72 },
      roughness: { value: options.roughness ?? 0.16 },
      clearCoatStrength: { value: options.clearCoatStrength ?? 0.85 },
      facetScale: { value: options.facetScale ?? 180.0 },
      envMap: { value: options.envMap ?? null },
      cameraPositionWorld: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec3 vTangent;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vTangent = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      uniform vec3 baseColor;
      uniform vec3 metalColor;
      uniform vec3 clearCoatColor;
      uniform float anisotropy;
      uniform float roughness;
      uniform float clearCoatStrength;
      uniform float facetScale;
      uniform vec3 cameraPositionWorld;

      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec3 vTangent;
      varying vec2 vUv;

      float saturate(float v) { return clamp(v, 0.0, 1.0); }

      float facetNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453123);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453123);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453123);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453123);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorldPosition);
        vec3 T = normalize(vTangent - N * dot(N, vTangent));
        vec3 B = normalize(cross(N, T));
        vec3 L = normalize(vec3(0.35, 0.82, 0.44));
        vec3 H = normalize(V + L);

        float microscopicFacet = facetNoise(vUv * facetScale) * 2.0 - 1.0;
        vec3 facetNormal = normalize(N + (T * microscopicFacet + B * facetNoise(vUv.yx * facetScale * 0.73)) * 0.055);
        float NoL = saturate(dot(facetNormal, L));
        float NoV = saturate(dot(facetNormal, V));
        float NoH = saturate(dot(facetNormal, H));
        float ToH = dot(T, H);
        float BoH = dot(B, H);

        float ax = max(0.018, roughness * roughness * (1.0 + anisotropy));
        float ay = max(0.018, roughness * roughness * (1.0 - anisotropy * 0.82));
        float anisotropicD = 1.0 / max(0.001, 3.14159265 * ax * ay * pow((ToH * ToH) / (ax * ax) + (BoH * BoH) / (ay * ay) + NoH * NoH, 2.0));
        float fresnel = pow(1.0 - NoV, 5.0);
        vec3 conductorF0 = mix(baseColor, metalColor, 0.68);
        vec3 metalSpec = conductorF0 * anisotropicD * NoL;

        float clearCoatD = pow(NoH, mix(96.0, 520.0, clearCoatStrength));
        vec3 clearCoat = clearCoatColor * clearCoatD * (0.08 + 0.92 * fresnel) * clearCoatStrength;
        vec3 sheen = metalColor * pow(saturate(dot(reflect(-V, facetNormal), L)), 18.0) * 0.35;
        vec3 diffuseBounce = baseColor * NoL * 0.18;
        vec3 color = diffuseBounce + metalSpec + clearCoat + sheen + baseColor * 0.035;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
    lights: false,
    transparent: false,
  });
}
