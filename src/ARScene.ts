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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';
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
  mesh: THREE.Mesh;
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
  
  // Background video
  private videoElement: HTMLVideoElement | null = null;
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
    
    // Configure renderer with enterprise-grade settings
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
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
    
    this.videoElement = video;
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    
    // Set video as scene background
    this.scene.background = this.videoTexture;
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
   * @returns Promise that resolves when model is loaded
   */
  async loadRing(url: string, scale: number = 1.0): Promise<void> {
    return new Promise((resolve, reject) => {
      // Cleanup existing model
      this.unloadRing();
      
      this.gltfLoader.load(
        url,
        (gltf) => {
          try {
            // Extract the main mesh from GLTF
            let mesh: THREE.Mesh | null = null;
            
            gltf.scene.traverse((child) => {
              if (child instanceof THREE.Mesh && !mesh) {
                mesh = child;
              }
            });
            
            if (!mesh) {
              throw new Error('No mesh found in GLTF model');
            }
            
            // Clone geometry and material for safe disposal
            const geometry = mesh.geometry.clone();
            const material = Array.isArray(mesh.material)
              ? mesh.material.map(m => m.clone())
              : mesh.material.clone();
            
            // Create new mesh with cloned resources
            const newMesh = new THREE.Mesh(geometry, material);
            newMesh.castShadow = true;
            newMesh.receiveShadow = true;
            
            // Apply initial scale
            newMesh.scale.setScalar(scale);
            
            // Store model reference
            this.ringModel = {
              mesh: newMesh,
              geometry,
              material,
              texture: material instanceof THREE.MeshStandardMaterial
                ? material.map ?? undefined
                : undefined,
            };
            
            // Add to scene
            this.ringGroup.add(newMesh);
            
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        (progress) => {
          // Loading progress callback
          if (progress.total > 0) {
            const percent = (progress.loaded / progress.total) * 100;
            console.log(`Ring model loading: ${percent.toFixed(2)}%`);
          }
        },
        (error) => {
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
      
      // Dispose geometry
      this.ringModel.geometry.dispose();
      
      // Dispose materials
      if (Array.isArray(this.ringModel.material)) {
        this.ringModel.material.forEach(mat => mat.dispose());
      } else {
        this.ringModel.material.dispose();
      }
      
      // Dispose texture if exists
      if (this.ringModel.texture) {
        this.ringModel.texture.dispose();
      }
      
      this.ringModel = null;
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
   * Resize the rendering canvas
   */
  resize(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
    
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
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
    
    // Dispose renderer
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    
    // Dispose DRACO loader
    this.dracoLoader.dispose();
    
    // Clear scene
    this.scene.clear();
    
    // Nullify references
    this.videoElement = null;
  }
}

export default ARScene;
