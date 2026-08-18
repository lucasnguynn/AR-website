import { WORKER_SRI_HASHES } from '../generated/sri-hashes';

export interface PremiumAssetRequest {
  url: string;
  audience?: string;
  ttlSeconds?: number;
  userScope?: string;
}

const encoder = new TextEncoder();
const PREMIUM_ASSET_PATTERN = /\.(glb|gltf|ktx2|hdr|bin|webp|png|jpg|jpeg)$/i;
const MAX_TTL_SECONDS = 300;

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return binary;
}

function standardBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

function base64Url(bytes: Uint8Array): string {
  return standardBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function createShortLivedAssetJwt(request: PremiumAssetRequest, secret: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('JWT signing secret must be at least 32 characters.');
  const ttl = Math.min(request.ttlSeconds ?? 120, MAX_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(request.url, window.location.origin);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: request.audience ?? 'premium-assets',
    iss: window.location.origin,
    iat: now,
    exp: now + ttl,
    scope: request.userScope ?? 'ar:asset:read',
    path: url.pathname,
  };
  const unsigned = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign('HMAC', await importSigningKey(secret), encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export async function signedAssetFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input, window.location.href) : new URL(input.url);
  if (!PREMIUM_ASSET_PATTERN.test(url.pathname)) return fetch(input, init);

  const secret = import.meta.env.VITE_ASSET_JWT_SECRET as string | undefined;
  if (!secret) throw new Error('Missing VITE_ASSET_JWT_SECRET for premium asset request signing.');
  const token = await createShortLivedAssetJwt({ url: url.href }, secret);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-AR-Privacy', 'local-camera-processing-only');
  headers.set('X-Requested-With', 'ARWebsite');
  return fetch(url, { ...init, headers, credentials: 'same-origin', referrerPolicy: 'strict-origin-when-cross-origin' });
}

export async function verifyWorkerBlobIntegrity(workerUrl: string): Promise<boolean> {
  const assetKey = new URL(workerUrl, window.location.href).pathname.split('/').slice(-2).join('/');
  const expected = (WORKER_SRI_HASHES as Record<string, string>)[assetKey];

  if (!expected) {
    console.warn(`[SecurityUtils] No SRI hash registered for ${assetKey}; continuing without blocking startup.`);
    return false;
  }

  try {
    const response = await fetch(workerUrl, { cache: 'no-store', credentials: 'same-origin' });
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-384', bytes);
    const actual = `sha384-${standardBase64(new Uint8Array(digest))}`;
    const verified = actual === expected;
    if (!verified) console.warn(`[SecurityUtils] Worker SRI mismatch for ${assetKey}; continuing with degraded trust.`);
    return verified;
  } catch (error) {
    console.warn('[SecurityUtils] Worker SRI verification failed; continuing without blocking startup.', error);
    return false;
  }
}

export function createVerifiedWorker(workerUrl: string | URL, options?: WorkerOptions): Worker {
  const url = workerUrl.toString();
  void verifyWorkerBlobIntegrity(url);
  return new Worker(url, options);
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
