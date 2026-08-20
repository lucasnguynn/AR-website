import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000, // Tăng gấp đôi tổng thời gian test
  expect: { timeout: 30_000 }, // Chờ tối đa 30s cho mỗi action
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
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000, // Cho phép máy chủ Vite 2 phút để khởi động
  },
});
