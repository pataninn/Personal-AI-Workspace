import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

async function captureInboxTask(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.getByTestId('home-add-task-toggle').click();
  await page.getByTestId('home-task-title').fill(title);
  await page.getByTestId('home-task-capture-submit').click();
  await expect(page.getByTestId('home-task-capture-success')).toContainText('Task added.');
  await page.getByTestId('home-view-all-tasks').click();
  await expect(page).toHaveURL(/\/tasks$/u);
  await page.getByLabel('Collection', { exact: true }).selectOption('inbox');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/\/tasks\?inboxOnly=true$/u);
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByTestId('task-detail-page')).toContainText(title);
}

test('edits, moves, archives, reloads the saved receipt, and undoes on the stable task URL', async ({ page }, testInfo) => {
  const title = `Task actions ${Date.now().toString().slice(-6)}`;
  const editedTitle = `${title} updated`;
  await signIn(page);
  await captureInboxTask(page, title);
  const taskId = new URL(page.url()).pathname.split('/').at(-1);
  expect(taskId).toBeTruthy();

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
  await page.getByLabel('Task title').fill(editedTitle);
  await page.getByTestId('project-task-editor-save').click();
  await expect(page.getByRole('heading', { name: editedTitle })).toBeVisible();
  await expect(page.getByTestId('task-action-receipt')).toContainText('Task changes saved');

  await page.getByRole('button', { name: 'Move' }).click();
  await expect(page.getByRole('dialog', { name: 'Move task' })).toBeVisible();
  await page.getByLabel('Destination').selectOption({ label: 'Website redesign' });
  await page.getByTestId('task-move-submit').click();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.locator('.task-detail-fields').getByText('Website redesign')).toBeVisible();
  await expect(page.getByTestId('task-action-receipt')).toContainText('Task move saved');

  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByTestId('task-detail-archived')).toBeVisible();
  await expect(page).toHaveURL(`/tasks/${taskId}?includeArchived=true`);
  await page.reload();
  await expect(page.getByTestId('task-detail-archived')).toBeVisible();
  await expect(page.getByTestId('task-action-receipt')).toContainText('Task archive saved');
  await expect(page.getByTestId('task-undo')).toBeEnabled();

  await page.getByTestId('task-undo').click();
  await expect(page.getByTestId('task-undo-complete')).toBeVisible();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.locator('.task-detail-fields').getByText('Website redesign')).toBeVisible();
  await expect(page.getByRole('heading', { name: editedTitle })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileScreenshot = testInfo.outputPath('task-actions-mobile-after-undo.png');
  await mkdir(dirname(mobileScreenshot), { recursive: true });
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
});

test('preserves a local edit through a stale-version conflict and keeps the dialog keyboard accessible', async ({ page }, testInfo) => {
  const title = `Conflict task ${Date.now().toString().slice(-6)}`;
  const draftTitle = `${title} local draft`;
  await signIn(page);
  await captureInboxTask(page, title);
  const taskId = new URL(page.url()).pathname.split('/').at(-1);
  expect(taskId).toBeTruthy();

  let changedRemotely = false;
  await page.route(`**/api/v1/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== 'PATCH' || changedRemotely) {
      await route.fallback();
      return;
    }
    changedRemotely = true;
    const remote = await page.request.patch(`/api/v1/tasks/${taskId}`, {
      data: { details: 'Saved by another tab' },
      headers: {
        'X-CSRF-Token': 'preview-only-csrf-token',
        'If-Match': '"1"',
        'Idempotency-Key': randomUUID()
      }
    });
    expect(remote.ok(), `${remote.status()} ${await remote.text()}`).toBeTruthy();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: { code: 'PROJECT_TASK_VERSION_CONFLICT', message: 'This task changed.' } })
    });
  });

  await page.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit task' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Task title')).toBeFocused();
  await page.getByLabel('Task title').fill(draftTitle);
  await page.getByTestId('project-task-editor-save').click();
  await expect(page.getByTestId('project-task-version-conflict')).toBeVisible();
  const conflictScreenshot = testInfo.outputPath('task-edit-conflict-preserves-draft.png');
  await mkdir(dirname(conflictScreenshot), { recursive: true });
  await page.screenshot({ path: conflictScreenshot, fullPage: true });
  await page.getByTestId('project-task-conflict-keep-editing').click();
  await expect(page.getByLabel('Task title')).toHaveValue(draftTitle);
  await expect(page.getByLabel('Details (optional)')).toHaveValue('Saved by another tab');
  await page.getByTestId('project-task-editor-save').click();
  await expect(page.getByRole('heading', { name: draftTitle })).toBeVisible();
  await expect(page.getByText('Saved by another tab')).toBeVisible();

  await page.getByRole('button', { name: 'Move' }).click();
  const moveDialog = page.getByRole('dialog', { name: 'Move task' });
  await expect(moveDialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(moveDialog.locator(':focus')).toHaveCount(1);
  const screenshot = testInfo.outputPath('task-actions-mobile-move-dialog.png');
  await mkdir(dirname(screenshot), { recursive: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(moveDialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Move' })).toBeFocused();
});
