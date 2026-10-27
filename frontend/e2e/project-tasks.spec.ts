import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

const DIRECT_PROJECT_ROOT = 'Project root: .';
const LOCAL_PASSWORD_PATH = ['Personal-AI-Workspace', 'private', 'secrets', 'local_user_password'];
// PowerShell opt-in: $env:PAI_MVP2_ACCEPTED_SUGGESTION_CONVERSATION_ID='<uuid>'; pnpm.cmd --filter personal-ai-workspace-frontend test:e2e
const ACCEPTED_SUGGESTION_CONVERSATION_ID = process.env.PAI_MVP2_ACCEPTED_SUGGESTION_CONVERSATION_ID;

test('creates, edits, reorders, completes, and archives project tasks', async ({ page }) => {
  const marker = randomUUID().slice(0, 12);
  const firstTitle = `MVP2 task E2E ${marker}`;
  const editedTitle = `MVP2 task E2E edited ${marker}`;
  const secondTitle = `MVP2 task E2E second ${marker}`;
  const firstDetails = 'Temporary harmless browser task used for the planning flow.';
  const editedDetails = 'Edited harmless browser task used for the planning flow.';
  const secondDetails = 'Temporary second task used to verify persisted ordering.';
  const trackedTaskTitles = [firstTitle, secondTitle];
  const aiRunWrites = monitorAiRunWrites(page);
  let projectId: string | null = null;

  try {
    projectId = await signInAndGetDirectProjectId(page);
    const initialTasksResponse = waitForTaskView(page, projectId, 'all');
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await initialTasksResponse;
    await expect(page.getByTestId('project-tasks-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project tasks' })).toBeVisible();

    await createTask(page, projectId, firstTitle, firstDetails);
    await expect(taskRowFor(page, firstTitle)).toContainText('To do');
    await expect(taskRowFor(page, firstTitle)).toContainText('Added by you');

    await createTask(page, projectId, secondTitle, secondDetails);
    await expect(taskRowFor(page, secondTitle)).toContainText('To do');

    const firstTaskRow = taskRowFor(page, firstTitle);
    await firstTaskRow.getByRole('button', { name: `Actions for ${firstTitle}` }).click();
    await page.getByRole('menuitem', { name: 'Edit task', exact: true }).click();
    await expect(page.getByTestId('project-task-editor-dialog')).toBeVisible();
    await page.getByTestId('project-task-title-input').fill(editedTitle);
    await page.getByTestId('project-task-details-input').fill(editedDetails);
    const editResponse = waitForTaskMutation(page, projectId, 'PATCH');
    await page.getByTestId('project-task-editor-save').click();
    expect((await editResponse).status()).toBe(200);
    trackedTaskTitles.push(editedTitle);
    await expect(taskRowFor(page, editedTitle)).toContainText(editedDetails);
    await expect(page.getByTestId('project-tasks-announcement')).toHaveText('Changes saved');

    const reorderResponse = waitForTaskOrderMutation(page, projectId);
    await taskRowFor(page, secondTitle).getByRole('button', { name: /Move .* up/u }).click();
    expect((await reorderResponse).status()).toBe(200);
    await expect(page.getByTestId('project-tasks-announcement')).toContainText('moved to position');
    const editedPosition = await taskRowFor(page, editedTitle).evaluate((row) => Array.from(row.parentElement?.children ?? []).indexOf(row));
    const secondPosition = await taskRowFor(page, secondTitle).evaluate((row) => Array.from(row.parentElement?.children ?? []).indexOf(row));
    expect(secondPosition).toBe(editedPosition - 1);

    const completionRow = taskRowFor(page, editedTitle);
    await completionRow.getByRole('button', { name: 'Mark complete', exact: true }).click();
    const completionDialog = page.getByTestId('project-task-status-confirmation');
    await expect(completionDialog).toBeVisible();
    await expect(completionDialog).toContainText('You can still view it there.');
    const completionResponse = waitForTaskMutation(page, projectId, 'PATCH');
    await completionDialog.getByRole('button', { name: 'Mark complete', exact: true }).click();
    expect((await completionResponse).status()).toBe(200);
    await expect(taskRowFor(page, editedTitle)).toContainText('Done');
    await expect(page.getByTestId('project-tasks-announcement')).toContainText('marked complete');

    const completedFilterResponse = waitForTaskView(page, projectId, 'completed');
    await page.getByTestId('project-task-filter-completed').click();
    await completedFilterResponse;
    await expect(taskRowFor(page, editedTitle)).toBeVisible();
    await expect(taskRowFor(page, editedTitle).getByRole('button', { name: /Move .* up/u })).toBeDisabled();

    await archiveTask(page, projectId, taskRowFor(page, editedTitle));
    await expect(taskRowFor(page, editedTitle)).toHaveCount(0);
    const allFilterResponse = waitForTaskView(page, projectId, 'all');
    await page.getByTestId('project-task-filter-all').click();
    await allFilterResponse;
    await expect(taskRowFor(page, secondTitle)).toBeVisible();
    await archiveTask(page, projectId, taskRowFor(page, secondTitle));
    await expect(taskRowFor(page, secondTitle)).toHaveCount(0);

    const archivedFilterResponse = waitForTaskView(page, projectId, 'archived');
    await page.getByTestId('project-task-filter-archived').click();
    await archivedFilterResponse;
    await expect(taskRowFor(page, editedTitle)).toContainText('Archived');
    await expect(taskRowFor(page, secondTitle)).toContainText('Archived');

    const reloadResponse = waitForTaskView(page, projectId, 'all');
    await page.reload();
    await reloadResponse;
    const archivedReloadResponse = waitForTaskView(page, projectId, 'archived');
    await page.getByTestId('project-task-filter-archived').click();
    await archivedReloadResponse;
    await expect(taskRowFor(page, editedTitle)).toContainText('Archived');
    await expect(taskRowFor(page, secondTitle)).toContainText('Archived');
    expect(aiRunWrites()).toBe(0);
  } finally {
    if (projectId) {
      await archiveTrackedTasksIfActive(page, projectId, trackedTaskTitles);
    }
  }
});

test('shows the accepted assistant suggestion after reloading its conversation', async ({ page }) => {
  test.skip(!ACCEPTED_SUGGESTION_CONVERSATION_ID, 'Set PAI_MVP2_ACCEPTED_SUGGESTION_CONVERSATION_ID for the live accepted-suggestion check.');
  if (!ACCEPTED_SUGGESTION_CONVERSATION_ID) {
    return;
  }

  const aiRunWrites = monitorAiRunWrites(page);
  const projectId = await signInAndGetDirectProjectId(page);
  const url = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ACCEPTED_SUGGESTION_CONVERSATION_ID)}`;
  const firstSuggestionsResponse = waitForConversationSuggestions(page, projectId, ACCEPTED_SUGGESTION_CONVERSATION_ID);
  await page.goto(url);
  expect((await firstSuggestionsResponse).status()).toBe(200);
  await expect(page.getByTestId('conversation-history')).toBeVisible();
  await expectAcceptedSuggestion(page);

  const reloadSuggestionsResponse = waitForConversationSuggestions(page, projectId, ACCEPTED_SUGGESTION_CONVERSATION_ID);
  await page.reload();
  expect((await reloadSuggestionsResponse).status()).toBe(200);
  await expectAcceptedSuggestion(page);
  expect(aiRunWrites()).toBe(0);
});

async function signInAndGetDirectProjectId(page: Page): Promise<string> {
  const password = readLocalPassword();
  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill(password);
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

  const projectCard = page.getByTestId('project-item').filter({ hasText: DIRECT_PROJECT_ROOT });
  await expect(projectCard).toHaveCount(1);
  const href = await projectCard.getByRole('link').getAttribute('href');
  if (!href) {
    throw new Error('The direct workspace project link was unavailable.');
  }
  const projectId = decodeURIComponent(new URL(href, page.url()).pathname.split('/')[2] ?? '');
  if (!projectId) {
    throw new Error('The direct workspace project id was unavailable.');
  }
  await projectCard.getByRole('link').click();
  await expect(page.getByTestId(`project-tasks-nav-${projectId}`)).toBeVisible();
  return projectId;
}

function readLocalPassword(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('Local AppData is not configured for the browser E2E process.');
  }
  const password = readFileSync(join(localAppData, ...LOCAL_PASSWORD_PATH), 'utf8').trim();
  if (!password) {
    throw new Error('The local browser E2E password file is empty.');
  }
  return password;
}

async function createTask(page: Page, projectId: string, title: string, details: string): Promise<void> {
  await page.getByTestId('project-task-add').click();
  await expect(page.getByTestId('project-task-editor-dialog')).toBeVisible();
  await page.getByTestId('project-task-title-input').fill(title);
  await page.getByTestId('project-task-details-input').fill(details);
  const response = waitForTaskCreation(page, projectId);
  await page.getByTestId('project-task-editor-save').click();
  expect((await response).status()).toBe(201);
  await expect(page.getByTestId('project-tasks-announcement')).toHaveText('Task added');
  await expect(taskRowFor(page, title)).toBeVisible();
}

async function archiveTask(page: Page, projectId: string, row: Locator): Promise<void> {
  await row.getByRole('button', { name: /^Actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Archive task', exact: true }).click();
  const dialog = page.getByTestId('project-task-status-confirmation');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('removed from the active task order.');
  const response = waitForTaskMutation(page, projectId, 'PATCH');
  await dialog.getByRole('button', { name: 'Archive task', exact: true }).click();
  expect((await response).status()).toBe(200);
}

async function archiveTrackedTasksIfActive(page: Page, projectId: string, titles: readonly string[]): Promise<void> {
  const tasksResponse = waitForTaskView(page, projectId, 'all');
  await page.goto(`/projects/${encodeURIComponent(projectId)}/tasks`);
  await tasksResponse;
  for (const title of titles) {
    const row = taskRowFor(page, title);
    if (await row.count() > 0) {
      await archiveTask(page, projectId, row);
      await expect(taskRowFor(page, title)).toHaveCount(0);
    }
  }
}

function taskRowFor(page: Page, title: string): Locator {
  return page.getByTestId('project-task-list').getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function waitForTaskView(page: Page, projectId: string, filter: string) {
  return page.waitForResponse((response) => {
    const responseURL = new URL(response.url());
    return response.request().method() === 'GET'
      && responseURL.pathname === `/api/v1/projects/${projectId}/tasks`
      && responseURL.searchParams.get('status') === filter;
  });
}

function waitForTaskCreation(page: Page, projectId: string) {
  return page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks`);
}

function waitForTaskMutation(page: Page, projectId: string, method: 'PATCH') {
  return page.waitForResponse((response) => response.request().method() === method
    && new URL(response.url()).pathname.startsWith(`/api/v1/projects/${projectId}/tasks/`));
}

function waitForTaskOrderMutation(page: Page, projectId: string) {
  return page.waitForResponse((response) => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-order`);
}

function waitForConversationSuggestions(page: Page, projectId: string, conversationId: string) {
  return page.waitForResponse((response) => {
    const responseURL = new URL(response.url());
    return response.request().method() === 'GET'
      && responseURL.pathname === `/api/v1/projects/${projectId}/task-suggestions`
      && responseURL.searchParams.get('conversationId') === conversationId
      && responseURL.searchParams.get('status') === 'all';
  });
}

async function expectAcceptedSuggestion(page: Page): Promise<void> {
  const suggestionSection = page.getByTestId('conversation-task-suggestions');
  await expect(suggestionSection).toBeVisible();
  await expect(suggestionSection.getByText('Accepted by you', { exact: true }).first()).toBeVisible();
  await expect(suggestionSection.getByText(/Added from an assistant suggestion/u).first()).toBeVisible();
}

function monitorAiRunWrites(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') {
      return;
    }
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/v1\/projects\/[^/]+\/ai-runs$/u.test(pathname)
      || /^\/api\/v1\/ai-runs\/[^/]+\/(?:start|egress-decision)$/u.test(pathname)) {
      count += 1;
    }
  });
  return () => count;
}
