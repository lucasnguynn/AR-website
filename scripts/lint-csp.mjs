import { readFile } from 'node:fs/promises';

const headers = await readFile('public/_headers', 'utf8');
const csp = headers.match(/Content-Security-Policy:\s*([^\n]+)/)?.[1] ?? '';
for (const directive of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "worker-src 'self' blob:", "connect-src 'self' blob:"]) {
  if (!csp.includes(directive)) throw new Error(`CSP is missing required directive: ${directive}`);
}
if (/script-src[^;]*'unsafe-(?:inline|eval)'/.test(csp)) throw new Error('CSP permits unsafe script execution.');
if (/https?:|\*/.test(csp.match(/(?:script|worker|connect)-src[^;]*/g)?.join(';') ?? '')) throw new Error('Executable and connection directives must not allow remote origins or wildcards.');
const permissions = headers.match(/Permissions-Policy:\s*([^\n]+)/)?.[1] ?? '';
if (!permissions.includes('camera=(self)') || !permissions.includes('microphone=()') || !permissions.includes('geolocation=()')) throw new Error('Permissions-Policy must restrict camera to self and deny microphone/geolocation.');
console.log('Static CSP policy passed required-directive and unsafe-script checks. Hosting support is verified post-deploy.');
