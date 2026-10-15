import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

test('captures from Home, refreshes Inbox, filters All tasks, and opens the stable task detail', async ({ page }, testInfo) => {
  const title = 'Review release checklist';
  await signIn(page);
  await expect(page.getByTestId('home-inbox-count')).toHaveAttribute('aria-label', /Inbox tasks$/u);
  const countBefore = Number(await page.getByTestId('home-inbox-count').textContent());
  await page.getByTestId('home-inbox-title').focus();
  await page.getByTestId('home-inbox-title').fill(title);
  await page.getByTestId('home-inbox-title').press('Enter');
  await expect(page.getByTestId('home-inbox-saved')).toContainText('Saved to Inbox');
  await expect(page.getByTestId('home-inbox-count')).toHaveText(String(countBefore + 1).padStart(2, '0'));
  const homeScreenshot = testInfo.outputPath('home-inbox-capture.png');
  await mkdir(dirname(homeScreenshot), { recursive: true });
  await page.screenshot({ path: homeScreenshot, fullPage: true });

  await page.getByRole('link', { name: 'View Inbox' }).click();
  await expect(page).toHaveURL(/\/tasks\?inboxOnly=true$/u);
  await expect(page.getByRole('link', { name: new RegExp(title, 'u') })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: new RegExp(title, 'u') })).toBeVisible();

  await page.getByRole('link', { name: 'All tasks' }).first().click();
  await page.getByRole('searchbox', { name: 'Search' }).fill(title);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(title);
  const taskLink = page.getByRole('link', { name: new RegExp(title, 'u') });
  await expect(taskLink).toBeVisible();
  const allTasksScreenshot = testInfo.outputPath('all-tasks-filtered.png');
  await mkdir(dirname(allTasksScreenshot), { recursive: true });
  await page.screenshot({ path: allTasksScreenshot, fullPage: true });
  const taskHref = await taskLink.getAttribute('href');
  expect(taskHref).toMatch(/^\/tasks\/[^/]+$/u);
  const taskId = taskHref?.slice('/tasks/'.length);
  await taskLink.click();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.getByTestId('task-detail-page')).toContainText(title);
  await expect(page.getByText('Inbox', { exact: true }).first()).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: testInfo.outputPath('task-detail-mobile.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('keeps an uncertain capture available for retry with the same idempotency key', async ({ page }, testInfo) => {
  const title = 'Retry capture after a temporary failure';
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
  await page.getByTestId('home-inbox-title').fill(title);
  await page.getByTestId('home-inbox-save').click();
  await expect(page.getByTestId('home-inbox-save-error')).toBeVisible();
  await expect(page.getByTestId('home-inbox-title')).toHaveValue(title);
  await expect(page.getByTestId('home-inbox-retry')).toBeEnabled();
  const failureScreenshot = testInfo.outputPath('capture-retry-error.png');
  await mkdir(dirname(failureScreenshot), { recursive: true });
  await page.screenshot({ path: failureScreenshot, fullPage: true });
  await page.getByTestId('home-inbox-retry').click();
  await expect(page.getByTestId('home-inbox-saved')).toContainText('Saved to Inbox');
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});
