// FILE: src/utils/SecurityUtils.ts
export interface IntegrityManifestEntry { readonly sha384: string; readonly size: number }
export interface IntegrityManifest { readonly version: 1; readonly buildId: string; readonly assets: Readonly<Record<string, IntegrityManifestEntry>> }
export interface IntegrityVerificationResult { assetKey: string; expected: string; actual: string; verified: boolean }

function isEntry(value: unknown): value is IntegrityManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.sha384 === 'string' && /^sha384-[A-Za-z0-9+/]{64}$/.test(item.sha384) && Number.isSafeInteger(item.size) && Number(item.size) >= 0;
}
function parseManifest(value: unknown): IntegrityManifest {
  if (!value || typeof value !== 'object') throw new Error('Integrity manifest is not an object.');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.buildId !== 'string' || !item.assets || typeof item.assets !== 'object') throw new Error('Integrity manifest schema is invalid.');
  if (!Object.values(item.assets as Record<string, unknown>).every(isEntry)) throw new Error('Integrity manifest contains an invalid asset entry.');
  return item as unknown as IntegrityManifest;
}
function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
function assetKey(url: URL, baseUrl: URL): string {
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) throw new Error('Verified assets must be inside the application base path.');
  return decodeURIComponent(url.pathname.slice(baseUrl.pathname.length)).replace(/^\/+/, '');
}

export interface IntegrityDependencies {
  fetch: typeof fetch;
  digest: SubtleCrypto['digest'];
  createWorker(url: string, options?: WorkerOptions): Worker;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  baseUrl: URL;
}
function browserDependencies(): IntegrityDependencies {
  return { fetch: window.fetch.bind(window), digest: crypto.subtle.digest.bind(crypto.subtle), createWorker: (url, options) => new Worker(url, options), createObjectURL: URL.createObjectURL.bind(URL), revokeObjectURL: URL.revokeObjectURL.bind(URL), baseUrl: new URL(import.meta.env.BASE_URL, window.location.origin) };
}

export async function fetchVerifiedAsset(assetUrl: string | URL, dependencies = browserDependencies()): Promise<{ bytes: ArrayBuffer; result: IntegrityVerificationResult }> {
  const url = new URL(assetUrl, dependencies.baseUrl);
  const key = assetKey(url, dependencies.baseUrl);
  const manifestResponse = await dependencies.fetch(new URL('integrity-manifest.json', dependencies.baseUrl), { cache: 'no-store', credentials: 'same-origin' });
  if (!manifestResponse.ok) throw new Error(`Integrity manifest fetch failed: HTTP ${manifestResponse.status}`);
  const manifest = parseManifest(await manifestResponse.json());
  const expected = manifest.assets[key];
  if (!expected) throw new Error(`Integrity manifest has no exact entry for ${key}.`);
  const response = await dependencies.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Verified asset fetch failed for ${key}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expected.size) throw new Error(`Integrity size mismatch for ${key}: expected ${expected.size}, received ${bytes.byteLength}.`);
  const digest = new Uint8Array(await dependencies.digest('SHA-384', bytes));
  const actual = `sha384-${base64(digest)}`;
  const verified = timingSafeEqual(actual, expected.sha384);
  if (!verified) throw new Error(`SHA-384 integrity mismatch for ${key}.`);
  return { bytes, result: { assetKey: key, expected: expected.sha384, actual, verified } };
}

export async function createVerifiedWorker(workerUrl: string | URL, options?: WorkerOptions, dependencies = browserDependencies()): Promise<Worker> {
  const { bytes } = await fetchVerifiedAsset(workerUrl, dependencies);
  const blobUrl = dependencies.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try { return dependencies.createWorker(blobUrl, options); }
  finally { dependencies.revokeObjectURL(blobUrl); }
}

export async function createVerifiedAssetBlobUrl(assetUrl: string | URL, type: string): Promise<string> {
  const { bytes } = await fetchVerifiedAsset(assetUrl);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

export function assetUrl(path: string): string { return new URL(path.replace(/^\/+/, ''), new URL(import.meta.env.BASE_URL, window.location.origin)).toString(); }

export function assertLocalCameraPrivacy(video: HTMLVideoElement | null): void {
  const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
  stream?.getTracks().forEach((track) => track.stop());
  if (video) { video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load(); }
}
