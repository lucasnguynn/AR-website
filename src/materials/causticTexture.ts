import * as THREE from 'three';

export interface CausticTextureOptions {
  size?: number;
  cells?: number;
  seed?: number;
  contrast?: number;
}

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
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
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearest) {
        secondNearest = nearest;
        nearest = d;
      } else if (d < secondNearest) {
        secondNearest = d;
      }
    }
  }

  const ridge = Math.max(0, 1 - Math.abs(secondNearest - nearest) * 9.5);
  const sparkle = Math.max(0, 1 - nearest * 2.35);
  return Math.min(1, ridge * 0.78 + sparkle * 0.32);
}

export function createCausticTexture(options: CausticTextureOptions = {}): THREE.DataTexture {
  const size = Math.max(16, Math.floor(options.size ?? 256));
  const cells = Math.max(2, options.cells ?? 18);
  const seed = options.seed ?? 11.37;
  const contrast = Math.max(0.25, options.contrast ?? 1.65);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const a = voronoiCaustic(u, v, cells, seed);
      const b = voronoiCaustic(u + 0.037, v - 0.021, cells * 0.73, seed + 3.1);
      const value = Math.pow(Math.min(1, a * 0.72 + b * 0.28), contrast);
      const i = (y * size + x) * 4;
      data[i] = Math.round(value * 165);
      data[i + 1] = Math.round(value * 218);
      data[i + 2] = Math.round(value * 255);
      data[i + 3] = Math.round(value * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'ProceduralGemstoneVoronoiCaustics';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
