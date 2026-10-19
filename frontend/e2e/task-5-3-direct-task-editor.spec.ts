import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5193' });

const TASK_ID = '33333333-3333-4333-8333-333333333333';
const ACTION_ID = '44444444-4444-4444-8444-444444444444';
const SUBTASK_ID = '55555555-5555-4555-8555-555555555555';

type Task = {
  id: string;
  projectId: null;
  title: string;
  details: string | null;
  importance: 'low' | 'medium' | 'high' | 'urgent';
  deadline: string | null;
  subtasks: { id: string; title: string; completed: boolean }[];
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  position: number;
  version: number;
  source: { kind: 'user'; label: string; suggestionId: null; runId: null; conversationId: null; acceptedAt: null };
  createdAt: string;
  updatedAt: string;
  completedAt: null;
};

function createTask(): Task {
  return {
    id: TASK_ID, projectId: null, title: 'Review the project plan', details: 'Check dates before sharing.', importance: 'medium', deadline: null,
    subtasks: [{ id: SUBTASK_ID, title: 'Confirm dates', completed: false }], status: 'todo', position: 0, version: 1,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z', completedAt: null
  };
}

function envelope(data: unknown): { readonly data: unknown; readonly error: null } {
  return { data, error: null };
}

async function mockTaskApi(page: import('@playwright/test').Page): Promise<{ readonly requests: string[] }> {
  let task = createTask();
  let conflictReturned = false;
  let deleted = false;
  const requests: string[] = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const reply = async (data: unknown, status = 200): Promise<void> => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(envelope(data))
    });

    if (url.pathname === '/api/v1/auth/session' && method === 'GET') {
      await reply({ principal: { id: 'owner-1', displayName: 'Task editor smoke', accountKind: 'regular', role: 'user' }, csrfToken: 'mock-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
      requests.push('POST /api/v1/auth/logout');
      await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === '/api/v1/projects' && method === 'GET') { await reply({ projects: [] }); return; }
    if (url.pathname === '/api/v1/account/usage' && method === 'GET') {
      await reply({ asOf: '2026-10-19T10:00:00.000Z', expiresAt: null,
        daily: { limitUnits: '0', settledUnits: '0', reservedUnits: '0', remainingUnits: '0', resetAt: '2026-10-20T00:00:00.000Z', timeZone: 'UTC' },
        lifetime: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
        storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '0', reservedBytes: '0', limitBytes: null, availableBytes: null, overLimit: false, asOf: '2026-10-19T10:00:00.000Z' },
        availability: { status: 'unknown', reason: 'Mock browser route.', canSubmit: false } });
      return;
    }
    if (url.pathname === '/api/v1/assistant/execution-policy' && method === 'GET') {
      await reply({ scope: { kind: 'home', label: 'Home' }, policy: null, fileAccess: false, readiness: { state: 'unavailable', reasonCode: 'provider_unconfigured' } });
      return;
    }
    if (url.pathname === '/api/v1/home/conversations' && method === 'GET') { await reply({ conversations: [], nextCursor: null }); return; }
    if (url.pathname === '/api/v1/tasks/inbox/count' && method === 'GET') { await reply({ count: deleted ? 0 : 1 }); return; }
    if (url.pathname === `/api/v1/tasks/${TASK_ID}` && method === 'GET') {
      if (deleted) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'PROJECT_TASK_NOT_FOUND', message: 'Not found.' } }) });
      } else {
        await reply({ task, collection: 'inbox', workspace: null });
      }
      return;
    }
    if (url.pathname === `/api/v1/tasks/${TASK_ID}` && method === 'PATCH') {
      requests.push('PATCH /api/v1/tasks/:taskId');
      if (!conflictReturned) {
        conflictReturned = true;
        task = { ...task, details: 'Latest saved detail from another editor.', version: 2 };
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'PROJECT_TASK_VERSION_CONFLICT', message: 'This task changed.' } }) });
        return;
      }
      const patch = request.postDataJSON() as Partial<Task>;
      task = { ...task, ...patch, version: task.version + 1, updatedAt: '2026-10-19T10:05:00.000Z' };
      await reply({ item: { task, collection: 'inbox', workspace: null }, receipt: { id: ACTION_ID, actionKind: 'task.update', undoStatus: 'available' }, replayed: false });
      return;
    }
    if (url.pathname === `/api/v1/tasks/${TASK_ID}` && method === 'DELETE') {
      requests.push('DELETE /api/v1/tasks/:taskId');
      deleted = true;
      await reply({ taskId: TASK_ID, orderVersion: 2, replayed: false, receipt: {
        id: ACTION_ID, actionKind: 'task.delete', undoStatus: 'not_reversible',
        outcome: { targetId: TASK_ID, targetVersion: null, sourceOrderVersion: 2 }
      } });
      return;
    }
    if (url.pathname === `/api/v1/actions/${ACTION_ID}` && method === 'GET') {
      await reply({ id: ACTION_ID, actionKind: 'task.update', actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK_ID, postVersion: task.version, undoStatus: 'available', undoActionId: null });
      return;
    }
    if (url.pathname === '/api/v1/tasks' && method === 'GET') {
      await reply({ items: deleted ? [] : [{ task, collection: 'inbox', workspace: null }], nextCursor: null });
      return;
    }

    requests.push(`UNEXPECTED ${method} ${url.pathname}`);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'MOCK_ROUTE_NOT_FOUND', message: 'This browser smoke uses local mock routes only.' } }) });
  });
  return { requests };
}

async function saveScreenshot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const artifacts = process.env.TASK53_ARTIFACTS;
  if (!artifacts) return;
  await mkdir(artifacts, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, name) });
}

test('saves, reviews a version conflict, protects navigation, and confirms delete', async ({ page }) => {
  const api = await mockTaskApi(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/tasks/${TASK_ID}`);

  await expect(page.getByTestId('task-detail-editor')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review the project plan' })).toBeFocused();
  await page.keyboard.press('Tab');
  const title = page.getByLabel('Task title');
  await expect(title).toBeFocused();
  await expect(page.getByTestId('task-detail-save')).toBeDisabled();
  await page.getByTestId('task-detail-back-to-tasks').click();
  await expect(page).toHaveURL('/tasks');
  await expect(page.getByTestId('task-dirty-exit-confirmation')).not.toBeVisible();
  await page.goto(`/tasks/${TASK_ID}`);
  await expect(page.getByTestId('task-detail-editor')).toBeVisible();

  const loadedTitle = page.getByLabel('Task title');
  await loadedTitle.fill('Plan reviewed by me');
  await page.getByTestId('task-detail-save').click();
  const conflict = page.getByTestId('project-task-version-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole('region', { name: 'Your draft' })).toContainText('Plan reviewed by me');
  await expect(conflict.getByRole('region', { name: 'Latest saved' })).toContainText('Latest saved detail from another editor.');
  await saveScreenshot(page, 'task-editor-conflict-mobile.png');

  await page.getByTestId('project-task-conflict-keep-editing').click();
  await expect(title).toHaveValue('Plan reviewed by me');
  await expect(page.getByLabel('Details (optional)')).toHaveValue('Latest saved detail from another editor.');
  await page.getByTestId('task-detail-save').click();
  await expect(page.getByTestId('task-save-notice')).toHaveText('Task saved.');
  await expect(page.getByRole('heading', { name: 'Plan reviewed by me' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await saveScreenshot(page, 'task-editor-saved-mobile.png');

  await title.fill('A draft kept through navigation');
  await page.getByTestId('task-detail-back-to-tasks').focus();
  await page.keyboard.press('Enter');
  const exitDialog = page.getByTestId('task-dirty-exit-confirmation');
  await expect(exitDialog).toBeVisible();
  await page.getByTestId('task-dirty-exit-keep').click();
  await expect(page).toHaveURL(`/tasks/${TASK_ID}`);
  await expect(title).toHaveValue('A draft kept through navigation');

  await page.getByTestId('task-detail-back-to-tasks').click();
  await expect(exitDialog).toBeVisible();
  await page.getByTestId('task-dirty-exit-discard').click();
  await expect(page).toHaveURL('/tasks');
  await expect(page.getByRole('heading', { name: 'All tasks' })).toBeVisible();

  await page.goto(`/tasks/${TASK_ID}`);
  await expect(page.getByTestId('task-detail-editor')).toBeVisible();
  await page.getByLabel('Task title').fill('Unsaved draft to delete');
  await page.getByRole('button', { name: 'Delete' }).click();
  const deleteDialog = page.getByTestId('task-delete-confirmation');
  await expect(deleteDialog).toContainText('Your unsaved edits will also be discarded.');
  await saveScreenshot(page, 'task-editor-dirty-delete-confirmation.png');
  await page.getByTestId('task-delete-confirmation-cancel').click();
  await expect(page.getByLabel('Task title')).toHaveValue('Unsaved draft to delete');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('task-delete-confirmation-confirm').click();
  await expect(page).toHaveURL('/tasks');
  await expect(page.getByTestId('global-task-empty')).toBeVisible();
  expect(api.requests.filter((request) => request.startsWith('UNEXPECTED'))).toEqual([]);
});

test('keeps the session and draft when sign-out is canceled, then discards only after confirmation', async ({ page }) => {
  const api = await mockTaskApi(page);
  await page.goto(`/tasks/${TASK_ID}`);
  await expect(page.getByTestId('task-detail-editor')).toBeVisible();
  const title = page.getByLabel('Task title');
  await title.fill('Private unsaved task draft');

  const accountMenu = page.getByRole('button', { name: 'Account menu for Task editor smoke' });
  await accountMenu.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const exitDialog = page.getByTestId('task-dirty-exit-confirmation');
  await expect(exitDialog).toBeVisible();
  await page.getByTestId('task-dirty-exit-keep').click();
  await expect(title).toHaveValue('Private unsaved task draft');
  expect(api.requests).not.toContain('POST /api/v1/auth/logout');

  await accountMenu.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(exitDialog).toBeVisible();
  await page.getByTestId('task-dirty-exit-discard').click();
  await expect(page).toHaveURL(/\/login\?reason=signed-out$/u);
  await expect(page.getByTestId('login-page')).toBeVisible();
  expect(api.requests).toContain('POST /api/v1/auth/logout');
});
