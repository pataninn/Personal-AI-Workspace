import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PROJECT_ROOT_LABEL = 'Project root: .';
const PASSWORD_FILE_PARTS = ['Personal-AI-Workspace', 'private', 'secrets', 'local_user_password'];

test('manages a project fact and selects it for a run without starting an AI request', async ({ page }, testInfo) => {
  let projectId: string | null = null;
  let activeFactTitle: string | null = null;
  let aiRunCreateRequests = 0;
  page.on('request', (request) => {
    const requestURL = new URL(request.url());
    if (request.method() === 'POST' && projectId && requestURL.pathname === `/api/v1/projects/${projectId}/ai-runs`) {
      aiRunCreateRequests += 1;
    }
  });

  const marker = randomUUID().slice(0, 12);
  const initialTitle = `MVP2 browser fact ${marker}`;
  const editedTitle = `MVP2 browser fact edited ${marker}`;
  const initialContent = 'Temporary harmless Playwright memory fact.';
  const editedContent = 'Edited harmless Playwright memory fact.';
  activeFactTitle = initialTitle;

  try {
    const password = readLocalPassword();
    await page.goto('/login');
    await page.getByTestId('login-identifier-input').fill('owner');
    await page.getByTestId('login-password-input').fill(password);
    await page.getByTestId('login-submit-button').click();
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

    const directWorkspaceProject = page.getByTestId('project-item').filter({ hasText: PROJECT_ROOT_LABEL });
    await expect(directWorkspaceProject).toHaveCount(1);
    const projectLink = directWorkspaceProject.getByRole('link');
    const projectHref = await projectLink.getAttribute('href');
    if (!projectHref) {
      throw new Error('The direct workspace project link was unavailable.');
    }
    projectId = decodeURIComponent(new URL(projectHref, page.url()).pathname.split('/')[2] ?? '');
    if (!projectId) {
      throw new Error('The direct workspace project id was unavailable.');
    }

    const fixtureConversationId = randomUUID();
    const fixtureConversation = {
      id: fixtureConversationId,
      projectId,
      title: 'Temporary browser-only conversation',
      status: 'active',
      lastActivityAt: '2026-09-26T00:00:00.000Z',
      createdAt: '2026-09-26T00:00:00.000Z',
      updatedAt: '2026-09-26T00:00:00.000Z'
    };
    await page.route(`**/api/v1/projects/${projectId}/conversations**`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { conversations: [fixtureConversation], nextCursor: null }, error: null })
      });
    });
    await page.route(`**/api/v1/conversations/${fixtureConversationId}**`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { conversation: fixtureConversation, messages: [], nextBeforeSequence: null }, error: null })
      });
    });

    await projectLink.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/conversations/${fixtureConversationId}$`, 'u'));
    await expect(page.getByTestId('conversation-history')).toBeVisible();
    await expect(page.getByTestId('ai-run-entry')).toBeVisible();

    await page.getByTestId(`project-memory-nav-${projectId}`).click();
    await expect(page.getByTestId('project-memory-page')).toBeVisible();
    await page.getByTestId('project-memory-add').click();
    await expect(page.getByTestId('project-fact-editor-dialog')).toBeVisible();
    await page.getByTestId('project-fact-title').fill(initialTitle);
    await page.getByTestId('project-fact-content').fill(initialContent);
    await page.getByTestId('project-fact-save').click();

    let factCard = factCardFor(page, initialTitle);
    await expect(factCard).toContainText('Needs review');
    const reviewButtonTestId = await factCard.getByRole('button', { name: 'Mark as reviewed' }).getAttribute('data-testid');
    const factId = reviewButtonTestId?.replace(/^project-fact-review-/u, '');
    if (!factId) {
      throw new Error('The created fact did not expose its review action.');
    }
    await factCard.getByRole('button', { name: 'Mark as reviewed' }).click();
    await expect(factCard).toContainText('Verified by you');
    await factCard.screenshot({ path: testInfo.outputPath('project-fact-reviewed.png') });

    await factCard.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByTestId('project-fact-editor-dialog')).toBeVisible();
    await page.getByTestId('project-fact-title').fill(editedTitle);
    await page.getByTestId('project-fact-content').fill(editedContent);
    await page.getByTestId('project-fact-save').click();
    activeFactTitle = editedTitle;
    factCard = factCardFor(page, editedTitle);
    await expect(factCard).toContainText('Needs review');
    await factCard.getByRole('button', { name: 'Mark as reviewed' }).click();
    await expect(factCard).toContainText('Verified by you');

    await page.getByTestId('project-memory-back-to-project').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/conversations/${fixtureConversationId}$`, 'u'));
    await expect(page.getByTestId('ai-run-entry')).toBeVisible();
    await page.getByTestId('memory-context-open').click();
    const factCheckbox = page.getByTestId(`memory-context-fact-${factId}`);
    await expect(factCheckbox).toBeVisible();
    await expect(factCheckbox).not.toBeChecked();
    await factCheckbox.check();
    await page.getByTestId('memory-context-apply').click();
    await expect(page.getByTestId('memory-context-count')).toHaveText('1 fact selected');
    await expect(page.getByText(editedContent, { exact: true })).toBeVisible();
    expect(aiRunCreateRequests).toBe(0);

    await page.goto(`/projects/${encodeURIComponent(projectId)}/memory`);
    factCard = factCardFor(page, editedTitle);
    await expect(factCard).toBeVisible();
    await factCard.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('project-fact-delete-dialog')).toBeVisible();
    await page.getByTestId('project-fact-delete-confirm').click();
    await expect(factCard).toHaveCount(0);
    await page.reload();
    await expect(factCardFor(page, editedTitle)).toHaveCount(0);
    activeFactTitle = null;
    expect(aiRunCreateRequests).toBe(0);
  } finally {
    if (projectId && activeFactTitle) {
      await cleanupFact(page, projectId, activeFactTitle);
    }
  }
});

function readLocalPassword(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('Local AppData is not configured for the browser E2E process.');
  }
  const passwordPath = join(localAppData, ...PASSWORD_FILE_PARTS);
  const password = readFileSync(passwordPath, 'utf8').trim();
  if (!password) {
    throw new Error('The local browser E2E password file is empty.');
  }
  return password;
}

function factCardFor(page: Page, title: string) {
  return page.getByTestId('project-memory-fact').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function cleanupFact(page: Page, projectId: string, title: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectId)}/memory`);
  const card = factCardFor(page, title);
  if (await card.count() === 0) {
    return;
  }
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByTestId('project-fact-delete-confirm').click();
  await expect(card).toHaveCount(0);
}
