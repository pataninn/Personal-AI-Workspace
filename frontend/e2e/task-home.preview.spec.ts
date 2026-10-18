import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

async function saveScreenshot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

test('captures assigned and unassigned tasks from Home and browses them through All tasks', async ({ page }, testInfo) => {
  const suffix = Date.now().toString(36);
  const workspaceName = `Home planning ${suffix}`;
  const assignedTitle = `Review release checklist ${suffix}`;
  const unassignedTitle = `Sort receipts ${suffix}`;

  await signIn(page);
  const workspaceResponse = await page.request.post('/api/v1/projects', {
    headers: { 'X-CSRF-Token': 'preview-only-csrf-token' },
    data: { name: workspaceName, workspaceMode: 'planning', objective: 'Capture from the local mock preview.' }
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()).data as { readonly id: string; readonly workspaceMode: string };
  expect(workspace.workspaceMode).toBe('planning');
  await page.reload();
  await expect(page.getByTestId('home-add-task-toggle')).toBeVisible();

  const addTask = page.getByTestId('home-add-task-toggle');
  await addTask.focus();
  await page.keyboard.press('Enter');
  await expect(addTask).toHaveAttribute('aria-expanded', 'true');
  const title = page.getByTestId('home-task-title');
  await expect(title).toBeFocused();
  await expect(page.getByLabel('Workspace (optional)')).toHaveValue('');
  await page.getByLabel('Workspace (optional)').selectOption(workspace.id);
  await title.fill(assignedTitle);
  await saveScreenshot(page, testInfo, 'home-up-next-desktop.png');
  await page.getByTestId('home-task-capture-submit').click();
  await expect(page.getByTestId('home-task-capture-success')).toContainText('Task added.');
  const viewTask = page.getByTestId('home-task-capture-view-task');
  const taskHref = await viewTask.getAttribute('href');
  expect(taskHref).toMatch(/^\/tasks\/[^/]+$/u);
  await viewTask.click();
  await expect(page).toHaveURL(taskHref!);
  await expect(page.getByTestId('task-detail-page')).toContainText(assignedTitle);
  await expect(page.getByTestId('task-detail-page')).toContainText(workspaceName);

  await page.goto('/dashboard');
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileAddTask = page.getByTestId('home-add-task-toggle');
  await mobileAddTask.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('home-task-title')).toBeFocused();
  await expect(page.getByLabel('Workspace (optional)')).toHaveValue('');
  await page.getByTestId('home-task-title').fill(unassignedTitle);
  await saveScreenshot(page, testInfo, 'home-up-next-mobile.png');
  await page.getByTestId('home-task-title').press('Enter');
  await expect(page.getByTestId('home-task-capture-success')).toContainText('Task added.');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await mobileAddTask.click();
  await expect(mobileAddTask).toHaveAttribute('aria-expanded', 'false');
  await expect(mobileAddTask).toBeFocused();
  await page.getByTestId('home-view-all-tasks').click();
  await expect(page).toHaveURL(/\/tasks$/u);
  await page.getByRole('searchbox', { name: 'Search' }).fill(unassignedTitle);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(unassignedTitle);
  const unassignedLink = page.getByRole('link', { name: new RegExp(unassignedTitle, 'u') });
  await expect(unassignedLink).toContainText('Unassigned');
  await expect(page.getByRole('link', { name: 'Inbox' })).toHaveCount(0);
  await expect(page.getByLabel('Collection', { exact: true })).toContainText('Inbox');
  await saveScreenshot(page, testInfo, 'all-tasks-unassigned-mobile.png');

  await page.getByLabel('Collection', { exact: true }).selectOption('inbox');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('inboxOnly')).toBe('true');
  await expect(page.getByRole('link', { name: new RegExp(unassignedTitle, 'u') })).toContainText('Unassigned');
});

test('keeps an uncertain capture available for retry with the same idempotency key', async ({ page }, testInfo) => {
  const title = `Retry capture after a temporary failure ${Date.now().toString(36)}`;
  const idempotencyKeys: string[] = [];
  let failedOnce = false;
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    idempotencyKeys.push((await route.request().allHeaders())['idempotency-key'] ?? '');
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'PREVIEW_TEMPORARY_ERROR', message: 'Try again.' } }) });
      return;
    }
    await route.continue();
  });

  await signIn(page);
  await page.getByTestId('home-add-task-toggle').click();
  const titleInput = page.getByTestId('home-task-title');
  await expect(titleInput).toBeFocused();
  await titleInput.fill(title);
  await page.getByTestId('home-task-capture-submit').click();
  await expect(page.getByTestId('home-task-capture-error')).toBeVisible();
  await expect(titleInput).toHaveValue(title);
  await expect(page.getByTestId('home-task-capture-retry')).toBeEnabled();
  await saveScreenshot(page, testInfo, 'capture-retry-error.png');
  await page.getByTestId('home-task-capture-retry').click();
  await expect(page.getByTestId('home-task-capture-success')).toContainText('Task added.');
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});
