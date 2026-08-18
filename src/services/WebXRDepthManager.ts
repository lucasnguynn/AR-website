import * as THREE from 'three';

export type XRDepthDataFormat = 'luminance-alpha' | 'float32';

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
}

export class WebXRDepthManager {
  readonly depthTexture = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType);
  readonly occlusionProxy: THREE.Mesh;

  private readonly buffers = [new Float32Array(1), new Float32Array(1)];
  private writeIndex = 0;
  private width = 1;
  private height = 1;
  private rawValueToMeters = 1;
  private readonly nearMeters: number;
  private readonly farMeters: number;

  constructor(options: DepthManagerOptions = {}) {
    this.nearMeters = options.nearMeters ?? 0.02;
    this.farMeters = options.farMeters ?? 8.0;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.depthTexture.generateMipmaps = false;
    this.depthTexture.needsUpdate = true;

    this.occlusionProxy = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.createOcclusionMaterial(options.occlusionOpacity ?? 1.0),
    );
    this.occlusionProxy.name = 'WebXRDepthOcclusionProxy';
    this.occlusionProxy.frustumCulled = false;
    this.occlusionProxy.renderOrder = -10;
  }

  update(frame: XRFrameWithDepthData, view: XRView): boolean {
    const depth = frame.getDepthInformation?.(view);
    if (!depth?.data || depth.width <= 0 || depth.height <= 0) return false;

    this.ensureSize(depth.width, depth.height);
    this.rawValueToMeters = depth.rawValueToMeters ?? 1;
    const target = this.buffers[this.writeIndex];
    this.decodeDepth(depth, target);

    this.depthTexture.image = { data: target, width: this.width, height: this.height };
    this.depthTexture.needsUpdate = true;
    this.writeIndex = 1 - this.writeIndex;

    const material = this.occlusionProxy.material as THREE.ShaderMaterial;
    material.uniforms.depthMap.value = this.depthTexture;
    material.uniforms.depthResolution.value.set(this.width, this.height);
    material.uniforms.nearMeters.value = this.nearMeters;
    material.uniforms.farMeters.value = this.farMeters;
    material.uniforms.rawValueToMeters.value = this.rawValueToMeters;
    return true;
  }

  attachToCamera(camera: THREE.Camera): void {
    if (this.occlusionProxy.parent !== camera) camera.add(this.occlusionProxy);
    this.occlusionProxy.position.set(0, 0, -1);
    this.occlusionProxy.quaternion.identity();
    this.occlusionProxy.scale.set(1, 1, 1);
  }

  dispose(): void {
    this.depthTexture.dispose();
    this.occlusionProxy.geometry.dispose();
    (this.occlusionProxy.material as THREE.Material).dispose();
  }

  private ensureSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.buffers[0] = new Float32Array(width * height);
    this.buffers[1] = new Float32Array(width * height);
  }

  private decodeDepth(depth: XRDepthInformationWithData, target: Float32Array): void {
    const source = ArrayBuffer.isView(depth.data)
      ? new Uint8Array(depth.data.buffer, depth.data.byteOffset, depth.data.byteLength)
      : new Uint8Array(depth.data);

    if (source.byteLength === target.length * 4) {
      const floatDepth = ArrayBuffer.isView(depth.data)
        ? new Float32Array(depth.data.buffer, depth.data.byteOffset, target.length)
        : new Float32Array(depth.data);
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
      name: 'XRDepthOcclusionMaterial',
      uniforms: {
        depthMap: { value: this.depthTexture },
        depthResolution: { value: new THREE.Vector2(this.width, this.height) },
        nearMeters: { value: this.nearMeters },
        farMeters: { value: this.farMeters },
        rawValueToMeters: { value: this.rawValueToMeters },
        opacity: { value: opacity },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D depthMap;
        uniform float nearMeters;
        uniform float farMeters;
        uniform float opacity;
        varying vec2 vUv;

        void main() {
          float physicalDepthMeters = texture2D(depthMap, vUv).r;
          if (physicalDepthMeters <= nearMeters || physicalDepthMeters >= farMeters) discard;
          float clipDepth = ((1.0 / physicalDepthMeters) - (1.0 / nearMeters)) / ((1.0 / farMeters) - (1.0 / nearMeters));
          gl_FragDepthEXT = clamp(clipDepth, 0.0, 1.0);
          gl_FragColor = vec4(0.0, 0.0, 0.0, opacity);
        }
      `,
      extensions: { fragDepth: true } as unknown as THREE.ShaderMaterialParameters['extensions'],
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
    });
  }
}
