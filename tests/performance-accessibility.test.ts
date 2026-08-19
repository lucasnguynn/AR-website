import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdaptiveQualityController } from '../src/rendering/AdaptiveQualityController';
import { containModalFocus } from '../src/utils/modalFocus';

class FakeElement {
  isConnected = true;
  focused = 0;
  focus() { this.focused += 1; (globalThis.document as unknown as { activeElement: FakeElement }).activeElement = this; }
  hasAttribute() { return false; }
}

export async function runPerformanceAccessibilityTests() {
  const controller = new AdaptiveQualityController('HIGH');
  let changed = false;
  for (let index = 0; index < 100; index += 1) changed ||= controller.sample(30).changed;
  assert.equal(changed, true, 'sustained overload degrades quality');
  assert.equal(controller.quality, 'MEDIUM');

  changed = false;
  for (let index = 0; index < 500; index += 1) changed ||= controller.sample(16).changed;
  assert.equal(changed, true, 'sustained recovery upgrades quality');
  assert.equal(controller.quality, 'HIGH', 'transient overload is not permanent');

  const previous = new FakeElement();
  const first = new FakeElement();
  const last = new FakeElement();
  let keyHandler: ((event: KeyboardEvent) => void) | undefined;
  const modal = {
    querySelectorAll: () => [first, last],
    addEventListener: (_: string, listener: EventListener) => { keyHandler = listener as (event: KeyboardEvent) => void; },
    removeEventListener: () => { keyHandler = undefined; },
    focus: () => undefined,
  };
  (globalThis as unknown as { document: { activeElement: FakeElement } }).document = { activeElement: previous };
  const release = containModalFocus(modal as unknown as HTMLElement, previous as unknown as HTMLElement);
  assert.equal(first.focused, 1, 'focus enters modal');
  (globalThis.document as unknown as { activeElement: FakeElement }).activeElement = last;
  let prevented = false;
  keyHandler?.({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } } as KeyboardEvent);
  assert.equal(prevented, true, 'tab is trapped at modal boundary');
  assert.equal(first.focused, 2, 'tab wraps to first control');
  release();
  assert.equal(previous.focused, 1, 'focus returns to opener');

  const scene = await readFile(join(process.cwd(), 'src/components/WebGPUScene.tsx'), 'utf8');
  assert.doesNotMatch(scene, /key=\{qualityTier\}/, 'quality changes do not remount Canvas');
  assert.match(scene, /handleRendererFailure/, 'renderer API downgrade is restricted to a renderer failure path');
  const css = await readFile(join(process.cwd(), 'src/index.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/, 'reduced motion is honored');
}
