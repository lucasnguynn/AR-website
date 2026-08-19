import * as THREE from 'three';
import { MonocularDepthEstimator, type MonocularDepthResult } from './MonocularDepthEstimator';

export type XRDepthDataFormat = 'luminance-alpha' | 'float32';
export type DepthOcclusionTier = 'webxr-depth' | 'monocular-depth' | 'geometric-proxy';

export interface XRDepthInformationWithData {
  readonly width: number;
  readonly height: number;
  readonly rawValueToMeters?: number;
  readonly normDepthBufferFromNormView?: XRRigidTransform;
  readonly data: ArrayBuffer | ArrayBufferView;
  getDepthInMeters?(x: number, y: number): number;
}

export type XRFrameWithDepthData = XRFrame & {
  getDepthInformation?(view: XRView): XRDepthInformationWithData | null | undefined;
};

export interface DepthManagerOptions {
  readonly nearMeters?: number;
  readonly farMeters?: number;
  readonly depthFormat?: XRDepthDataFormat;
  readonly occlusionOpacity?: number;
  readonly modelUrl?: string;
  readonly throttleAfterMisses?: number;
}

export interface DepthProxyLandmark {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface DepthUpdateOptions {
  readonly cameraFrame?: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas;
  readonly landmarks?: readonly DepthProxyLandmark[];
}

export class WebXRDepthManager {
  readonly depthTexture = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType);
  readonly occlusionProxy: THREE.Mesh;
  readonly geometricProxy: THREE.Mesh;

  private buffers = [new Float32Array(1), new Float32Array(1)];
  private writeIndex = 0;
  private width = 1;
  private height = 1;
  private rawValueToMeters = 1;
  private readonly nearMeters: number;
  private readonly farMeters: number;
  private readonly throttleAfterMisses: number;
  private adaptiveMissThreshold: number;
  private readonly monocularEstimator: MonocularDepthEstimator;
  private gpuMisses = 0;
  private proxyRadiusMeters = 0.11;
  private activeTier: DepthOcclusionTier = 'geometric-proxy';
  private disposed = false;

  constructor(options: DepthManagerOptions = {}) {
    this.nearMeters = options.nearMeters ?? 0.02;
    this.farMeters = options.farMeters ?? 8.0;
    this.throttleAfterMisses = options.throttleAfterMisses ?? 24;
    this.adaptiveMissThreshold = this.throttleAfterMisses;
    this.monocularEstimator = new MonocularDepthEstimator(options.modelUrl ?? '/models/depth/depth_anything_v2_small.onnx');
    this.depthTexture.minFilter = THREE.LinearFilter;
    this.depthTexture.magFilter = THREE.LinearFilter;
    this.depthTexture.generateMipmaps = false;
    this.depthTexture.needsUpdate = true;

    this.occlusionProxy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.createOcclusionMaterial(options.occlusionOpacity ?? 1.0));
    this.occlusionProxy.name = 'DepthOcclusionTextureProxy';
    this.occlusionProxy.frustumCulled = false;
    this.occlusionProxy.renderOrder = -10;

    this.geometricProxy = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 24, 12),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true }),
    );
    this.geometricProxy.name = 'FallbackHandGeometryDepthProxy';
    this.geometricProxy.visible = false;
  }

  get tier(): DepthOcclusionTier {
    return this.activeTier;
  }

  async update(
    frame: XRFrameWithDepthData,
    view: XRView,
    cameraFrameOrOptions?: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas | DepthUpdateOptions,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const options = this.resolveUpdateOptions(cameraFrameOrOptions);
    if (options.landmarks) this.updateGeometricProxy(options.landmarks);

    if (this.updateFromWebXR(frame, view)) {
      this.gpuMisses = 0;
      this.adaptiveMissThreshold = Math.min(this.throttleAfterMisses * 4, this.adaptiveMissThreshold + 1);
      this.setTier('webxr-depth');
      return true;
    }

    this.gpuMisses += 1;
    this.adaptiveMissThreshold = Math.max(1, this.adaptiveMissThreshold - 1);
    if (options.cameraFrame && this.gpuMisses >= this.adaptiveMissThreshold) {
      const result = this.monocularEstimator.estimate(options.cameraFrame);
      if (result) {
        this.gpuMisses = 0;
        this.adaptiveMissThreshold = Math.min(this.throttleAfterMisses * 4, this.adaptiveMissThreshold + 2);
        this.uploadDepth(result.width, result.height, result.depth, true);
        this.setTier('monocular-depth');
        return true;
      }
    }

    this.setTier('geometric-proxy');
    return false;
  }

  updateFromWebXR(frame: XRFrameWithDepthData, view: XRView): boolean {
    let depth: XRDepthInformationWithData | null | undefined;
    try {
      depth = frame.getDepthInformation?.(view);
    } catch (error) {
      console.warn('WebXR depth information failed; falling back to monocular depth.', error);
      return false;
    }
    if (!depth?.data || depth.width <= 0 || depth.height <= 0) return false;
    this.ensureSize(depth.width, depth.height);
    this.rawValueToMeters = depth.rawValueToMeters ?? 1;
    const target = this.buffers[this.writeIndex];
    this.decodeDepth(depth, target);
    this.uploadDepth(this.width, this.height, target, true);
    this.writeIndex = 1 - this.writeIndex;
    return true;
  }

  attachToCamera(camera: THREE.Camera): void {
    if (this.occlusionProxy.parent !== camera) camera.add(this.occlusionProxy);
    if (this.geometricProxy.parent !== camera) camera.add(this.geometricProxy);
    this.occlusionProxy.position.set(0, 0, -1);
    this.occlusionProxy.quaternion.identity();
    this.occlusionProxy.scale.set(1, 1, 1);
    this.geometricProxy.position.set(0, -0.08, -0.42);
  }

  dispose(): void {
    this.disposed = true;
    this.monocularEstimator.dispose();
    this.depthTexture.dispose();
    this.occlusionProxy.geometry.dispose();
    (this.occlusionProxy.material as THREE.Material).dispose();
    this.geometricProxy.geometry.dispose();
    (this.geometricProxy.material as THREE.Material).dispose();
    this.buffers = [new Float32Array(1), new Float32Array(1)];
  }

  updateGeometricProxy(landmarks: readonly DepthProxyLandmark[]): void {
    if (landmarks.length < 2) return;
    let maxDistance = 0;
    for (let i = 0; i < landmarks.length; i += 1) {
      for (let j = i + 1; j < landmarks.length; j += 1) {
        const dx = landmarks[i].x - landmarks[j].x;
        const dy = landmarks[i].y - landmarks[j].y;
        const dz = (landmarks[i].z ?? 0) - (landmarks[j].z ?? 0);
        maxDistance = Math.max(maxDistance, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) return;
    const targetRadius = THREE.MathUtils.clamp(maxDistance * 0.33, 0.035, 0.18);
    this.proxyRadiusMeters = this.proxyRadiusMeters * 0.82 + targetRadius * 0.18;
    this.geometricProxy.geometry.dispose();
    this.geometricProxy.geometry = new THREE.CylinderGeometry(this.proxyRadiusMeters, this.proxyRadiusMeters, this.proxyRadiusMeters * 3.2, 24, 1);
  }

  private resolveUpdateOptions(
    cameraFrameOrOptions?: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas | DepthUpdateOptions,
  ): DepthUpdateOptions {
    if (!cameraFrameOrOptions) return {};
    if (this.isDepthUpdateOptions(cameraFrameOrOptions)) return cameraFrameOrOptions;
    return { cameraFrame: cameraFrameOrOptions };
  }

  private isDepthUpdateOptions(
    value: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas | DepthUpdateOptions,
  ): value is DepthUpdateOptions {
    return 'cameraFrame' in value || 'landmarks' in value;
  }

  private setTier(tier: DepthOcclusionTier): void {
    this.activeTier = tier;
    this.occlusionProxy.visible = tier !== 'geometric-proxy';
    this.geometricProxy.visible = tier === 'geometric-proxy';
  }

  private ensureSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.buffers = [new Float32Array(width * height), new Float32Array(width * height)];
  }

  private uploadDepth(width: number, height: number, source: Float32Array, blur: boolean): void {
    this.ensureSize(width, height);
    const target = this.buffers[this.writeIndex];
    if (blur) this.gaussianBlur3x3(source, target, width, height);
    else target.set(source.subarray(0, target.length));
    this.depthTexture.image = { data: target, width, height };
    this.depthTexture.needsUpdate = true;
    const material = this.occlusionProxy.material as THREE.ShaderMaterial;
    material.uniforms.depthMap.value = this.depthTexture;
    material.uniforms.depthResolution.value.set(width, height);
    material.uniforms.nearMeters.value = this.nearMeters;
    material.uniforms.farMeters.value = this.farMeters;
    material.uniforms.rawValueToMeters.value = this.rawValueToMeters;
  }

  private gaussianBlur3x3(source: Float32Array, target: Float32Array, width: number, height: number): void {
    const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let weight = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const sx = THREE.MathUtils.clamp(x + kx, 0, width - 1);
            const sy = THREE.MathUtils.clamp(y + ky, 0, height - 1);
            const w = kernel[(ky + 1) * 3 + (kx + 1)];
            sum += source[sy * width + sx] * w;
            weight += w;
          }
        }
        target[y * width + x] = sum / weight;
      }
    }
  }

  private decodeDepth(depth: XRDepthInformationWithData, target: Float32Array): void {
    const source = ArrayBuffer.isView(depth.data) ? new Uint8Array(depth.data.buffer, depth.data.byteOffset, depth.data.byteLength) : new Uint8Array(depth.data);
    if (source.byteLength === target.length * 4) {
      const floatDepth = ArrayBuffer.isView(depth.data) ? new Float32Array(depth.data.buffer, depth.data.byteOffset, target.length) : new Float32Array(depth.data);
      target.set(floatDepth.subarray(0, target.length));
      return;
    }
    for (let i = 0, j = 0; i < target.length; i += 1, j += 2) {
      const raw = source[j] | ((source[j + 1] ?? 0) << 8);
      target[i] = raw * this.rawValueToMeters;
    }
  }

  private createOcclusionMaterial(opacity: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: 'TieredDepthOcclusionMaterial',
      uniforms: {
        depthMap: { value: this.depthTexture },
        depthResolution: { value: new THREE.Vector2(this.width, this.height) },
        nearMeters: { value: this.nearMeters },
        farMeters: { value: this.farMeters },
        rawValueToMeters: { value: this.rawValueToMeters },
        opacity: { value: opacity },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; uniform sampler2D depthMap; uniform float nearMeters; uniform float farMeters; uniform float opacity; varying vec2 vUv; void main() { float d = texture2D(depthMap, vUv).r; if (d <= nearMeters || d >= farMeters) discard; float clipDepth = ((1.0 / d) - (1.0 / nearMeters)) / ((1.0 / farMeters) - (1.0 / nearMeters)); gl_FragDepthEXT = clamp(clipDepth, 0.0, 1.0); gl_FragColor = vec4(0.0, 0.0, 0.0, opacity); }',
      extensions: { fragDepth: true } as unknown as THREE.ShaderMaterialParameters['extensions'],
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
    });
  }
}
