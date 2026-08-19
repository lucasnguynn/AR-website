const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/verify-deployment-headers.mjs <deployed-url>');
const response = await fetch(target, { redirect: 'follow' });
if (!response.ok) throw new Error(`Deployment returned HTTP ${response.status}`);
const expected = ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy'];
let missing = false;
for (const name of expected) {
  const value = response.headers.get(name);
  console.log(`${name}: ${value ?? 'NOT SERVED'}`);
  if (!value) missing = true;
}
if (missing) {
  console.error('Required response headers are not fully active. GitHub Pages does not apply repository _headers files.');
  process.exitCode = 1;
}
