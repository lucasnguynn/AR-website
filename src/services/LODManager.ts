import * as THREE from 'three';

export type LODLevel = 'high' | 'medium' | 'low';

export interface LODAssetSet {
  high: THREE.Object3D;
  medium: THREE.Object3D;
  low: THREE.Object3D;
}

export interface LODManagerOptions {
  fadeMs?: number;
  highThreshold?: number;
  mediumThreshold?: number;
}

const DEFAULT_FADE_MS = 180;
const DEFAULT_HIGH_THRESHOLD = 0.25;
const DEFAULT_MEDIUM_THRESHOLD = 0.10;

export class LODManager {
  private readonly levels: LODAssetSet;
  private readonly fadeMs: number;
  private readonly highThreshold: number;
  private readonly mediumThreshold: number;
  private activeLevel: LODLevel = 'high';
  private transitionStartedAt = 0;
  private transitionFrom: LODLevel | null = null;

  constructor(levels: LODAssetSet, options: LODManagerOptions = {}) {
    this.levels = levels;
    this.fadeMs = Math.min(options.fadeMs ?? DEFAULT_FADE_MS, 199);
    this.highThreshold = options.highThreshold ?? DEFAULT_HIGH_THRESHOLD;
    this.mediumThreshold = options.mediumThreshold ?? DEFAULT_MEDIUM_THRESHOLD;
    this.prepareLevelMaterials();
    this.setLevelVisibility('high', 1);
  }

  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, object = this.levels[this.activeLevel]): LODLevel {
    const next = this.pickLevel(this.screenSpaceSize(camera, renderer, object));
    const now = performance.now();

    if (next !== this.activeLevel) {
      this.transitionFrom = this.activeLevel;
      this.activeLevel = next;
      this.transitionStartedAt = now;
      this.setLevelVisibility(next, 0);
    }

    this.applyCrossfade(now);
    return this.activeLevel;
  }

  pickLevel(screenSpaceSize: number): LODLevel {
    if (screenSpaceSize > this.highThreshold) return 'high';
    if (screenSpaceSize >= this.mediumThreshold) return 'medium';
    return 'low';
  }

  private screenSpaceSize(camera: THREE.Camera, renderer: THREE.WebGLRenderer, object: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(object);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const viewport = new THREE.Vector2();
    renderer.getSize(viewport);

    if (sphere.radius <= 0 || viewport.y <= 0) return 0;
    if (!(camera instanceof THREE.PerspectiveCamera)) return Math.min(1, (sphere.radius * 2) / viewport.y);

    const distance = Math.max(camera.position.distanceTo(sphere.center), 0.0001);
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
    return Math.min(1, (sphere.radius * 2) / visibleHeight);
  }

  private applyCrossfade(now: number): void {
    const progress = this.transitionFrom ? Math.min(1, (now - this.transitionStartedAt) / this.fadeMs) : 1;
    this.setLevelVisibility(this.activeLevel, progress);

    if (this.transitionFrom) {
      this.setLevelVisibility(this.transitionFrom, 1 - progress);
      if (progress >= 1) {
        this.setLevelVisibility(this.transitionFrom, 0);
        this.transitionFrom = null;
      }
    }
  }

  private setLevelVisibility(level: LODLevel, opacity: number): void {
    const object = this.levels[level];
    object.visible = opacity > 0;
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.filter(Boolean).forEach((material) => {
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.needsUpdate = true;
      });
    });
  }

  private prepareLevelMaterials(): void {
    (Object.values(this.levels) as THREE.Object3D[]).forEach((object) => {
      object.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.filter(Boolean).forEach((material) => {
          material.depthWrite = true;
        });
      });
    });
  }
}
