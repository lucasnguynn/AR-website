import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000, // Tăng tổng thời gian test lên 60 giây
  expect: { timeout: 20_000 }, // Tăng thời gian chờ mỗi action lên 20 giây
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0, // Tự động chạy lại 2 lần nếu test bị rớt trên CI
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
    timeout: 120_000, // Cho phép máy chủ Vite 120 giây để khởi động
  },
});
