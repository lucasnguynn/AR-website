import { MODEL_SRI_HASHES, WORKER_SRI_HASHES } from '../generated/sri-hashes';

const ASSET_PATTERN = /\.(?:glb|gltf|ktx2|hdr|bin|js|mjs)$/i;

type SriHashMap = Readonly<Record<string, string>>;

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

export async function verifiedAssetFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input, window.location.href) : new URL(input.url);
  if (!ASSET_PATTERN.test(url.pathname)) return fetch(input, init);

  const result = await verifyAssetIntegrity(url, MODEL_SRI_HASHES);
  if (!result?.verified) throw new Error(`Asset integrity verification failed for ${normalizedAssetKey(url)}.`);

  return fetch(url, { ...init, credentials: 'same-origin', referrerPolicy: 'strict-origin-when-cross-origin' });
}

export function createVerifiedWorker(workerUrl: string | URL, options?: WorkerOptions): Worker {
  const url = workerUrl.toString();
  const worker = new Worker(url, options);

  if (import.meta.env.DEV) return worker;

  void verifyWorkerBlobIntegrity(url).then((verified) => {
    if (!verified) worker.terminate();
  });

  return worker;
}

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
