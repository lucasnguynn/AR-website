import { readFile } from 'node:fs/promises';

const headers = await readFile('public/_headers', 'utf8');
const csp = headers.match(/Content-Security-Policy:\s*([^\n]+)/)?.[1] ?? '';
for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "worker-src 'self' blob:"]) {
  if (!csp.includes(directive)) throw new Error(`CSP is missing required directive: ${directive}`);
}
if (/script-src[^;]*'unsafe-(?:inline|eval)'/.test(csp)) throw new Error('CSP permits unsafe script execution.');
console.log('Static CSP policy passed required-directive and unsafe-script checks. Hosting support is verified post-deploy.');
