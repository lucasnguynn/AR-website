// FILE: src/services/WebXRDepthManager.ts
import * as THREE from 'three';
import { MonocularDepthEstimator } from './MonocularDepthEstimator';

/** Encodings supported by native WebXR depth buffers. */
export type XRDepthDataFormat = 'luminance-alpha' | 'float32';
/** Available depth occlusion strategies ordered from highest to lowest fidelity. */
export type DepthOcclusionTier = 'webxr-depth' | 'monocular-depth' | 'degraded-depth' | 'geometric-proxy';

/** WebXR depth information object with browser-specific raw buffer access. */
export interface XRDepthInformationWithData {
  readonly width: number;
  readonly height: number;
  readonly rawValueToMeters?: number;
  readonly normDepthBufferFromNormView?: XRRigidTransform;
  readonly data: ArrayBuffer | ArrayBufferView;
  getDepthInMeters?(x: number, y: number): number;
}

/** XR frame shape that may expose depth sensing information for a view. */
export type XRFrameWithDepthData = XRFrame & {
  getDepthInformation?(view: XRView): XRDepthInformationWithData | null | undefined;
};

/** Configuration for adaptive WebXR and monocular depth occlusion. */
export interface DepthManagerOptions {
  readonly nearMeters?: number;
  readonly farMeters?: number;
  readonly depthFormat?: XRDepthDataFormat;
  readonly occlusionOpacity?: number;
  readonly modelUrl?: string;
  readonly throttleAfterMisses?: number;
}

/** Normalized landmark used to size the geometric fallback depth proxy. */
export interface DepthProxyLandmark {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

/** Per-frame inputs used by adaptive depth updates. */
export interface DepthUpdateOptions {
  readonly cameraFrame?: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas;
  readonly landmarks?: readonly DepthProxyLandmark[];
}

export interface DepthDiagnostics {
  readonly tier: DepthOcclusionTier;
  readonly captureP50Ms: number;
  readonly captureP95Ms: number;
  readonly inferenceP50Ms: number;
  readonly inferenceP95Ms: number;
  readonly queueDrops: number;
  readonly depthLatencyMs: number;
  readonly transitions: number;
  readonly failures: number;
  readonly provider: 'webxr' | 'webgpu' | 'wasm' | 'geometric-proxy' | 'unavailable';
}

export interface DepthFrameInput extends DepthUpdateOptions {
  readonly xrFrame?: XRFrameWithDepthData;
  readonly xrView?: XRView;
  readonly captureMs?: number;
}

export interface DepthPipeline {
  start(): Promise<void>;
  update(input: DepthFrameInput): void;
  getTier(): DepthOcclusionTier;
  diagnostics(): DepthDiagnostics;
  dispose(): void;
}

/** Coordinates native WebXR depth, worker monocular depth, degraded depth, and geometric fallback occlusion. */
export class WebXRDepthManager implements DepthPipeline {
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
  private adaptiveThreshold = 24;
  private readonly MIN_MISSES = 24;
  private readonly MAX_MISSES = 100;
  private readonly monocularEstimator: MonocularDepthEstimator;
  private gpuMisses = 0;
  private proxyRadiusMeters = 0.11;
  private activeTier: DepthOcclusionTier = 'geometric-proxy';
  private xrDepthAvailable = false;
  private disposed = false;
  private readonly depthUvTransform = new THREE.Matrix4();
  private readonly captureTimings: number[] = [];
  private transitions = 0;
  private lastDepthLatencyMs = 0;

  constructor(options: DepthManagerOptions = {}) {
    this.nearMeters = options.nearMeters ?? 0.02;
    this.farMeters = options.farMeters ?? 8.0;
    this.adaptiveThreshold = THREE.MathUtils.clamp(options.throttleAfterMisses ?? this.MIN_MISSES, this.MIN_MISSES, this.MAX_MISSES);
    this.monocularEstimator = new MonocularDepthEstimator(options.modelUrl ?? '/models/depth/depth_anything_v2_small.onnx');
    this.depthTexture.minFilter = THREE.LinearFilter;
    this.depthTexture.magFilter = THREE.LinearFilter;
    this.depthTexture.generateMipmaps = false;
    this.depthTexture.needsUpdate = true;

    this.occlusionProxy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.createOcclusionMaterial(options.occlusionOpacity ?? 1.0));
    this.occlusionProxy.name = 'DepthOcclusionTextureProxy';
    this.occlusionProxy.frustumCulled = false;
    this.occlusionProxy.renderOrder = -10;
    this.occlusionProxy.visible = false;

    this.geometricProxy = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 24, 12),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true }),
    );
    this.geometricProxy.name = 'FallbackHandGeometryDepthProxy';
    this.geometricProxy.visible = false;
  }

  /** Returns the currently active depth occlusion tier. */
  get tier(): DepthOcclusionTier {
    return this.activeTier;
  }

  getTier(): DepthOcclusionTier { return this.activeTier; }

  async start(): Promise<void> {
    // Initialization is intentionally lazy: the ONNX asset is optional and the
    // worker is only created once the camera producer has capacity and a frame.
  }

  diagnostics(): DepthDiagnostics {
    const sorted = [...this.captureTimings].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
    const estimator = this.monocularEstimator.diagnostics();
    const provider = this.activeTier === 'webxr-depth' ? 'webxr' : this.activeTier === 'geometric-proxy' ? 'geometric-proxy' : estimator.provider;
    return { tier: this.activeTier, captureP50Ms: percentile(0.5), captureP95Ms: percentile(0.95), inferenceP50Ms: estimator.inferenceP50Ms, inferenceP95Ms: estimator.inferenceP95Ms, queueDrops: estimator.dropped, depthLatencyMs: this.lastDepthLatencyMs, transitions: this.transitions, failures: estimator.failures, provider };
  }

  canAcceptCameraFrame(): boolean { return !this.disposed && this.monocularEstimator.canAcceptFrame(); }

  update(input: DepthFrameInput): void {
    if (this.disposed) return;
    if (input.captureMs !== undefined) {
      this.captureTimings.push(input.captureMs);
      if (this.captureTimings.length > 120) this.captureTimings.shift();
    }
    if (input.landmarks) this.updateGeometricProxy(input.landmarks);
    if (input.xrFrame && input.xrView && this.updateFromWebXR(input.xrFrame, input.xrView)) return;
    if (!input.cameraFrame) { this.setTier('geometric-proxy'); return; }
    const before = performance.now();
    const result = this.monocularEstimator.estimate(input.cameraFrame, this.selectTier() === 'degraded-depth' ? 'degraded-depth' : 'monocular-depth');
    if (!result) return;
    this.lastDepthLatencyMs = performance.now() - before + result.averageMs;
    // Sustained misses can reach the proxy tier; successful budget-compliant
    // samples continuously decay the score and recover without remounting.
    this.gpuMisses = result.tier === 'degraded-depth'
      ? Math.min(this.MAX_MISSES, this.gpuMisses + Math.max(1, Math.ceil(result.averageMs / 30)))
      : Math.max(0, this.gpuMisses - 3);
    this.uploadDepth(result.width, result.height, result.depth, true);
    this.setTier(this.selectTier() === 'geometric-proxy' ? 'geometric-proxy' : result.tier);
  }

  /** Selects the best available depth tier while allowing recovery from transient GPU misses. */
  selectTier(): DepthOcclusionTier {
    if (this.xrDepthAvailable) {
      this.gpuMisses = 0;
      return 'webxr-depth';
    }
    if (this.gpuMisses < this.adaptiveThreshold * 0.75) return 'monocular-depth';
    if (this.gpuMisses < this.adaptiveThreshold) return 'degraded-depth';
    return 'geometric-proxy';
  }

  /** Updates the depth occlusion texture from WebXR depth, worker inference, or geometry fallback. */
  async updateLegacy(
    frame: XRFrameWithDepthData,
    view: XRView,
    cameraFrameOrOptions?: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas | DepthUpdateOptions,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const options = this.resolveUpdateOptions(cameraFrameOrOptions);
    if (options.landmarks) this.updateGeometricProxy(options.landmarks);

    this.xrDepthAvailable = this.updateFromWebXR(frame, view);
    if (this.xrDepthAvailable) {
      this.gpuMisses = 0;
      this.adaptiveThreshold = Math.min(this.adaptiveThreshold + 2, this.MAX_MISSES);
      this.setTier('webxr-depth');
      return true;
    }

    const selectedTier = this.selectTier();
    if (options.cameraFrame && selectedTier !== 'geometric-proxy') {
      const inferenceTier = selectedTier === 'webxr-depth' ? 'monocular-depth' : selectedTier;
      const result = this.monocularEstimator.estimate(options.cameraFrame, inferenceTier);
      if (result) {
        this.adaptiveThreshold = Math.min(this.adaptiveThreshold + 2, this.MAX_MISSES);
        this.gpuMisses = Math.max(0, this.gpuMisses - 1);
        this.uploadDepth(result.width, result.height, result.depth, true);
        this.setTier(result.tier);
        return true;
      }
    }

    this.adaptiveThreshold = Math.max(this.adaptiveThreshold - 5, this.MIN_MISSES);
    this.gpuMisses += 1;
    this.setTier(this.selectTier());
    return this.activeTier !== 'geometric-proxy';
  }

  /** Attempts to upload native WebXR depth information for the current frame. */
  updateFromWebXR(frame: XRFrameWithDepthData, view: XRView): boolean {
    let depth: XRDepthInformationWithData | null | undefined;
    try {
      depth = frame.getDepthInformation?.(view);
    } catch (error) {
      console.warn('WebXR depth information failed; falling back to monocular depth.', error);
      this.xrDepthAvailable = false;
      this.setTier('geometric-proxy');
      return false;
    }
    if (!depth?.data || depth.width <= 0 || depth.height <= 0) {
      this.xrDepthAvailable = false;
      this.setTier('geometric-proxy');
      return false;
    }
    this.ensureSize(depth.width, depth.height);
    this.rawValueToMeters = depth.rawValueToMeters ?? 1;
    this.depthUvTransform.fromArray(depth.normDepthBufferFromNormView?.matrix ?? new THREE.Matrix4().elements);
    const target = this.buffers[this.writeIndex];
    this.decodeDepth(depth, target);
    this.uploadDepth(this.width, this.height, target, true);
    this.xrDepthAvailable = true;
    this.setTier('webxr-depth');
    return true;
  }

  /** Attaches depth proxies to the active AR camera. */
  attachToCamera(camera: THREE.Camera): void {
    if (this.occlusionProxy.parent !== camera) camera.add(this.occlusionProxy);
    if (this.geometricProxy.parent !== camera) camera.add(this.geometricProxy);
    this.occlusionProxy.position.set(0, 0, -1);
    this.occlusionProxy.quaternion.identity();
    this.occlusionProxy.scale.set(1, 1, 1);
    this.geometricProxy.position.set(0, -0.08, -0.42);
  }

  /** Attaches full-screen depth and reference-space fallback proxies to a rendered scene graph. */
  attachToScene(scene: THREE.Scene): void {
    scene.add(this.occlusionProxy, this.geometricProxy);
    this.occlusionProxy.position.set(0, 0, 0);
  }

  /** Removes render objects while retaining reusable buffers for a later XR session. */
  detach(): void {
    this.occlusionProxy.removeFromParent();
    this.geometricProxy.removeFromParent();
    this.occlusionProxy.visible = false;
    this.geometricProxy.visible = false;
    this.xrDepthAvailable = false;
    this.activeTier = 'geometric-proxy';
    // detach() is reusable between XR sessions. Do not dispose the DataTexture
    // here; Three.js cannot safely reuse a disposed GPU texture object.
    this.depthTexture.image = { data: new Float32Array([1]), width: 1, height: 1 };
    this.depthTexture.needsUpdate = true;
  }

  /** Releases GPU and worker resources owned by the depth manager. */
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

  /** Updates the geometric fallback proxy from normalized hand landmarks. */
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
    // Geometry is allocated once; only its transform changes per tracking frame.
    this.geometricProxy.scale.set(this.proxyRadiusMeters / 0.11, this.proxyRadiusMeters * 3.2 / 0.22, this.proxyRadiusMeters / 0.11);
  }

  /** Positions the reusable geometric fallback around the XR ring-finger segment. */
  updateXRHandProxy(position: readonly [number, number, number], orientation: readonly [number, number, number, number], lengthMeters: number): void {
    this.geometricProxy.position.fromArray(position);
    this.geometricProxy.quaternion.fromArray(orientation);
    const radius = THREE.MathUtils.clamp(lengthMeters * 0.22, 0.004, 0.014);
    this.geometricProxy.scale.set(radius / 0.11, lengthMeters / 0.22, radius / 0.11);
  }

  setGeometricFallbackEnabled(enabled: boolean): void {
    if (this.activeTier === 'geometric-proxy') this.geometricProxy.visible = enabled;
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
    if (tier !== this.activeTier) {
      this.transitions += 1;
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ar:depth-diagnostics', { detail: { ...this.diagnostics(), tier } }));
    }
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

    // Native WebXR decoding writes into the current back buffer. Blurring that
    // same array in-place corrupts neighbouring samples as the kernel advances.
    // If source === current buffer, blur into the opposite buffer and keep the
    // current one available for the next decode. External monocular buffers are
    // copied into the current back buffer and then the index is flipped.
    const writeTarget = this.buffers[this.writeIndex];
    let published: Float32Array;

    if (blur && source === writeTarget) {
      const scratch = this.buffers[1 - this.writeIndex];
      this.gaussianBlur3x3(source, scratch, width, height);
      published = scratch;
    } else {
      if (blur) this.gaussianBlur3x3(source, writeTarget, width, height);
      else writeTarget.set(source.subarray(0, writeTarget.length));
      published = writeTarget;
      this.writeIndex = 1 - this.writeIndex;
    }

    this.depthTexture.image = { data: published, width, height };
    this.depthTexture.needsUpdate = true;
    const material = this.occlusionProxy.material as THREE.ShaderMaterial;
    material.uniforms.depthMap.value = this.depthTexture;
    material.uniforms.depthResolution.value.set(width, height);
    material.uniforms.nearMeters.value = this.nearMeters;
    material.uniforms.farMeters.value = this.farMeters;
    material.uniforms.rawValueToMeters.value = 1; // texture values are normalized to meters on CPU
    material.uniforms.depthUvTransform.value.copy(this.depthUvTransform);
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
      const floatDepth = ArrayBuffer.isView(depth.data)
        ? new Float32Array(depth.data.buffer, depth.data.byteOffset, target.length)
        : new Float32Array(depth.data);
      for (let i = 0; i < target.length; i += 1) {
        target[i] = floatDepth[i] * this.rawValueToMeters;
      }
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
        depthUvTransform: { value: this.depthUvTransform },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; uniform sampler2D depthMap; uniform float nearMeters; uniform float farMeters; uniform float opacity; uniform mat4 depthUvTransform; varying vec2 vUv; void main() { vec4 depthUvH = depthUvTransform * vec4(vUv, 0.0, 1.0); vec2 depthUv = depthUvH.xy / max(depthUvH.w, 0.00001); if (any(lessThan(depthUv, vec2(0.0))) || any(greaterThan(depthUv, vec2(1.0)))) discard; float d = texture2D(depthMap, depthUv).r; if (d <= nearMeters || d >= farMeters) discard; float windowDepth = farMeters / (farMeters - nearMeters) - (farMeters * nearMeters) / ((farMeters - nearMeters) * d); gl_FragDepthEXT = clamp(windowDepth, 0.0, 1.0); gl_FragColor = vec4(0.0, 0.0, 0.0, opacity); }',
      extensions: { fragDepth: true } as unknown as THREE.ShaderMaterialParameters['extensions'],
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
    });
  }
}

// VERIFY: console.log('Simulate 25 GPU misses → tier shows degraded-depth, after 10 successes recovers to monocular-depth')
