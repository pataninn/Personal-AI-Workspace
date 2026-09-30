import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const PROJECT_ROOT_LABEL = 'Project root: .';
const PASSWORD_FILE_PARTS = ['Personal-AI-Workspace', 'private', 'secrets', 'local_user_password'];

test('reviews project run activity and safe details without starting a provider request', async ({ page }) => {
  let projectId: string | null = null;
  let createRunRequests = 0;
  const runId = randomUUID();
  const conversationId = randomUUID();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && projectId && url.pathname === `/api/v1/projects/${projectId}/ai-runs`) {
      createRunRequests += 1;
    }
  });

  await page.goto('/login');
  await page.getByTestId('login-password-input').fill(readLocalPassword());
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

  const directProject = page.getByTestId('project-item').filter({ hasText: PROJECT_ROOT_LABEL });
  await expect(directProject).toHaveCount(1);
  const projectLink = directProject.getByRole('link');
  const href = await projectLink.getAttribute('href');
  if (!href) throw new Error('The direct workspace project link was unavailable.');
  projectId = decodeURIComponent(new URL(href, page.url()).pathname.split('/')[2] ?? '');
  if (!projectId) throw new Error('The direct workspace project id was unavailable.');

  const activityItem = {
    runId,
    projectId,
    conversationId,
    status: 'succeeded',
    decision: 'approved',
    providerTransmission: 'transmitted_confirmed',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:02.000Z',
    provider: 'NVIDIA hosted NIM',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    requestPreview: 'Review activity fixture.',
    context: { categories: ['Request', 'Project files'], fileCount: 1, factCount: 0, messageCount: 0, estimatedTokens: 32 },
    usage: { status: 'partial', promptTokens: 28, completionTokens: null, totalTokens: null },
    cost: { status: 'unavailable', label: 'Unavailable — no rate configured' },
    changeSet: { status: 'applied', operationCount: 1, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1 }
  };
  await page.route(`**/api/v1/projects/${projectId}/ai-runs**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { projectId, items: [activityItem], nextCursor: null }, error: null }) });
  });
  await page.route(`**/api/v1/ai-runs/${runId}/activity`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
      ...activityItem,
      assistantPreview: 'password=[REDACTED] safe answer',
      selectedFiles: ['src/app.ts'],
      selectedFactTitles: [],
      operations: [{ operation: 'edit', path: 'src/app.ts', outcome: 'applied', backupStatus: 'created' }],
      omittedOperationCount: 0
    }, error: null }) });
  });

  await projectLink.click();
  await page.getByTestId('project-activity-link').click();
  await expect(page.getByTestId('project-activity-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review activity fixture.' })).toBeVisible();
  await expect(page.getByText('32 tokens (estimate)')).toBeVisible();
  await expect(page.getByText('Unavailable — no rate configured')).toBeVisible();
  await page.getByTestId(`activity-details-${runId}`).click();
  await expect(page.getByText('password=[REDACTED] safe answer')).toBeVisible();
  await expect(page.getByText(/backup created/u)).toBeVisible();
  expect(createRunRequests).toBe(0);
});

function readLocalPassword(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('Local AppData is not configured for the browser E2E process.');
  const password = readFileSync(join(localAppData, ...PASSWORD_FILE_PARTS), 'utf8').trim();
  if (!password) throw new Error('The local browser E2E password file is empty.');
  return password;
}
