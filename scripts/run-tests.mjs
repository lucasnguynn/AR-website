import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'ar-tests-'));
try {
  for (const [source, exported] of [['tests/orchestration.test.ts', 'run'], ['tests/integrity.test.ts', 'runIntegrityTests']]) {
    const output = join(directory, `${exported}.mjs`);
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
    await (await import(pathToFileURL(output).href))[exported]();
  }
  console.log('Orchestration, protocol, integrity, base-path, and asset-preflight tests passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
