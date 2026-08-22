// FILE: scripts/lint-csp.mjs
import { readFile } from 'node:fs/promises';

const headers = await readFile('public/_headers', 'utf8');
const csp = headers.match(/Content-Security-Policy:\s*([^\n]+)/)?.[1] ?? '';

for (const directive of [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
]) {
  if (!csp.includes(directive)) throw new Error(`CSP is missing required directive: ${directive}`);
}
if (/script-src[^;]*'unsafe-(?:inline|eval)'/.test(csp)) throw new Error('CSP permits unsafe script execution.');
const executableAndNetwork = csp.match(/(?:script|worker|connect)-src[^;]*/g)?.join(';') ?? '';
if (/https?:|\*/.test(executableAndNetwork)) throw new Error('Executable and connection directives must not allow remote origins or wildcards.');

const permissions = headers.match(/Permissions-Policy:\s*([^\n]+)/)?.[1] ?? '';
for (const rule of ['camera=(self)', 'microphone=()', 'geolocation=()', 'xr-spatial-tracking=(self)']) {
  if (!permissions.includes(rule)) throw new Error(`Permissions-Policy is missing ${rule}.`);
}
console.log('Static CSP and Permissions-Policy contract passed.');
