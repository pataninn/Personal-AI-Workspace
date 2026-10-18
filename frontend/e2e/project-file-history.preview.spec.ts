import { expect, test } from '@playwright/test';

const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
const RUN_ID = '34945bab-63b8-4487-9442-02018072b9a1';
const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';
const HISTORY_OUTCOMES = [
  { changeSetStatus: 'applied', operationStatus: 'applied', backupStatus: 'created' },
  { changeSetStatus: 'stale', operationStatus: 'applied', backupStatus: 'created' },
  { changeSetStatus: 'rejected', operationStatus: null, backupStatus: 'not_created' },
  { changeSetStatus: 'failed', operationStatus: 'failed', backupStatus: 'failed' }
] as const;

test('opens file history from activity, shows all outcomes, and filters applied operations without writes', async ({ page }) => {
  const writes: string[] = [];
  const historyReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/(?:ai-runs|file-history)(?:\/|$)/u.test(url.pathname) && request.method() !== 'GET') writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === `/api/v1/projects/${PROJECT_ID}/file-history`) historyReads.push(url.searchParams.get('outcome') ?? 'all');
  });

  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

  const item = {
    runId: RUN_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, status: 'succeeded', decision: 'approved', providerTransmission: 'transmitted_confirmed',
    createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:02.000Z', provider: 'NVIDIA hosted NIM', model: 'preview-model',
    requestPreview: 'Review a file history fixture.', context: { categories: ['Request'], fileCount: 1, factCount: 0, messageCount: 0, estimatedTokens: 18 },
    usage: { status: 'reported', promptTokens: 12, completionTokens: 6, totalTokens: 18 },
    cost: { status: 'unavailable', label: 'Unavailable — no rate configured' },
    changeSet: { status: 'applied', operationCount: 1, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1 }
  };
  const historyRows = Array.from({ length: 20 }, (_, index) => {
    const outcome = HISTORY_OUTCOMES[index % HISTORY_OUTCOMES.length] ?? HISTORY_OUTCOMES[0];
    return {
    changeSetId: `586ea1d7-9dcf-4c42-b9dd-${String(index + 1).padStart(12, '0')}`, projectId: PROJECT_ID,
    runId: `34945bab-63b8-4487-9442-${String(index + 1).padStart(12, '0')}`, conversationId: CONVERSATION_ID,
    operationId: `62b113bc-6638-4a65-8675-${String(index + 1).padStart(12, '0')}`, operationIndex: 0,
    operation: 'rename', matchedPath: 'src/new.ts', path: 'src/old.ts', destinationPath: 'src/new.ts', summary: `${outcome.changeSetStatus} operation summary`,
    ...outcome, createdAt: `2026-09-${30 - index}T00:00:00.000Z`, updatedAt: '2026-09-30T00:00:02.000Z'
    };
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/ai-runs**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { projectId: PROJECT_ID, items: [item], nextCursor: null }, error: null }) });
  });
  await page.route(`**/api/v1/ai-runs/${RUN_ID}/activity`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
      ...item, assistantPreview: null, selectedFiles: ['src/old.ts'], selectedFactTitles: [],
      operations: [{ operation: 'rename', path: 'src/old.ts', destinationPath: 'src/new.ts', outcome: 'applied', backupStatus: 'created' }], omittedOperationCount: 0
    }, error: null }) });
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/file-history**`, async (route) => {
    const url = new URL(route.request().url());
    const outcome = url.searchParams.get('outcome') ?? 'all';
    const path = url.searchParams.get('path');
    expect(path).toBe('src/new.ts');
    const rows = outcome === 'applied' ? historyRows.filter((row) => row.operationStatus === 'applied') : historyRows;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { projectId: PROJECT_ID, path, outcome, items: rows, nextCursor: null }, error: null }) });
  });

  await page.getByRole('navigation', { name: 'Active projects' }).getByRole('link', { name: 'Website redesign' }).click();
  await page.getByTestId('project-activity-link').click();
  await page.getByTestId(`activity-details-${RUN_ID}`).click();
  await page.getByRole('link', { name: 'View file history for src/new.ts' }).click();
  await expect(page.getByTestId('project-file-history-page')).toBeVisible();
  await expect(page.getByTestId('file-history-path')).toHaveText('src/new.ts');
  await expect(page.getByLabel('Show')).toBeVisible();
  await expect(page.getByTestId('file-history-list').getByTestId('file-history-item')).toHaveCount(20);
  for (const status of ['applied', 'stale', 'rejected', 'failed']) await expect(page.getByTestId('file-history-list')).toContainText(status);
  const outcomeFilter = page.getByTestId('file-history-outcome-filter');
  await outcomeFilter.focus();
  await expect(outcomeFilter).toBeFocused();
  await page.evaluate(() => performance.mark('file-history-filter-start'));
  await outcomeFilter.press('End');
  await expect(outcomeFilter).toHaveValue('applied');
  await expect(page.getByTestId('file-history-list').getByTestId('file-history-item')).toHaveCount(10);
  await expect(page.getByTestId('file-history-list')).toContainText('applied operation summary');
  await expect(page.getByTestId('file-history-list')).toContainText('stale operation summary');
  const filterRenderDuration = await page.evaluate(() => {
    performance.mark('file-history-filter-rendered');
    return performance.measure('file-history-filter-render', 'file-history-filter-start', 'file-history-filter-rendered').duration;
  });
  expect(filterRenderDuration).toBeLessThan(1500);
  expect(historyReads.length).toBeGreaterThanOrEqual(2);
  expect(historyReads.slice(0, -1).every((outcome) => outcome === 'all')).toBe(true);
  expect(historyReads.at(-1)).toBe('applied');
  expect(writes).toEqual([]);

  for (const width of [390, 640, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll<HTMLElement>('*')]
        .map((element) => ({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          testId: element.dataset.testid ?? '',
          left: Math.round(element.getBoundingClientRect().left),
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth
        }))
        .filter((element) => element.right > window.innerWidth || element.left < 0 || element.scrollWidth > element.clientWidth + 1)
        .slice(0, 15)
    }));
    expect(overflow.scrollWidth, JSON.stringify(overflow.elements)).toBeLessThanOrEqual(width);
  }
});
