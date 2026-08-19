import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AROrchestrator, type ARDiagnostics, type ARExperienceAdapter, type ARExperienceKind } from '../src/ar/AROrchestrator';

class Adapter implements ARExperienceAdapter {
  constructor(readonly kind: ARExperienceKind, private support: boolean, private fail = false) {}
  async isSupported() { return this.support; }
  async start() { if (this.fail) throw new Error('browser rejected requestSession'); }
  async stop() {}
  diagnostics(): ARDiagnostics { return { tracking: 'none', filter: 'one-euro', prediction: 'none', depth: 'none', renderer: 'webgl2', experience: this.kind, state: 'active' }; }
}

export async function runBrowserContractTests(): Promise<void> {
  const app = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.match(app, />\s*Try On\s*</, 'desktop interactive fallback entry is present');
  assert.match(app, /lazy\(\(\) =>\s*import\('\.\/components\/ARTryOnModal'\)/, 'AR runtime remains lazy until interaction');
  const modal = await readFile(join(process.cwd(), 'src/components/ARTryOnModal.tsx'), 'utf8');
  assert.match(modal, /role="dialog"/); assert.match(modal, /aria-modal="true"/); assert.match(modal, /orchestrator\.stop\(\)/, 'modal cleanup owns runtime teardown');
  assert.match(modal, /import\.meta\.env\.BASE_URL}models\/nhan\.usdz/, 'Quick Look USDZ is GitHub Pages base-aware');
  const quickLook = await readFile(join(process.cwd(), 'src/components/QuickLookViewer.tsx'), 'utf8');
  assert.match(quickLook, /anchor\.rel = 'ar'/); assert.match(quickLook, /anchor\.href = `\$\{usdzUrl\}/);
  assert.match(modal, /startCameraFromRef\(video, 'user'\)/, 'camera composite initializes the mounted preview');
  const result = await new AROrchestrator([new Adapter('webxr', true, true), new Adapter('camera-composite', true)]).start();
  assert.equal(result.experience, 'camera-composite'); assert.equal(result.state, 'fallback-active', 'mocked requestSession rejection routes to camera fallback');
}
