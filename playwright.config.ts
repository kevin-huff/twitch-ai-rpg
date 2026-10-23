import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: 'node --import tsx tests/fixtures/browser-server.ts',
    wait: { stdout: /Local roleplay server is ready at http:\/\/127\.0\.0\.1:3100/ },
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://rpg@127.0.0.1:55432/rpg_test',
      HOST_TOKEN: 'browser-test-host-credential-not-for-deployment',
      APP_ORIGIN: 'http://127.0.0.1:3100',
      PORT: '3100',
      AI_PROVIDER: 'fake',
      TTS_PROVIDER: 'silent',
      ASSET_DIR: 'test-results/audio',
    },
  },
});
