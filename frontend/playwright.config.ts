import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const baseURL = process.env.PAI_E2E_BASE_URL ?? 'https://127.0.0.1:8443';
const parsedBaseURL = new URL(baseURL);
if (parsedBaseURL.protocol !== 'https:' || !['127.0.0.1', 'localhost'].includes(parsedBaseURL.hostname)) {
  throw new Error('MVP2 browser E2E requires the HTTPS loopback application.');
}

const chromeExecutable = process.env.PAI_CHROME_EXECUTABLE
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: process.env.PAI_E2E_OUTPUT_DIR ?? join(tmpdir(), 'personal-ai-workspace-mvp2-e2e'),
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: { executablePath: chromeExecutable },
    ignoreHTTPSErrors: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off'
  }
});
