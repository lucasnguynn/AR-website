export interface PremiumAssetRequest {
  url: string;
  audience?: string;
  ttlSeconds?: number;
  userScope?: string;
}

const encoder = new TextEncoder();
const PREMIUM_ASSET_PATTERN = /\.(glb|gltf|ktx2|hdr|bin|webp|png|jpg|jpeg)$/i;
const MAX_TTL_SECONDS = 300;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
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
