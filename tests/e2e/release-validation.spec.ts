import { expect, test, type Page } from '@playwright/test';

async function mockCapabilities(page: Page, options: { xr?: boolean; cameraDenied?: boolean; quickLook?: boolean } = {}) {
  await page.addInitScript((capabilities) => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: { isSessionSupported: async () => Boolean(capabilities.xr) },
    });
    if (capabilities.cameraDenied) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => { throw new DOMException('Permission denied by test route', 'NotAllowedError'); } },
      });
    }
    if (capabilities.quickLook) {
      const original = DOMTokenList.prototype.supports;
      DOMTokenList.prototype.supports = function supports(token: string) {
        return token === 'ar' || original.call(this, token);
      };
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
      HTMLAnchorElement.prototype.click = function click() {
        (window as typeof window & { __quickLookHref?: string }).__quickLookHref = this.href;
      };
    }
  }, options);
}

test('modal opens, traps focus, closes, and restores focus', async ({ page }) => {
  await mockCapabilities(page, { xr: false, cameraDenied: true });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Try On' });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const close = page.getByRole('button', { name: 'Close AR try-on' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('mocked WebXR rejection routes to a graceful camera permission recovery', async ({ page }) => {
  await mockCapabilities(page, { xr: false, cameraDenied: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try On' }).click();
  await expect(page.getByRole('heading', { name: 'Camera permission needed' })).toBeVisible();
  await expect(page.getByText(/processed locally and never uploaded/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
});

test('iOS capability route generates a same-site Quick Look USDZ URL', async ({ page }) => {
  await mockCapabilities(page, { xr: false, quickLook: true });
  await page.route('**/models/nhan.usdz', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/models/nhan-preview.png', (route) => route.fulfill({ status: 200, body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try On' }).click();
  const launch = page.getByRole('button', { name: 'View in AR' });
  await expect(launch).toBeEnabled();
  await launch.click();
  const href = await page.evaluate(() => (window as typeof window & { __quickLookHref?: string }).__quickLookHref);
  expect(href).toMatch(/^http:\/\/127\.0\.0\.1:4173\/models\/nhan\.usdz#allowsContentScaling=0&canonicalWebPageURL=/);
});

test('@stability survives ten open/close cycles and a continuous session without unbounded JS heap growth', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'performance.memory is Chromium-only');
  await mockCapabilities(page, { xr: false });
  await page.goto('/');
  const heap = async () => page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const samples: number[] = [await heap()];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    await page.getByRole('button', { name: 'Try On' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close AR try-on' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    samples.push(await heap());
  }
  await page.getByRole('button', { name: 'Try On' }).click();
  const durationMs = Number(process.env.STABILITY_DURATION_MS ?? 600_000);
  await page.waitForTimeout(durationMs);
  await expect(page.getByRole('dialog')).toBeVisible();
  samples.push(await heap());
  test.info().annotations.push({ type: 'heap-bytes', description: samples.join(',') });
  expect(samples.at(-1)! - samples[0]).toBeLessThan(64 * 1024 * 1024);
});
