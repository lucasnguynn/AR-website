import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function assertSecurityHeaders(headers) {
  const csp = headers.get('content-security-policy') ?? '';
  const permissions = headers.get('permissions-policy') ?? '';
  const requiredCsp = ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "connect-src 'self' blob:", "object-src 'none'", "frame-ancestors 'self'"];
  for (const directive of requiredCsp) if (!csp.includes(directive)) throw new Error(`CSP is missing: ${directive}`);
  if (/'unsafe-eval'|script-src[^;]*(?:https?:|\*)/.test(csp)) throw new Error('CSP permits unsafe-eval, remote script origins, or wildcard scripts.');
  if (!permissions.includes('camera=(self)') || !permissions.includes('microphone=()') || !permissions.includes('geolocation=()')) throw new Error('Permissions-Policy does not enforce the camera/microphone/geolocation contract.');
  if (headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') throw new Error('X-Content-Type-Options must be nosniff.');
}

export async function verifyDeployment(target, compiledManifestPath) {
  const base = new URL(target.endsWith('/') ? target : `${target}/`);
  const response = await fetch(base, { redirect: 'follow', cache: 'no-store' });
  if (!response.ok) throw new Error(`Deployment returned HTTP ${response.status}`);
  assertSecurityHeaders(response.headers);

  const manifestResponse = await fetch(new URL('integrity-manifest.json', base), { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error(`Integrity manifest returned HTTP ${manifestResponse.status}`);
  const deployedText = await manifestResponse.text();
  const deployed = JSON.parse(deployedText);
  if (deployed.version !== 1 || typeof deployed.assets !== 'object') throw new Error('Deployed integrity manifest schema is invalid.');
  if (compiledManifestPath) {
    const compiled = JSON.parse(await readFile(compiledManifestPath, 'utf8'));
    if (compiled.buildId !== deployed.buildId || JSON.stringify(compiled.assets) !== JSON.stringify(deployed.assets)) throw new Error('Deployed manifest does not match the compiled release manifest.');
  }
  const critical = Object.entries(deployed.assets).filter(([path]) => /(?:worker[^/]*\.(?:js|mjs)|\.wasm)$/i.test(path));
  if (!critical.some(([path]) => /worker/i.test(path)) || !critical.some(([path]) => /\.wasm$/i.test(path))) throw new Error('Manifest must cover at least one compiled Worker and WASM asset.');
  for (const [path, expected] of critical) {
    if (path.startsWith('/') || path.includes('..')) throw new Error(`Unsafe manifest path: ${path}`);
    const assetResponse = await fetch(new URL(path, base), { cache: 'no-store' });
    if (!assetResponse.ok) throw new Error(`${path} returned HTTP ${assetResponse.status}`);
    const bytes = Buffer.from(await assetResponse.arrayBuffer());
    const digest = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    if (bytes.length !== expected.size || digest !== expected.sha384) throw new Error(`Production SHA-384 mismatch: ${path}`);
  }
  console.log(`Production contract passed for headers and ${critical.length} deployed Worker/WASM assets (${deployed.buildId}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node scripts/verify-deployment-headers.mjs <deployed-url> [compiled-manifest]');
  await verifyDeployment(target, process.argv[3]);
}
