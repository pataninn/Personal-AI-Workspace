import { expect, test } from '@playwright/test';

const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
const RUN_ID = '34945bab-63b8-4487-9442-02018072b9a1';
const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';

test('opens the project activity page, filters a run, and expands safe detail', async ({ page }) => {
  let runIntentWrites = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/projects/${PROJECT_ID}/ai-runs`) {
      runIntentWrites += 1;
    }
  });

  await page.goto('/login');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

  const item = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    status: 'succeeded',
    decision: 'approved',
    providerTransmission: 'transmitted_confirmed',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:02.000Z',
    provider: 'NVIDIA hosted NIM',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    requestPreview: 'Review the activity summary.',
    context: { categories: ['Request', 'Project files'], fileCount: 1, factCount: 0, messageCount: 1, estimatedTokens: 27 },
    usage: { status: 'partial', promptTokens: 24, completionTokens: null, totalTokens: null },
    cost: { status: 'unavailable', label: 'Unavailable — no rate configured' },
    changeSet: { status: 'applied', operationCount: 1, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1 }
  };
  await page.route(`**/api/v1/projects/${PROJECT_ID}/ai-runs**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { projectId: PROJECT_ID, items: [item], nextCursor: null }, error: null }) });
  });
  await page.route(`**/api/v1/ai-runs/${RUN_ID}/activity`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
      ...item,
      assistantPreview: 'A safe saved response.',
      selectedFiles: ['src/app.ts'],
      selectedFactTitles: ['Homepage objective'],
      operations: [{ operation: 'edit', path: 'src/app.ts', outcome: 'applied', backupStatus: 'created' }],
      omittedOperationCount: 0
    }, error: null }) });
  });

  await page.getByTestId(`project-item`).filter({ hasText: 'Website redesign' }).getByRole('link').click();
  await page.getByTestId('project-activity-link').click();
  await expect(page.getByTestId('project-activity-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: item.requestPreview })).toBeVisible();
  await expect(page.getByText('27 tokens (estimate)')).toBeVisible();
  await expect(page.getByText('Prompt: 24 · Completion: Not available · Total: Not available')).toBeVisible();
  await expect(page.getByText('Cost: Unavailable — no rate configured')).toBeVisible();

  await page.getByTestId(`activity-details-${RUN_ID}`).click();
  await expect(page.getByText('A safe saved response.')).toBeVisible();
  await expect(page.getByText('src/app.ts').first()).toBeVisible();
  await page.getByLabel('Show').selectOption('succeeded');
  await expect(page.getByRole('heading', { name: item.requestPreview })).toBeVisible();
  expect(runIntentWrites).toBe(0);
});
