import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['project-activity.preview.spec.ts', 'project-file-history.preview.spec.ts', 'provider-permissions.preview.spec.ts', 'run-recovery.preview.spec.ts', 'task-home.preview.spec.ts', 'task-actions.preview.spec.ts', 'home-chat.preview.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: process.env.PAI_E2E_OUTPUT_DIR ?? './test-results/activity-preview',
  use: {
    baseURL: process.env.PAI_PREVIEW_BASE_URL ?? 'http://127.0.0.1:5173',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PAI_CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
