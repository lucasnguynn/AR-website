import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'ar-tests-'));
const output = join(directory, 'tests.mjs');
try {
  await build({ entryPoints: ['tests/orchestration.test.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
  const tests = await import(pathToFileURL(output).href);
  await tests.run();
  console.log('9 orchestration and worker protocol tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
