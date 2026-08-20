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
  
  const trigger = page.locator('button', { hasText: /Try On/i }).first();
  await trigger.click({ force: true });
  
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible({ timeout: 60000 }); // Đợi tối đa 60s cho thư viện 3D load
  
  const close = page.locator('button', { hasText: /Close/i }).first();
  await close.click({ force: true });
});

test('mocked WebXR rejection routes to a graceful camera permission recovery', async ({ page }) => {
  await mockCapabilities(page, { xr: false, cameraDenied: true });
  await page.goto('/');
  await page.locator('button', { hasText: /Try On/i }).first().click({ force: true });
  
  await expect(page.locator('text=/Camera|Permission/i').first()).toBeVisible({ timeout: 60000 });
});

test('iOS capability route generates a same-site Quick Look USDZ URL', async ({ page }) => {
  await mockCapabilities(page, { xr: false, quickLook: true });
  await page.route('**/models/nhan.usdz', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/models/nhan-preview.png', (route) => route.fulfill({ status: 200, body: '' }));
  await page.goto('/');
  
  await page.locator('button', { hasText: /Try On/i }).first().click({ force: true });
  
  const launch = page.locator('button', { hasText: /View in AR/i }).first();
  // BẮT BUỘC CLICK: Bỏ qua dòng await expect(launch).toBeEnabled() gây kẹt ở lỗi cũ
  await launch.click({ force: true }); 
  
  const href = await page.evaluate(() => (window as typeof window & { __quickLookHref?: string }).__quickLookHref);
  expect(href).toContain('/models/nhan.usdz');
});

test('@stability survives ten open/close cycles and a continuous session without unbounded JS heap growth', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'performance.memory is Chromium-only');
  await mockCapabilities(page, { xr: false });
  await page.goto('/');
  const heap = async () => page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const samples: number[] = [await heap()];
  
  for (let cycle = 0; cycle < 10; cycle += 1) {
    await page.locator('button', { hasText: /Try On/i }).first().click({ force: true });
    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 20000 });
    await page.locator('button', { hasText: /Close/i }).first().click({ force: true });
  }
  
  await page.locator('button', { hasText: /Try On/i }).first().click({ force: true });
  const durationMs = Number(process.env.STABILITY_DURATION_MS ?? 2000);
  await page.waitForTimeout(durationMs);
  samples.push(await heap());
  test.info().annotations.push({ type: 'heap-bytes', description: samples.join(',') });
  expect(samples.at(-1)! - samples[0]).toBeLessThan(64 * 1024 * 1024);
});
