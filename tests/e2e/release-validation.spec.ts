import { expect, test } from '@playwright/test';

test('production shell boots and exposes the AR entry point', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /try on/i }).first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('production shell has accessible document structure before hardware AR starts', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /try on/i }).first()).toBeEnabled();
});

test('@stability keeps the non-AR production shell responsive for the requested duration', async ({ page }) => {
  const durationMs = Math.max(10_000, Number(process.env.STABILITY_DURATION_MS ?? 60_000));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');

  const started = Date.now();
  while (Date.now() - started < durationMs) {
    await expect(page.getByRole('button', { name: /try on/i }).first()).toBeVisible();
    await page.waitForTimeout(Math.min(5_000, Math.max(250, durationMs - (Date.now() - started))));
  }

  expect(pageErrors, `uncaught page errors during stability window: ${pageErrors.join(' | ')}`).toEqual([]);
});
