import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0, 
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ 
    name: 'chromium', 
    use: { 
      ...devices['Desktop Chrome'], 
      launchOptions: { 
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--use-angle=swiftshader',
          '--mute-audio'
        ] 
      } 
    } 
  }],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
