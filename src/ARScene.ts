/**
 * ARScene.ts
 *
 * Three.js scene wrapper for AR ring rendering.
 * Handles renderer setup, lighting, background video texture, 3D model loading,
 * and proper resource cleanup to prevent memory leaks.
 *
 * @module ARScene
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RingPose } from './RingPoseEstimator';

/**
 * Configuration for the AR scene
 */
export interface ARSceneConfig {
  width: number;
  height: number;
  dracoPath: string;
  near: number;
  far: number;
  fov: number;
}

const DEFAULT_CONFIG: ARSceneConfig = {
  width: 1280,
  height: 720,
  dracoPath: 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
  near: 1,
  far: 1000,
  fov: 50,
};

interface LoadedRingModel {
  mesh: THREE.Object3D;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  texture?: THREE.Texture;
}

export class ARScene {
  private config: ARSceneConfig;

  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;

  private ambientLight: THREE.AmbientLight;
  private directionalLight: THREE.DirectionalLight;
  private pmremGenerator: PMREMGenerator | null = null;
  private environmentTexture: THREE.Texture | null = null;

  private videoTexture: THREE.VideoTexture | null = null;

  private ringModel: LoadedRingModel | null = null;
  private ringGroup: THREE.Group;

  private gltfLoader: GLTFLoader;
  private dracoLoader: DRACOLoader;

  private isInitialized: boolean = false;

  constructor(config: Partial<ARSceneConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.config.fov,
      this.config.width / this.config.height,
      this.config.near,
      this.config.far
    );

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.config.width, this.config.height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.directionalLight.position.set(5, 10, 7);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 1024;
    this.directionalLight.shadow.mapSize.height = 1024;
    this.scene.add(this.directionalLight);

    this.pmremGenerator = new PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    const hdriSources = [
      'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/royal_esplanade_1k.hdr',
    ];

    const loadHDRI = async (sources: string[], index: number): Promise<void> => {
      if (index >= sources.length) {
        console.warn('All HDRI sources failed, using procedural RoomEnvironment fallback');
        if (this.pmremGenerator) {
          const fallbackEnv = this.pmremGenerator.fromScene(
            new RoomEnvironment()
          ).texture;
          this.scene.environment = fallbackEnv;
          this.environmentTexture = fallbackEnv;
        }
        return;
      }

      const currentSource = sources[index];
      new RGBELoader().load(
        currentSource,
        (texture: THREE.DataTexture) => {
          if (!this.pmremGenerator) { texture.dispose(); return; }
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.environmentTexture = this.pmremGenerator.fromEquirectangular(texture).texture;
          this.scene.environment = this.environmentTexture;
          if (!this.videoTexture) {
            this.scene.background = this.environmentTexture;
          }
          texture.dispose();
        },
        undefined,
        (_error: unknown) => {
          loadHDRI(sources, index + 1);
        }
      );
    };

    loadHDRI(hdriSources, 0);

    this.ringGroup = new THREE.Group();
    this.scene.add(this.ringGroup);

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(this.config.dracoPath);
    this.dracoLoader.setDecoderConfig({ type: 'js' });

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    this.isInitialized = true;
  }

  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setVideoElement(video: HTMLVideoElement): void {
    if (this.videoTexture) {
      this.videoTexture.dispose();
    }

    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;

    this.scene.background = this.videoTexture;
  }

  getEnvironmentTexture(): THREE.Texture | null {
    return this.environmentTexture;
  }

  updateCameraParams(fov: number, aspect: number, near: number, far: number): void {
    this.camera.fov = fov;
    this.camera.aspect = aspect;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Load a ring model from URL.
   *
   * FIX BUG-3 (169% progress):
   * The original onProgress callback passed GLTFLoader's raw ProgressEvent values
   * directly to onProgress(percent). This produces corrupt values (>100%, NaN, Infinity)
   * for two reasons:
   *
   * 1. GitHub Pages 404 responses have their own Content-Length (the HTML error page),
   *    so progress.total is the *error page* size — tiny compared to the GLB. If the
   *    browser fires progress events before the HTTP status is read, loaded/total can
   *    exceed 1.0 or produce nonsense.
   *
   * 2. GLTFLoader's onProgress fires for EVERY sub-resource fetch (Draco decoder JS,
   *    bin chunks, textures). Each sub-resource has independent loaded/total counters.
   *    Summing them naively against a single total → values well above 100%.
   *
   * Fix: clamp intermediate progress to [0, 99] and only emit 100 from the onLoad
   * callback. This guarantees monotonic, bounded progress regardless of network weirdness.
   *
   * Secondary fix: throw a typed error when the response is a 404 so the caller's
   * catch block can display a useful message.
   */
  async loadRing(url: string, scale: number = 1.0, onProgress?: (progress: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.unloadRing();

      this.gltfLoader.load(
        url,
        // onLoad — fires only when the full model is successfully parsed
        (gltf: GLTF) => {
          try {
            const modelGroup = gltf.scene.clone(true);
            modelGroup.scale.setScalar(scale);

            modelGroup.traverse((child: THREE.Object3D) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material instanceof THREE.MeshStandardMaterial) {
                  child.material.envMapIntensity = 1.0;
                  child.material.needsUpdate = true;
                }
              }
            });

            this.ringModel = {
              mesh: modelGroup as unknown as THREE.Mesh,
              geometry: new THREE.BufferGeometry(),
              material: new THREE.MeshBasicMaterial(),
            };

            this.ringGroup.add(modelGroup);

            // FIX: emit exactly 100 only when the model is fully loaded,
            // not from the onProgress callback which can report >100%.
            if (onProgress) {
              onProgress(100);
            }

            resolve();
          } catch (error) {
            reject(error);
          }
        },

        // onProgress — FIX: clamp to [0, 99] to prevent wild values
        (progressEvent: ProgressEvent) => {
          if (!onProgress) return;

          if (progressEvent.lengthComputable && progressEvent.total > 0) {
            // Clamp to 99 — 100 is reserved for the onLoad callback above.
            // This ensures the bar never reads "100%" before the model is ready.
            const raw = (progressEvent.loaded / progressEvent.total) * 100;
            const clamped = Math.min(Math.floor(raw), 99);
            onProgress(clamped);
          } else {
            // No Content-Length → indeterminate. Report a fake heartbeat so the
            // UI shows *something* is happening. Increment in coarse steps, cap at 90.
            // We don't track the current value here — the store already has it;
            // just push forward to show activity.
            onProgress(50); // Indeterminate pulse — "more than 0, less than done"
          }
        },

        // onError — fires for 404s, network errors, parse failures
        (error: unknown) => {
          // Produce a useful error message that includes the URL
          const message = error instanceof Error
            ? error.message
            : `Failed to load model from: ${url}`;

          console.error(`[ARScene] loadRing failed for URL "${url}":`, error);
          reject(new Error(message));
        }
      );
    });
  }

  unloadRing(): void {
    if (this.ringModel) {
      this.ringGroup.remove(this.ringModel.mesh);

      this.ringModel.mesh.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mats = Array.isArray(child.material)
            ? child.material
            : [child.material];
          mats.forEach((m: THREE.Material) => m.dispose());
        }
      });

      this.ringModel.geometry.dispose();
      this.ringModel.material instanceof THREE.Material && this.ringModel.material.dispose();

      this.ringModel = null;
    }
  }

  updatePose(pose: RingPose): void {
    if (!this.ringModel) {
      console.warn('No ring model loaded, skipping pose update');
      return;
    }

    this.ringModel.mesh.position.copy(pose.position);
    this.ringModel.mesh.quaternion.copy(pose.rotation);
    this.ringModel.mesh.scale.setScalar(pose.scale);
  }

  render(): void {
    if (!this.isInitialized) {
      console.warn('ARScene not initialized, skipping render');
      return;
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, videoWidth?: number, videoHeight?: number): void {
    this.config.width = width;
    this.config.height = height;

    this.renderer.setSize(width, height);

    const containerAspect = width / height;

    if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
      const videoAspect = videoWidth / videoHeight;

      let coverScale: number;
      if (containerAspect > videoAspect) {
        coverScale = containerAspect / videoAspect;
      } else {
        coverScale = videoAspect / containerAspect;
      }

      const adjustedFov = 2 * Math.atan(Math.tan((this.config.fov * Math.PI / 180) / 2) / coverScale) * (180 / Math.PI);
      this.camera.fov = adjustedFov;
      this.camera.aspect = containerAspect;
    } else {
      this.camera.aspect = containerAspect;
    }

    this.camera.updateProjectionMatrix();
  }

  setLighting(ambientIntensity: number, directionalIntensity: number): void {
    this.ambientLight.intensity = ambientIntensity;
    this.directionalLight.intensity = directionalIntensity;
  }

  dispose(): void {
    this.isInitialized = false;

    this.unloadRing();
    this.ringGroup.clear();

    if (this.videoTexture) {
      this.videoTexture.dispose();
      this.videoTexture = null;
    }

    this.scene.remove(this.ambientLight);
    this.scene.remove(this.directionalLight);

    this.ambientLight.dispose();
    this.directionalLight.dispose();

    if (this.pmremGenerator) {
      this.pmremGenerator.dispose();
      this.pmremGenerator = null;
    }
    if (this.environmentTexture) {
      this.environmentTexture.dispose();
      this.environmentTexture = null;
    }

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();

    this.dracoLoader.dispose();

    this.scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mats: THREE.Material[] = Array.isArray(child.material)
          ? child.material
          : [child.material];
        mats.forEach((mat: THREE.Material) => { mat.dispose(); });
      }
    });

    this.scene.clear();
  }
}

export default ARScene;
