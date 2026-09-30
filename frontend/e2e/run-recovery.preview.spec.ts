import { expect, test } from '@playwright/test';

const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';

test('confirms cancellation only after the saved run reports cancelled', async ({ page }) => {
  const runs = await installRunRoutes(page, 'running');
  let cancelHeaders: Record<string, string> | null = null;
  runs.setCancelHeaders((headers) => { cancelHeaders = headers; });

  await openConversation(page);
  await approveRun(page);
  await expect(page.getByTestId('ai-run-cancel')).toBeEnabled();
  await page.getByTestId('ai-run-cancel').click();

  await expect(page.getByTestId('run-cancelled')).toContainText('Run cancelled. No further assistant work will be applied.');
  expect(runs.startCount()).toBe(1);
  expect(runs.cancelCount()).toBe(1);
  expect(cancelHeaders?.['x-csrf-token']).toBe('preview-only-csrf-token');
});

test('restores an interrupted run for review and retries with a new run ID', async ({ page }) => {
  const runs = await installRunRoutes(page, 'review_required');
  await openConversation(page);
  await approveRun(page);

  await expect(page.getByTestId('ai-run-review-required')).toContainText('The run needs manual review');
  const interruptedRunId = new URL(page.url()).searchParams.get('runId');
  expect(interruptedRunId).toBeTruthy();
  await page.getByTestId('ai-run-safe-retry').click();

  await expect(page.getByTestId('provider-consent-alert-dialog')).toBeVisible();
  const retryRunId = new URL(page.url()).searchParams.get('runId');
  expect(retryRunId).toBeTruthy();
  expect(retryRunId).not.toBe(interruptedRunId);
  expect(runs.startCount()).toBe(1);
  expect(await runs.createdRunIds()).toHaveLength(2);
});

async function openConversation(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByTestId('provider-permission-manager')).toBeVisible();
  await page.getByTestId('message-input').fill('Review the project and return the result.');
  await expect(page.getByTestId('ai-run-submit')).toBeEnabled();
}

async function approveRun(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('ai-run-submit').click();
  const consent = page.getByTestId('provider-consent-alert-dialog');
  await expect(consent).toBeVisible();
  await consent.getByTestId('provider-consent-approve').click();
  await expect(consent).toBeHidden();
}

async function installRunRoutes(page: import('@playwright/test').Page, startStatus: 'running' | 'review_required'): Promise<{
  readonly startCount: () => number;
  readonly cancelCount: () => number;
  readonly createdRunIds: () => readonly string[];
  readonly setCancelHeaders: (set: (headers: Record<string, string>) => void) => void;
}> {
  const snapshots = new Map<string, Record<string, unknown>>();
  const createdIds: string[] = [];
  let starts = 0;
  let cancels = 0;
  let saveCancelHeaders: (headers: Record<string, string>) => void = () => undefined;

  await page.route(`**/api/v1/projects/${PROJECT_ID}/provider-permissions**`, async (route) => {
    await route.fulfill(envelope({ permissions: [] }));
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/ai-runs`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: { run: Record<string, unknown> } };
    const run = payload.data.run;
    const runId = String(run.runId);
    createdIds.push(runId);
    snapshots.set(runId, run);
    await route.fulfill({ response });
  });

  await page.route('**/api/v1/ai-runs/**', async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const runId = parts[3];
    const suffix = parts.slice(4).join('/');
    const current = snapshots.get(runId);
    if (suffix === 'events') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      return;
    }
    if (route.request().method() === 'GET' && suffix === '' && current) {
      await route.fulfill(envelope(current));
      return;
    }
    if (route.request().method() === 'POST' && suffix === 'start' && current) {
      starts += 1;
      const interrupted = startStatus === 'review_required';
      const next = {
        ...current,
        status: interrupted ? 'review_required' : 'running',
        phase: interrupted ? 'review' : 'inference',
        decision: 'approved',
        cleanup: interrupted ? 'unknown' : 'unknown',
        providerTransmission: interrupted ? 'not_started_confirmed' : 'transmitted_confirmed',
        safeMessage: interrupted
          ? 'The app restarted while this run was active. Review its saved status; no work was resumed automatically.'
          : 'Assistant is working.'
      };
      snapshots.set(runId, next);
      await route.fulfill(envelope(next));
      return;
    }
    if (route.request().method() === 'POST' && suffix === 'cancel' && current) {
      cancels += 1;
      saveCancelHeaders(await route.request().allHeaders());
      const next = { ...current, status: 'cancelled', phase: 'terminal', cleanup: 'complete', safeMessage: 'Run cancelled. No further assistant work will be applied.' };
      snapshots.set(runId, next);
      await route.fulfill(envelope(next));
      return;
    }
    await route.fallback();
  });

  return {
    startCount: () => starts,
    cancelCount: () => cancels,
    createdRunIds: () => [...createdIds],
    setCancelHeaders: (set) => { saveCancelHeaders = set; }
  };
}

function envelope(data: unknown): { readonly status: number; readonly contentType: string; readonly body: string } {
  return { status: 200, contentType: 'application/json', body: JSON.stringify({ data, error: null }) };
}
