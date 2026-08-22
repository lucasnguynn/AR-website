import { createHash } from 'node:crypto';

function normalizeBase(target) {
  const url = new URL(target);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function metaCspFromHtml(html) {
  const tag = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
  if (!tag) return '';
  return tag.match(/\bcontent="([^"]*)"/i)?.[1]
    ?? tag.match(/\bcontent='([^']*)'/i)?.[1]
    ?? '';
}

function assertMetaCsp(csp) {
  const required = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ];

  for (const directive of required) {
    if (!csp.includes(directive)) {
      throw new Error(`Deployed HTML meta CSP is missing: ${directive}`);
    }
  }

  const networkDirectives = csp.match(/(?:script|worker|connect)-src[^;]*/g)?.join(';') ?? '';
  if (/https?:|\*/.test(networkDirectives)) {
    throw new Error('Deployed HTML meta CSP allows a remote executable/network origin or wildcard.');
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

function sha384(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

const target = process.argv[2];
if (!target) {
  throw new Error('Usage: node scripts/verify-pages-deployment.mjs <github-pages-url>');
}

const base = normalizeBase(target);
const pageResponse = await fetch(base, { cache: 'no-store', redirect: 'follow' });
if (!pageResponse.ok) throw new Error(`GitHub Pages root returned HTTP ${pageResponse.status}`);

const html = await pageResponse.text();
const metaCsp = metaCspFromHtml(html);
if (!metaCsp) throw new Error('Deployed HTML does not contain the reviewed Content-Security-Policy meta tag.');
assertMetaCsp(metaCsp);

// GitHub Pages does not consume repository `_headers` files as hosting config.
// Record response-header presence as evidence, but do not falsely fail the release
// when platform-managed headers cannot be configured by this repository.
for (const header of ['content-security-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
  const value = pageResponse.headers.get(header);
  console.log(`${header}: ${value ?? 'NOT PROVIDED BY HOST (meta/static contract remains in effect where applicable)'}`);
}

const manifestUrl = new URL('integrity-manifest.json', base);
const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
if (!manifestResponse.ok) throw new Error(`Integrity manifest returned HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
if (manifest.version !== 1 || typeof manifest.buildId !== 'string' || typeof manifest.assets !== 'object') {
  throw new Error('Deployed integrity manifest schema is invalid.');
}

const manifestPaths = Object.keys(manifest.assets);
const requiredPatterns = [
  /^assets\/mediapipe\.worker-[^/]+\.js$/,
  /^wasm\/vision_wasm_.*\.js$/,
  /^wasm\/vision_wasm_.*\.wasm$/,
  /^models\/hand_landmarker\.task$/,
  /^models\/nhan(?:-(?:high|medium|low))?\.glb$/,
  /^models\/nhan\.usdz$/,
  /^models\/nhan-preview\.png$/,
];

for (const pattern of requiredPatterns) {
  if (!manifestPaths.some((path) => pattern.test(path))) {
    throw new Error(`Integrity manifest is missing required production asset matching ${pattern}.`);
  }
}

const criticalPaths = manifestPaths.filter((path) => requiredPatterns.some((pattern) => pattern.test(path)));
for (const relativePath of criticalPaths) {
  if (relativePath.startsWith('/') || relativePath.includes('..')) {
    throw new Error(`Unsafe integrity path: ${relativePath}`);
  }

  const expected = manifest.assets[relativePath];
  const { bytes } = await fetchBytes(new URL(relativePath, base));
  if (bytes.length !== expected.size || sha384(bytes) !== expected.sha384) {
    throw new Error(`Deployed SHA-384 mismatch: ${relativePath}`);
  }
  console.log(`PASS ${relativePath} (${bytes.length} bytes)`);
}

console.log(`GitHub Pages deployment contract passed for build ${manifest.buildId}; verified ${criticalPaths.length} critical assets.`);
