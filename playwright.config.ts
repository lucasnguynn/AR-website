import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000, // Đưa về 60s vì bản production chạy rất nhanh
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ 
    name: 'chromium', 
    use: { 
      ...devices['Desktop Chrome'], 
      launchOptions: { 
        args: [
          '--use-angle=swiftshader',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream'
        ] 
      } 
    } 
  }],
  webServer: {
    // THAY ĐỔI CỐT LÕI: Build thành công mới mở server preview
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
