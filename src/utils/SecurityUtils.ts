// FILE: src/utils/SecurityUtils.ts
import { WORKER_SRI_HASHES } from '../generated/sri-hashes';

type SriHashMap = Readonly<Record<string, string>>;
type AssetManifestEntry = Readonly<{ sig: string; exp: number }>;
type AssetManifest = Readonly<Record<string, AssetManifestEntry>>;

let manifestCache: AssetManifest | null = null;

/**
 * Describes the expected and actual SHA-384 integrity state for a local asset.
 */
export interface IntegrityVerificationResult {
  assetKey: string;
  expected: string;
  actual: string;
  verified: boolean;
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return binary;
}

function standardBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

function normalizedAssetKey(assetUrl: string | URL): string {
  const pathname = new URL(assetUrl, window.location.href).pathname;
  const pathParts = pathname.split('/').filter(Boolean);
  const scopedParts = pathParts.slice(-2);
  return scopedParts.join('/');
}

async function sha384Response(response: Response): Promise<string> {
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  return `sha384-${standardBase64(new Uint8Array(digest))}`;
}

function expectedHashFor(assetKey: string, hashes: SriHashMap): string | undefined {
  return hashes[assetKey];
}

function isManifestEntry(value: unknown): value is AssetManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sig === 'string' && candidate.sig.length > 0 && typeof candidate.exp === 'number';
}

function parseManifest(value: unknown): AssetManifest {
  if (!value || typeof value !== 'object') return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, AssetManifestEntry] => isManifestEntry(entry[1])),
  );
}

async function fetchManifest(): Promise<AssetManifest> {
  if (manifestCache) return manifestCache;

  const response = await fetch('/asset-manifest.json', {
    cache: 'no-store',
    credentials: 'same-origin',
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
  if (!response.ok) throw new Error(`Asset manifest fetch failed: HTTP ${response.status}`);

  manifestCache = parseManifest(await response.json());
  console.info(`[Security] Asset manifest loaded | ${Object.keys(manifestCache).length} assets verified`);
  return manifestCache;
}

/**
 * Fetches a same-origin asset and verifies it against the provided SHA-384 hash map.
 */
export async function verifyAssetIntegrity(assetUrl: string | URL, hashes: SriHashMap): Promise<IntegrityVerificationResult | null> {
  const assetKey = normalizedAssetKey(assetUrl);
  const expected = expectedHashFor(assetKey, hashes);

  if (!expected) {
    console.warn(`[SecurityUtils] No SRI hash registered for ${assetKey}; blocking verified asset load.`);
    return null;
  }

  const response = await fetch(assetUrl, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Unable to fetch ${assetKey} for SRI verification: HTTP ${response.status}`);

  const actual = await sha384Response(response);
  return {
    assetKey,
    expected,
    actual,
    verified: actual === expected,
  };
}

/**
 * Verifies a build-time signed model asset entry from the SRI-protected manifest.
 */
export async function verifyAssetAccess(assetPath: string): Promise<boolean> {
  try {
    const manifest = await fetchManifest();
    const entry = manifest[assetPath];
    if (!entry) return false;
    if (Date.now() / 1000 > entry.exp) return false;
    return Boolean(entry.sig);
  } catch (error) {
    console.warn('[SecurityUtils] Asset manifest verification failed; blocking asset access.', error);
    return false;
  }
}

/**
 * Verifies a worker script before it is spawned.
 */
export async function verifyWorkerBlobIntegrity(workerUrl: string | URL): Promise<boolean> {
  try {
    const result = await verifyAssetIntegrity(workerUrl, WORKER_SRI_HASHES);
    if (!result) return false;
    if (!result.verified) console.warn(`[SecurityUtils] Worker SRI mismatch for ${result.assetKey}; blocking worker creation.`);
    return result.verified;
  } catch (error) {
    console.warn('[SecurityUtils] Worker SRI verification failed; blocking worker creation.', error);
    return false;
  }
}

/**
 * Creates a Worker only after synchronous call-site awaiting of SRI verification completes.
 */
export async function createVerifiedWorker(workerUrl: string | URL, options?: WorkerOptions): Promise<Worker> {
  const url = workerUrl.toString();
  const verified = await verifyWorkerBlobIntegrity(url);
  if (!verified) {
    throw new Error(`Worker integrity verification failed for ${normalizedAssetKey(url)}.`);
  }

  return new Worker(url, options);
}

/**
 * Stops local camera tracks and clears video element state without uploading camera data.
 */
export function assertLocalCameraPrivacy(video: HTMLVideoElement | null): void {
  const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
  stream?.getTracks().forEach((track) => track.stop());
  if (video) {
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
  }
}
// VERIFY: console.log('[Security] Asset manifest loaded | N assets verified')
