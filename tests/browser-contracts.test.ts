import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AROrchestrator, type ARDiagnostics, type ARExperienceAdapter, type ARExperienceKind } from '../src/ar/AROrchestrator';

class Adapter implements ARExperienceAdapter {
  constructor(readonly kind: ARExperienceKind, private support: boolean, private fail = false) {}
  async isSupported() { return this.support; }
  async start() { if (this.fail) throw new Error('browser rejected requestSession'); }
  async stop() {}
  diagnostics(): ARDiagnostics {
    return { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer: 'webgl2', experience: this.kind, state: 'active' };
  }
}

export async function runBrowserContractTests(): Promise<void> {
  const app = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.match(app, />\s*Try On\s*</, 'desktop interactive fallback entry is present');
  assert.match(app, /lazy\(\(\) =>\s*import\('\.\/components\/ARTryOnModal'\)/, 'AR runtime remains lazy until interaction');

  const modal = await readFile(join(process.cwd(), 'src/components/ARTryOnModal.tsx'), 'utf8');
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /orchestrator\.stop\(\)/, 'modal cleanup owns runtime teardown');
  assert.match(modal, /AR_RUNTIME_CONFIG\.assets\.usdz/, 'Quick Look asset comes from centralized base-aware runtime config');
  assert.match(modal, /startCameraFromRef\(video, 'user'\)/, 'camera composite initializes the mounted preview only after a user-selected experience');
  assert.match(modal, /return 'webgl2'/, 'production diagnostics describe the validated R3F8 WebGL2 renderer');

  const runtimeConfig = await readFile(join(process.cwd(), 'src/config/arRuntimeConfig.ts'), 'utf8');
  assert.match(runtimeConfig, /asset\(import\.meta\.env\.VITE_RING_USDZ \|\| 'models\/nhan\.usdz'\)/, 'runtime config makes USDZ GitHub Pages base-aware');

  const quickLook = await readFile(join(process.cwd(), 'src/components/QuickLookViewer.tsx'), 'utf8');
  assert.match(quickLook, /<a\s[\s\S]*?rel="ar"/, 'Quick Look uses a real rel=ar anchor');
  assert.match(quickLook, /rel="ar"[\s\S]*?<img /, 'the rel=ar anchor contains the required image child');
  assert.doesNotMatch(quickLook, /document\.createElement\(['"]a['"]\)/, 'Quick Look does not synthesize a second click outside the original tap target');

  const ringScene = await readFile(join(process.cwd(), 'src/components/RingScene.tsx'), 'utf8');
  const fallback = await readFile(join(process.cwd(), 'src/components/Fallback3DViewer.tsx'), 'utf8');
  assert.doesNotMatch(ringScene, /<Environment\s+preset=/, 'camera AR does not depend on remote Drei preset HDRIs');
  assert.doesNotMatch(fallback, /<Environment\s+preset=/, 'interactive 3D fallback remains compatible with same-origin CSP');

  const renderer = await readFile(join(process.cwd(), 'src/components/WebGPUScene.tsx'), 'utf8');
  assert.doesNotMatch(renderer, /new\s+WebGPURenderer|async\s*\(canvas/, 'React18/R3F8 Canvas avoids an unvalidated async WebGPU renderer factory');
  assert.match(renderer, /new THREE\.WebGLRenderer/, 'production Canvas has an explicit WebGL2 renderer');

  const result = await new AROrchestrator([
    new Adapter('webxr', true, true),
    new Adapter('camera-composite', true),
  ]).start();
  assert.equal(result.experience, 'camera-composite');
  assert.equal(result.state, 'fallback-active', 'mocked requestSession rejection routes to camera fallback');
}
