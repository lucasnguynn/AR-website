// FILE: src/materials/causticTexture.ts
import * as THREE from 'three';

/** Options for the deterministic procedural Voronoi caustic generator. */
export interface CausticTextureOptions {
  /** Texture width and height in pixels. */
  readonly size?: number;
  /** Number of Voronoi cells across the generated tile. */
  readonly cells?: number;
  /** Deterministic seed used by the hash lattice. */
  readonly seed?: number;
  /** Output contrast exponent. */
  readonly contrast?: number;
}

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function voronoiCaustic(u: number, v: number, cells: number, seed: number): number {
  const gx = u * cells;
  const gy = v * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let nearest = 8;
  let secondNearest = 8;

  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const cx = ix + ox;
      const cy = iy + oy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx + 19.19, cy - 7.31, seed);
      const dx = gx - px;
      const dy = gy - py;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < nearest) {
        secondNearest = nearest;
        nearest = distance;
      } else if (distance < secondNearest) {
        secondNearest = distance;
      }
    }
  }

  const ridge = 1 - smoothstep(0.015, 0.22, Math.abs(secondNearest - nearest));
  const sparkle = 1 - smoothstep(0.02, 0.42, nearest);
  return Math.min(1, ridge * 0.82 + sparkle * 0.28);
}

/** Creates a 512×512 deterministic RGBA Voronoi texture for gemstone caustic pass sampling. */
export function createCausticTexture(options: CausticTextureOptions = {}): THREE.DataTexture {
  const size = Math.max(16, Math.floor(options.size ?? 512));
  const cells = Math.max(2, options.cells ?? 28);
  const seed = options.seed ?? 11.37;
  const contrast = Math.max(0.25, options.contrast ?? 1.85);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const primary = voronoiCaustic(u, v, cells, seed);
      const secondary = voronoiCaustic(u + 0.037, v - 0.021, cells * 0.73, seed + 3.1);
      const tertiary = voronoiCaustic(u - 0.061, v + 0.049, cells * 1.41, seed + 8.7);
      const value = Math.pow(Math.min(1, primary * 0.62 + secondary * 0.25 + tertiary * 0.13), contrast);
      const i = (y * size + x) * 4;
      data[i] = Math.round(value * 185);
      data[i + 1] = Math.round(value * 226);
      data[i + 2] = Math.round(value * 255);
      data[i + 3] = Math.round(value * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'ProceduralGemstoneVoronoiCaustics512';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// VERIFY: console.log('[Caustics] 512x512 deterministic Voronoi texture ready');
