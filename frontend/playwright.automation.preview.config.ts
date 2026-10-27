import { defineConfig } from '@playwright/test';

import previewConfig from './playwright.preview.config';

export default defineConfig({
  ...previewConfig,
  testMatch: ['automation-interface.preview.spec.ts'],
  outputDir: './test-results/automation-preview'
});
