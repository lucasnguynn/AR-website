import * as THREE from 'three';

type MaterialWithGltfExtensions = THREE.Material & {
  userData: {
    gltfExtensions?: {
      KHR_materials_variants?: {
        mappings?: Array<{
          material?: THREE.Material;
          variants?: Array<{ name?: string }>;
        }>;
      };
    };
  };
};

export interface VariantTextureSet {
  readonly map?: THREE.Texture | null;
  readonly normalMap?: THREE.Texture | null;
  readonly roughnessMap?: THREE.Texture | null;
  readonly metalnessMap?: THREE.Texture | null;
  readonly aoMap?: THREE.Texture | null;
  readonly emissiveMap?: THREE.Texture | null;
  readonly envMapIntensity?: number;
  readonly color?: THREE.ColorRepresentation;
  readonly metalness?: number;
  readonly roughness?: number;
}

interface VariantBinding {
  readonly mesh: THREE.Mesh | THREE.InstancedMesh;
  readonly slot: number;
  readonly baseMaterial: THREE.MeshStandardMaterial;
  readonly variants: Map<string, THREE.MeshStandardMaterial>;
  active: string;
  frontBuffer: THREE.MeshStandardMaterial;
  backBuffer: THREE.MeshStandardMaterial;
}

const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;

export class VariantManager {
  private readonly bindings: VariantBinding[] = [];
  private readonly warmTextureCache = new Map<string, Promise<THREE.Texture>>();
  private readonly loader: THREE.TextureLoader;

  constructor(private readonly root: THREE.Object3D, loadingManager?: THREE.LoadingManager) {
    this.loader = new THREE.TextureLoader(loadingManager);
    this.indexVariants(root);
    this.enableGpuInstancingHints(root);
  }

  get variantNames(): string[] {
    const names = new Set<string>();
    this.bindings.forEach((binding) => binding.variants.forEach((_material, name) => names.add(name)));
    return [...names].sort();
  }

  async preloadTextureSet(name: string, textures: Record<string, VariantTextureSet>): Promise<void> {
    const set = textures[name];
    if (!set) return;
    await Promise.all(TEXTURE_KEYS.map(async (key) => {
      const value = set[key];
      const src = typeof value?.image === 'object' && value.image && 'src' in value.image ? String(value.image.src) : '';
      if (!src) return;
      await this.loadTexture(src);
    }));
  }

  applyVariant(name: string): boolean {
    let applied = false;

    for (const binding of this.bindings) {
      const next = binding.variants.get(name);
      if (!next || binding.active === name) continue;

      this.copyMaterialIntoBackBuffer(binding.backBuffer, next);
      this.swapMaterial(binding, binding.backBuffer);
      const oldFront = binding.frontBuffer;
      binding.frontBuffer = binding.backBuffer;
      binding.backBuffer = oldFront;
      binding.active = name;
      applied = true;
    }

    return applied;
  }

  applyTextureSet(name: string, set: VariantTextureSet): boolean {
    let applied = false;

    for (const binding of this.bindings) {
      this.copyMaterialIntoBackBuffer(binding.backBuffer, binding.frontBuffer);
      for (const key of TEXTURE_KEYS) {
        const texture = set[key];
        if (texture !== undefined) {
          binding.backBuffer[key] = texture ?? null;
          texture && this.prepareTexture(texture);
        }
      }
      if (set.color !== undefined) binding.backBuffer.color.set(set.color);
      if (set.metalness !== undefined) binding.backBuffer.metalness = set.metalness;
      if (set.roughness !== undefined) binding.backBuffer.roughness = set.roughness;
      if (set.envMapIntensity !== undefined) binding.backBuffer.envMapIntensity = set.envMapIntensity;
      binding.backBuffer.needsUpdate = true;
      this.swapMaterial(binding, binding.backBuffer);
      const oldFront = binding.frontBuffer;
      binding.frontBuffer = binding.backBuffer;
      binding.backBuffer = oldFront;
      binding.active = name;
      applied = true;
    }

    return applied;
  }

  dispose(): void {
    const disposed = new Set<THREE.Material>();
    for (const binding of this.bindings) {
      [binding.frontBuffer, binding.backBuffer].forEach((material) => {
        if (!disposed.has(material)) {
          material.dispose();
          disposed.add(material);
        }
      });
    }
    this.bindings.length = 0;
  }

  private indexVariants(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh | THREE.InstancedMesh;
      if (!mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      materials.forEach((material, slot) => {
        if (!(material instanceof THREE.MeshStandardMaterial)) return;
        const variants = this.extractVariants(material as MaterialWithGltfExtensions);
        if (variants.size === 0) return;
        const frontBuffer = material.clone();
        const backBuffer = material.clone();
        const binding: VariantBinding = { mesh, slot, baseMaterial: material, variants, active: 'base', frontBuffer, backBuffer };
        this.swapMaterial(binding, frontBuffer);
        this.bindings.push(binding);
      });
    });
  }

  private extractVariants(material: MaterialWithGltfExtensions): Map<string, THREE.MeshStandardMaterial> {
    const variants = new Map<string, THREE.MeshStandardMaterial>();
    const mappings = material.userData.gltfExtensions?.KHR_materials_variants?.mappings ?? [];
    for (const mapping of mappings) {
      if (!(mapping.material instanceof THREE.MeshStandardMaterial)) continue;
      for (const variant of mapping.variants ?? []) {
        if (variant.name) variants.set(variant.name, mapping.material);
      }
    }
    return variants;
  }

  private copyMaterialIntoBackBuffer(target: THREE.MeshStandardMaterial, source: THREE.MeshStandardMaterial): void {
    target.copy(source);
    TEXTURE_KEYS.forEach((key) => {
      const texture = target[key];
      if (texture) this.prepareTexture(texture);
    });
    target.needsUpdate = true;
  }

  private swapMaterial(binding: Pick<VariantBinding, 'mesh' | 'slot'>, material: THREE.MeshStandardMaterial): void {
    if (Array.isArray(binding.mesh.material)) {
      binding.mesh.material[binding.slot] = material;
    } else {
      binding.mesh.material = material;
    }
  }

  private prepareTexture(texture: THREE.Texture): void {
    texture.colorSpace = texture === (texture as THREE.Texture) ? texture.colorSpace : THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }

  private loadTexture(url: string): Promise<THREE.Texture> {
    const cached = this.warmTextureCache.get(url);
    if (cached) return cached;
    const promise = this.loader.loadAsync(url).then((texture) => {
      this.prepareTexture(texture);
      return texture;
    });
    this.warmTextureCache.set(url, promise);
    return promise;
  }

  private enableGpuInstancingHints(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
    });
  }
}
