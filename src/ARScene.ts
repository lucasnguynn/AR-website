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
// @fix BUG-05: PMREMGenerator is in Three.js core since r130. Import from 'three' instead of examples path.
import { PMREMGenerator } from 'three';
// @fix BUG-11: Import RoomEnvironment for fallback environment when HDRI fails
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RingPose } from './RingPoseEstimator';

/**
 * Configuration for the AR scene
 */
export interface ARSceneConfig {
  /** Width of the rendering canvas */
  width: number;
  /** Height of the rendering canvas */
  height: number;
  /** Path to Draco WASM binaries */
  dracoPath: string;
  /** Near clipping plane */
  near: number;
  /** Far clipping plane */
  far: number;
  /** Field of view in degrees */
  fov: number;
}

/**
 * Default scene configuration
 */
const DEFAULT_CONFIG: ARSceneConfig = {
  width: 1280,
  height: 720,
  dracoPath: 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
  near: 1,
  far: 1000,
  fov: 50,
};

/**
 * Loaded ring model with its mesh reference
 */
interface LoadedRingModel {
  mesh: THREE.Object3D;  // Supports both Mesh and Group for multi-mesh models
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  texture?: THREE.Texture;
}

/**
 * AR Scene Class
 * 
 * Manages the Three.js rendering environment for AR ring try-on:
 * - Renderer withACESFilmicToneMapping and SRGBColorSpace
 * - Perspective camera synchronized with video feed
 * - Lighting setup (ambient + directional)
 * - Background video texture
 * - DRACO-compressed GLTF model loading
 * - Pose-based ring positioning
 * - Memory-safe resource disposal
 */
export class ARScene {
  private config: ARSceneConfig;
  
  // Core Three.js objects
  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  
  // Lighting
  private ambientLight: THREE.AmbientLight;
  private directionalLight: THREE.DirectionalLight;
  private pmremGenerator: PMREMGenerator | null = null;
  private environmentTexture: THREE.Texture | null = null;
  
  // Background video
  private videoTexture: THREE.VideoTexture | null = null;
  
  // Ring model
  private ringModel: LoadedRingModel | null = null;
  private ringGroup: THREE.Group;
  
  // Loaders
  private gltfLoader: GLTFLoader;
  private dracoLoader: DRACOLoader;
  
  // State
  private isInitialized: boolean = false;

  constructor(config: Partial<ARSceneConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize Three.js core
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.config.fov,
      this.config.width / this.config.height,
      this.config.near,
      this.config.far
    );
    
    // Initialize renderer with preserveDrawingBuffer: true for snapshot support
    // @fix BUG-08: preserveDrawingBuffer must be true to prevent black snapshots
    // NOTE: This has a ~10-15% performance cost but is acceptable for jewelry try-on UX
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    
    // Set renderer properties for high-fidelity rendering
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.config.width, this.config.height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    // Setup lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.ambientLight);
    
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.directionalLight.position.set(5, 10, 7);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 1024;
    this.directionalLight.shadow.mapSize.height = 1024;
    this.scene.add(this.directionalLight);
    
    // Initialize PMREMGenerator for HDRI environment mapping
    this.pmremGenerator = new PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();
    
    // Load HDRI environment map for realistic metallic/refractive materials
    // @fix BUG-11: Add error handler and fallback to RoomEnvironment when HDRI fails
    // @fix BUG-HDR-01: Use Poly Haven CDN (CC0, rate-limit-free) instead of GitHub raw URL
    // Provide array of HDRI sources for redundancy
    const hdriSources = [
      'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/royal_esplanade_1k.hdr',
      '/hdri/royal_esplanade_1k.hdr',  // Local fallback
    ];
    
    const loadHDRI = async (sources: string[], index: number): Promise<void> => {
      if (index >= sources.length) {
        // All sources failed, use procedural RoomEnvironment fallback
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
      console.log(`Attempting to load HDRI from: ${currentSource}`);
      
      new RGBELoader().load(
        currentSource,
        (texture: THREE.DataTexture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.environmentTexture = this.pmremGenerator!.fromEquirectangular(texture).texture;
          this.scene.environment = this.environmentTexture;
          if (!this.videoTexture) {
            this.scene.background = this.environmentTexture;
          }
          texture.dispose();
          console.log(`HDRI loaded successfully from: ${currentSource}`);
        },
        undefined, // onProgress not needed
        (error: unknown) => {
          console.warn(`HDRI load failed from ${currentSource}:`, error);
          // Try next source
          loadHDRI(sources, index + 1);
        }
      );
    };
    
    loadHDRI(hdriSources, 0);
    
    // Initialize ring group
    this.ringGroup = new THREE.Group();
    this.scene.add(this.ringGroup);
    
    // Setup DRACO loader
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(this.config.dracoPath);
    this.dracoLoader.setDecoderConfig({ type: 'js' });
    
    // Setup GLTF loader with DRACO
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    
    this.isInitialized = true;
  }

  /**
   * Get the renderer's DOM element
   */
  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Set the video element for background rendering
   */
  setVideoElement(video: HTMLVideoElement): void {
    // Cleanup existing texture
    if (this.videoTexture) {
      this.videoTexture.dispose();
    }
    
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    
    // Set video as scene background (overrides HDRI environment background)
    this.scene.background = this.videoTexture;
  }

  /**
   * Get the environment texture for snapshot compositing
   */
  getEnvironmentTexture(): THREE.Texture | null {
    return this.environmentTexture;
  }

  /**
   * Update camera parameters to match video feed
   */
  updateCameraParams(fov: number, aspect: number, near: number, far: number): void {
    this.camera.fov = fov;
    this.camera.aspect = aspect;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Load a ring model from URL
   * 
   * Supports GLTF/GLB formats with DRACO compression
   * 
   * @param url - URL to the 3D model file
   * @param scale - Initial scale factor for the ring
   * @param onProgress - Optional callback for loading progress (0-100)
   * @returns Promise that resolves when model is loaded
   */
  async loadRing(url: string, scale: number = 1.0, onProgress?: (progress: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // Cleanup existing model
      this.unloadRing();
      
      this.gltfLoader.load(
        url,
        (gltf: GLTF) => {
          try {
            // Clone the entire GLTF scene to allow independent disposal
            // Using gltf.scene directly preserves all meshes (band, gemstone, etc.)
            const modelGroup = gltf.scene.clone(true)  // deep clone
            
            // Apply initial scale to the group
            modelGroup.scale.setScalar(scale)
            
            // Enable shadows on all meshes within the group
            modelGroup.traverse((child: THREE.Object3D) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true
                child.receiveShadow = true
                // Apply environment map to all standard materials
                if (child.material instanceof THREE.MeshStandardMaterial) {
                  child.material.envMapIntensity = 1.0
                  child.material.needsUpdate = true
                }
              }
            })
            
            // Store reference as a special "group model"
            // We repurpose LoadedRingModel by storing the group as the mesh property
            // TypeScript: store as THREE.Object3D cast, we only use .position/.quaternion/.scale
            this.ringModel = {
              mesh: modelGroup as unknown as THREE.Mesh,
              geometry: new THREE.BufferGeometry(),  // placeholder, not used for groups
              material: new THREE.MeshBasicMaterial(), // placeholder, not used for groups
            }
            
            this.ringGroup.add(modelGroup)
            resolve()
          } catch (error) {
            reject(error)
          }
        },
        (progress: ProgressEvent) => {
          // Loading progress callback
          if (progress.total > 0 && onProgress) {
            const percent = (progress.loaded / progress.total) * 100;
            onProgress(percent);
          }
        },
        (error: unknown) => {
          reject(error);
        }
      );
    });
  }

  /**
   * Unload the current ring model and free resources
   */
  unloadRing(): void {
    if (this.ringModel) {
      // Remove from scene
      this.ringGroup.remove(this.ringModel.mesh);
      
      // Traverse and dispose all child geometries and materials
      this.ringModel.mesh.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const mats = Array.isArray(child.material) 
            ? child.material 
            : [child.material]
          mats.forEach((m: THREE.Material) => m.dispose())
        }
      })
      
      // Dispose the placeholder geometry/material
      this.ringModel.geometry.dispose()
      this.ringModel.material instanceof THREE.Material && this.ringModel.material.dispose()
      
      this.ringModel = null
    }
  }

  /**
   * Update ring position and rotation based on pose estimation
   */
  updatePose(pose: RingPose): void {
    if (!this.ringModel) {
      console.warn('No ring model loaded, skipping pose update');
      return;
    }
    
    // Apply position
    this.ringModel.mesh.position.copy(pose.position);
    
    // Apply rotation
    this.ringModel.mesh.quaternion.copy(pose.rotation);
    
    // Apply scale
    this.ringModel.mesh.scale.setScalar(pose.scale);
  }

  /**
   * Render the scene
   */
  render(): void {
    if (!this.isInitialized) {
      console.warn('ARScene not initialized, skipping render');
      return;
    }
    
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Resize the rendering canvas and adjust camera for object-cover alignment
   * 
   * When CSS object-cover is used on the video element, the visible portion of the video
   * is scaled to fill the container while maintaining aspect ratio. This causes a mismatch
   * between the MediaPipe coordinates (which operate on raw video dimensions) and the
   * Three.js projection.
   * 
   * To fix this, we calculate the "cover" scale factors and adjust the camera's FOV
   * accordingly so that the 3D scene scales identically to how CSS object-cover scales the video.
   * 
   * @param width - Container width (from getBoundingClientRect)
   * @param height - Container height (from getBoundingClientRect)
   * @param videoWidth - Raw video intrinsic width
   * @param videoHeight - Raw video intrinsic height
   */
  resize(width: number, height: number, videoWidth?: number, videoHeight?: number): void {
    this.config.width = width;
    this.config.height = height;
    
    this.renderer.setSize(width, height);
    
    // Calculate aspect ratios
    const containerAspect = width / height;
    
    if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
      // Raw video aspect ratio
      const videoAspect = videoWidth / videoHeight;
      
      // Calculate the "cover" scale factor
      // CSS object-cover scales the video to fill the container while maintaining aspect ratio
      // If container is wider than video: video is scaled by containerAspect/videoAspect
      // If container is taller than video: video is scaled by videoAspect/containerAspect
      
      let coverScale: number;
      if (containerAspect > videoAspect) {
        // Container is wider - video scales to fit width, height overflows (cropped top/bottom)
        coverScale = containerAspect / videoAspect;
      } else {
        // Container is taller - video scales to fit height, width overflows (cropped sides)
        coverScale = videoAspect / containerAspect;
      }
      
      // Adjust the camera FOV to compensate for object-cover scaling
      // We need to effectively "zoom in" by the coverScale factor
      // The effective FOV becomes smaller (more zoomed) as coverScale increases
      const adjustedFov = 2 * Math.atan(Math.tan((this.config.fov * Math.PI / 180) / 2) / coverScale) * (180 / Math.PI);
      
      this.camera.fov = adjustedFov;
      this.camera.aspect = containerAspect;
    } else {
      // Fallback: no video dimensions provided, use simple container aspect
      this.camera.aspect = containerAspect;
    }
    
    this.camera.updateProjectionMatrix();
  }

  /**
   * Update lighting intensity
   */
  setLighting(ambientIntensity: number, directionalIntensity: number): void {
    this.ambientLight.intensity = ambientIntensity;
    this.directionalLight.intensity = directionalIntensity;
  }

  /**
   * Cleanup all resources to prevent memory leaks
   */
  dispose(): void {
    this.isInitialized = false;
    
    // Unload ring model
    this.unloadRing();
    
    // Dispose ring group
    this.ringGroup.clear();
    
    // Dispose video texture
    if (this.videoTexture) {
      this.videoTexture.dispose();
      this.videoTexture = null;
    }
    
    // Remove lights
    this.scene.remove(this.ambientLight);
    this.scene.remove(this.directionalLight);
    
    // Dispose lights
    this.ambientLight.dispose();
    this.directionalLight.dispose();
    
    // Dispose PMREMGenerator and environment texture
    if (this.pmremGenerator) {
      this.pmremGenerator.dispose();
      this.pmremGenerator = null;
    }
    if (this.environmentTexture) {
      this.environmentTexture.dispose();
      this.environmentTexture = null;
    }
    
    // Dispose renderer
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    
    // Dispose DRACO loader
    this.dracoLoader.dispose();
    
    // Traverse and dispose every Mesh still in the scene before wiping it.
    // This catches any geometry / material that is not tracked by ringModel
    // (e.g. additional GLTF children, debug helpers added at runtime).
    // instanceof THREE.Mesh is the required type guard — accessing .material
    // on a bare THREE.Object3D is illegal; the guard narrows to THREE.Mesh
    // whose .material is typed as THREE.Material | THREE.Material[].
    this.scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();

        // Normalise Material | Material[] to a flat array so every material
        // is disposed with a single, type-safe forEach.
        const mats: THREE.Material[] = Array.isArray(child.material)
          ? child.material
          : [child.material];

        mats.forEach((mat: THREE.Material) => { mat.dispose(); });
      }
    });

    // Clear scene
    this.scene.clear();
  }
}

export default ARScene;
