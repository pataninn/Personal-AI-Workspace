import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

test.use({ baseURL: process.env.PAI_PREVIEW_BASE_URL ?? 'http://127.0.0.1:5193' });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const TEST_PASSWORD = 'mock-only-test-password';

const account = {
  id: ACCOUNT_ID, displayName: 'Browser smoke user', identifier: 'browser-smoke-user', accountKind: 'regular' as const,
  role: 'user' as const, enabled: true, expiresAt: null, limitsRevision: 1,
  daily: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
  lifetime: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
  storage: { state: 'ready' as const, usedBytes: '0', reservedBytes: '0', limitBytes: null, overLimit: false },
  canDisable: true, disableReason: null
};

const userTask = {
  id: TASK_ID, projectId: null, title: 'Prepare weekly notes', details: 'Manual notes remain available.', importance: 'medium',
  deadline: null, subtasks: [], status: 'todo', position: 0, version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z', completedAt: null
};

const usage = {
  asOf: '2026-10-19T12:00:00.000Z', expiresAt: null,
  daily: { limitUnits: '0', settledUnits: '0', reservedUnits: '0', remainingUnits: '0', resetAt: '2026-10-20T00:00:00.000Z', timeZone: 'UTC' },
  lifetime: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
  storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '0', reservedBytes: '0', limitBytes: null, availableBytes: null, overLimit: false, asOf: '2026-10-19T12:00:00.000Z' },
  availability: { status: 'exhausted', reason: 'An AI usage allowance has been reached.', canSubmit: false }
};

function envelope(data: unknown): { readonly data: unknown; readonly error: null } { return { data, error: null }; }

test('admin manages a mock account, while exhausted AI usage leaves manual tasks editable', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  let currentRole: 'admin' | 'user' = 'admin';
  const accountCreated = true;
  let dailyLimit = null as string | null;
  let submittedResetPassword = false;
  const settings = {
    revision: 1, demoSettingsBootstrapped: true, defaultDailyLimitUnits: '1000', defaultLifetimeLimitUnits: '5000',
    sessionTtlHours: 24, globalAdmissionMax: null, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20,
    networkAdmissionWindowSeconds: 900, runStartMax: 30, runStartWindowSeconds: 3600, maxConcurrentCalls: 2,
    globalDailyLimitUnits: '10000', campaignId: 'browser-smoke', campaignLimitUnits: '5000', inferencePaused: false,
    usage: { dailySettledUnits: '0', dailyReservedUnits: '0', campaignSettledUnits: '0', campaignReservedUnits: '0', dailyTimeZone: 'UTC' }
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const data = async (body: unknown, status = 200): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(envelope(body)) });
    if (url.pathname === '/api/v1/auth/session' && method === 'GET') {
      await data({ principal: { id: currentRole === 'admin' ? ADMIN_ID : ACCOUNT_ID,
        displayName: currentRole === 'admin' ? 'Admin fixture' : 'Browser smoke user', accountKind: 'regular', role: currentRole },
        csrfToken: 'mock-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') { await route.fulfill({ status: 204 }); return; }
    if (url.pathname === '/api/v1/auth/login' && method === 'POST') {
      currentRole = 'user';
      await data({ principal: { id: ACCOUNT_ID, displayName: 'Browser smoke user', accountKind: 'regular', role: 'user' },
        csrfToken: 'mock-user-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    if (url.pathname === '/api/v1/projects' && method === 'GET') { await data({ projects: [] }); return; }
    if (url.pathname === '/api/v1/account/usage' && method === 'GET') { await data(usage); return; }
    if (url.pathname === '/api/v1/admin/accounts' && method === 'GET') {
      await data({ accounts: accountCreated ? [{ ...account, daily: { ...account.daily, limitUnits: dailyLimit,
        remainingUnits: dailyLimit === '0' ? '0' : null }, limitsRevision: dailyLimit === '0' ? 2 : 1 }] : [] });
      return;
    }
    if (url.pathname === '/api/v1/admin/demo-settings' && method === 'GET') { await data(settings); return; }
    if (url.pathname === '/api/v1/admin/audit' && method === 'GET') {
      await data({ events: accountCreated ? [{ id: '44444444-4444-4444-8444-444444444444', actorName: 'Admin fixture',
        action: submittedResetPassword ? 'account.password_reset' : 'account.created', target_account_id: ACCOUNT_ID,
        old_values: {}, new_values: { allSessionsRevoked: true }, createdAt: '2026-10-19T12:00:00.000Z' }] : [] });
      return;
    }
    if (url.pathname === `/api/v1/admin/accounts/${ACCOUNT_ID}/limits` && method === 'PATCH') {
      dailyLimit = request.postDataJSON().dailyCreditLimitUnits as string | null;
      await data({ accountId: ACCOUNT_ID, limitsRevision: 2 });
      return;
    }
    if (url.pathname === `/api/v1/admin/accounts/${ACCOUNT_ID}/password-resets` && method === 'POST') {
      submittedResetPassword = request.postDataJSON().password === TEST_PASSWORD;
      await data({ reset: true, sessionsRevoked: true });
      return;
    }
    if (url.pathname === '/api/v1/tasks' && method === 'GET') {
      await data({ items: [{ task: userTask, collection: 'inbox', workspace: null }], nextCursor: null });
      return;
    }
    if (url.pathname === `/api/v1/tasks/${TASK_ID}` && method === 'GET') {
      await data({ task: userTask, collection: 'inbox', workspace: null });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null,
      error: { code: 'MOCK_ROUTE_NOT_FOUND', message: 'This browser smoke uses local mock routes only.' } }) });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/admin');
  await expect(page.getByTestId('admin-portal-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Admin portal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  await expect(page.getByLabel('Global admissions per window')).not.toBeVisible();
  await page.getByText('Advanced limits and shared budget', { exact: true }).click();
  await expect(page.getByLabel('Global admissions per window')).toBeVisible();
  await expect(page.getByLabel('Global admissions per window')).toHaveValue('');
  await page.getByRole('button', { name: 'Fill missing demo limits' }).click();
  await expect(page.getByLabel('Global admissions per window')).toHaveValue('40');
  await expect(page.getByLabel('Shared demo daily budget')).toHaveValue('10000');
  await expect(page.getByLabel('New demo daily allowance')).toHaveValue('1000');
  await expect(page.getByLabel('Emergency pause for all AI inference (all accounts)')).not.toBeChecked();
  await page.getByText('Advanced limits and shared budget', { exact: true }).click();
  const accountCard = page.getByTestId(`admin-account-${ACCOUNT_ID}`);
  await expect(accountCard).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-admin-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(accountCard.getByRole('button', { name: 'Edit limits' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-admin-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const editLimits = accountCard.getByRole('button', { name: 'Edit limits' });
  await editLimits.focus();
  await page.keyboard.press('Tab');
  await expect(accountCard.getByRole('button', { name: 'Reset credentials' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(editLimits).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Daily credit limit')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-admin-edit-limits-320px.png'), fullPage: true });
  await page.getByLabel('Daily credit limit').fill('0');
  const saveLimits = accountCard.getByRole('button', { name: 'Save limits' });
  await saveLimits.focus();
  await page.keyboard.press('Enter');
  await expect(accountCard).toContainText('Remaining 0 / limit 0');

  await page.setViewportSize({ width: 640, height: 360 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const resetCredentials = accountCard.getByRole('button', { name: 'Reset credentials' });
  await resetCredentials.focus();
  const resetBounds = await resetCredentials.boundingBox();
  expect(resetBounds && resetBounds.y >= 0 && resetBounds.y + resetBounds.height <= 360).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-admin-reflow-width.png'), fullPage: true });

  await accountCard.getByRole('button', { name: 'Reset credentials' }).click();
  await page.getByLabel('New password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Reset credentials', exact: true }).click();
  await expect(page.getByTestId('admin-action-success')).toContainText('Credentials reset and sessions revoked.');
  await expect(page.locator('body')).not.toContainText(TEST_PASSWORD);
  await expect(page.getByText('Credentials reset', { exact: true })).toBeVisible();

  const artifacts = process.env.TASK36_ARTIFACTS;
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'admin-portal-mock-smoke.png'), fullPage: true });
  }

  await page.getByRole('button', { name: 'Account menu for Admin fixture' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByLabel('Account identifier').fill('browser-smoke-user');
  await page.getByLabel('Password').fill('mock-only-sign-in');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.goto('/usage');
  await expect(page.getByTestId('usage-page')).toBeVisible();
  await expect(page.getByTestId('usage-availability')).toContainText('An AI usage allowance has been reached.');
  await expect(page.getByTestId('usage-daily-credits')).toContainText('Remaining');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('task-5-4-usage-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-usage-mobile.png'), fullPage: true });
  if (artifacts) await page.screenshot({ path: join(artifacts, 'usage-exhausted-mock-smoke.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByTestId('home-ask-launcher').click();
  await expect(page.getByTestId('home-chat-input')).toBeDisabled();
  await page.getByTestId('home-chat-close').click();

  await page.goto('/tasks');
  const task = page.getByRole('link', { name: /Prepare weekly notes/u });
  await expect(task).toBeVisible();
  await task.click();
  const manualTitle = page.getByRole('textbox', { name: 'Task title' });
  await expect(manualTitle).toBeEnabled();
  await manualTitle.fill('Manually edited while AI is exhausted');
  await expect(manualTitle).toHaveValue('Manually edited while AI is exhausted');
});
