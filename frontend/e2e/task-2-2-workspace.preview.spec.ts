import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

test('creates managed workspace modes with safe failure, keyboard selection, and capability navigation', async ({ page }, testInfo) => {
  const requests: Record<string, unknown>[] = [];
  const planningName = `Preview planning fallback ${Date.now()}`;
  let failFileBackedOnce = true;
  await page.route('**/api/v1/projects', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    if (body.workspaceMode === 'file_backed' && failFileBackedOnce) {
      failFileBackedOnce = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: { code: 'WORKSPACE_STORAGE_UNAVAILABLE', message: 'Storage at C:\\private\\account-root is unavailable.' } })
      });
      return;
    }
    await route.continue();
  });

  await signIn(page);
  await page.getByTestId('project-create-trigger').click();
  const dialog = page.getByTestId('project-create-dialog');
  const name = dialog.getByLabel('Project name');
  const mode = dialog.getByLabel('Workspace features');
  await expect(dialog).toBeVisible();
  await expect(name).toBeFocused();
  await expect(mode).toHaveValue('file_backed');
  await expect(dialog.getByTestId('project-workspace-mode-help')).toContainText('The app manages a private folder for files and file-based runs.');
  await expect(dialog.getByTestId('project-relative-root-input')).toHaveCount(0);
  await name.fill(planningName);
  await saveScreenshot(page, testInfo, 'workspace-create-desktop.png');
  await dialog.getByTestId('project-create-submit').click();

  const storageError = dialog.getByTestId('workspace-storage-error');
  await expect(storageError).toContainText('We could not create this project safely. Try again.');
  await expect(dialog.getByTestId('workspace-storage-retry-button')).toBeEnabled();
  await expect(name).toHaveValue(planningName);
  await expect(mode).toHaveValue('file_backed');
  await expect(dialog.getByText('Storage at C:\\private\\account-root is unavailable.')).toHaveCount(0);
  await saveScreenshot(page, testInfo, 'workspace-storage-fallback-desktop.png');

  await mode.focus();
  await page.keyboard.press('ArrowDown');
  await expect(mode).toHaveValue('planning');
  await expect(dialog.getByTestId('project-workspace-mode-help')).toContainText('Tasks, memory, and planning assistance remain available where enabled.');
  await dialog.getByTestId('project-create-submit').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/iu);
  const planningProjectId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(requests[0]).toEqual({ name: planningName, workspaceMode: 'file_backed' });
  expect(requests[1]).toEqual({ name: planningName, workspaceMode: 'planning' });
  for (const request of requests) expect(request).not.toHaveProperty('relativeRoot');
  await expect(page.getByText('Planning only', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Planning chat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Memory' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Context' })).toHaveCount(0);
  await expect(page.getByText(/This is a planning-only workspace\. Files and file-based runs are unavailable here\./u)).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  const planningWidths = await page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth }));
  expect(planningWidths.page).toBeLessThanOrEqual(planningWidths.viewport);
  await saveScreenshot(page, testInfo, 'workspace-planning-mobile.png');

  await page.goto('/dashboard');
  await page.getByTestId('project-create-trigger').click();
  const fileDialog = page.getByTestId('project-create-dialog');
  const fileName = `Preview file-capable project ${Date.now()}`;
  await fileDialog.getByLabel('Project name').fill(fileName);
  await expect(fileDialog.getByLabel('Workspace features')).toHaveValue('file_backed');
  await fileDialog.getByTestId('project-create-submit').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/iu);
  const fileProjectId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(fileProjectId).not.toBe(planningProjectId);
  await expect(page.locator('.reference-project-header').getByText('Files available', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Context' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'File history' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Planning chat' })).toHaveCount(0);
  expect(requests[2]).toEqual({ name: fileName, workspaceMode: 'file_backed' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveScreenshot(page, testInfo, 'workspace-files-desktop.png');
  await page.setViewportSize({ width: 375, height: 812 });
  const fileWidths = await page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth }));
  expect(fileWidths.page).toBeLessThanOrEqual(fileWidths.viewport);
  await saveScreenshot(page, testInfo, 'workspace-files-mobile.png');
});
