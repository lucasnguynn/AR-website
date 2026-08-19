import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVerifiedAsset, createVerifiedWorker, type IntegrityDependencies } from '../src/utils/SecurityUtils';
import { validateAssets } from '../scripts/validate-assets.mjs';
import { viteBase } from '../scripts/asset-config.mjs';

const bytes = new TextEncoder().encode('self.onmessage=()=>{}');
const digest = `sha384-${Buffer.from(await webcrypto.subtle.digest('SHA-384', bytes)).toString('base64')}`;
function deps(manifest: unknown, body = bytes): { dependencies: IntegrityDependencies; workers: string[] } {
  const workers: string[] = [];
  const responses = [new Response(JSON.stringify(manifest)), new Response(body)];
  return { workers, dependencies: { fetch: async () => responses.shift() ?? new Response(null, { status: 404 }), digest: webcrypto.subtle.digest.bind(webcrypto.subtle), createWorker: (url) => { workers.push(url); return {} as Worker; }, createObjectURL: () => 'blob:verified', revokeObjectURL: () => undefined, baseUrl: new URL('https://example.test/AR-website/') } };
}
export async function runIntegrityTests(): Promise<void> {
  await assert.rejects(fetchVerifiedAsset('assets/worker.js', deps({}, bytes).dependencies), /schema is invalid/);
  await assert.rejects(fetchVerifiedAsset('assets/worker.js', deps({ version: 1, buildId: 'x', assets: {} }).dependencies), /no exact entry/);
  await assert.rejects(fetchVerifiedAsset('assets/worker.js', deps({ version: 1, buildId: 'x', assets: { 'assets/worker.js': { sha384: `sha384-${'A'.repeat(64)}`, size: bytes.length } } }).dependencies), /SHA-384 integrity mismatch/);
  const success = deps({ version: 1, buildId: 'x', assets: { 'assets/worker.js': { sha384: digest, size: bytes.length } } });
  await createVerifiedWorker('assets/worker.js', { type: 'module' }, success.dependencies);
  assert.deepEqual(success.workers, ['blob:verified'], 'worker spawns only from verified bytes');
  assert.equal(viteBase('owner/AR-website'), '/AR-website/');
  assert.equal(new URL('models/nhan.usdz', 'https://example.test/AR-website/').pathname, '/AR-website/models/nhan.usdz');
  const root = await mkdtemp(join(tmpdir(), 'asset-preflight-')); await mkdir(join(root, 'public'), { recursive: true });
  assert.throws(() => validateAssets({ root, env: {} }), /public\/models\/hand_landmarker.task/);
  await writeFile(join(root, 'placeholder'), 'x');
}
