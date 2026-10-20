import { expect, test } from '@playwright/test';

const ALPHA_ID = '873c096a-bc57-4a0c-85da-10d4febde961';
const BETA_ID = '873c096a-bc57-4a0c-85da-10d4febde962';
const EXPORT_ALPHA = '6c640000-0000-4000-8000-000000000001';
const EXPORT_BETA = '6c640000-0000-4000-8000-000000000002';
const PREVIEW_CSRF = 'workspace-export-preview-csrf';
const PREVIEW_TIME = '2026-10-20T08:00:00.000Z';

interface CreateRequestRecord {
  readonly workspaceId: string;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

test('keeps an uncertain retry on its workspace and ignores its late response after switching', async ({ page }, testInfo) => {
  const creates: CreateRequestRecord[] = [];
  let alphaCreateCount = 0;
  let alphaSecondRequestPending = false;
  let releaseAlphaResponse: (() => void) | undefined;

  await installUsageApi(page, async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { readonly workspaceId: string };
    creates.push({ workspaceId: body.workspaceId, idempotencyKey: request.headers()['idempotency-key'], body });
    if (body.workspaceId === ALPHA_ID) {
      alphaCreateCount += 1;
      if (alphaCreateCount === 1) {
        await route.abort();
        return;
      }
      alphaSecondRequestPending = true;
      await new Promise<void>((resolve) => { releaseAlphaResponse = resolve; });
      await fulfillCreated(route, EXPORT_ALPHA, ALPHA_ID);
      return;
    }
    await fulfillCreated(route, EXPORT_BETA, BETA_ID);
  }, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="workspace-export-${EXPORT_BETA}.json"`,
        'X-Content-Type-Options': 'nosniff'
      },
      body: JSON.stringify({ manifest: { format: 'personal-ai-workspace-export', version: 1 }, workspace: { id: BETA_ID } })
    });
  });

  await page.goto('/usage');
  await expect(page.getByTestId('workspace-export')).toBeVisible();
  const workspaceSelect = page.getByTestId('workspace-export-project-select');
  await workspaceSelect.selectOption(ALPHA_ID);

  await page.getByRole('button', { name: 'Prepare export' }).click();
  await expect(page.getByTestId('workspace-export-create-error')).toContainText('Retry to check or prepare the same request');
  await page.getByRole('button', { name: 'Prepare export' }).click();
  await expect.poll(() => alphaSecondRequestPending).toBe(true);
  const lateAlphaResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v1/workspace-exports') && response.request().method() === 'POST' && response.status() === 201
  );

  await workspaceSelect.selectOption(BETA_ID);
  await page.getByRole('button', { name: 'Prepare export' }).click();
  await expect(page.getByTestId('workspace-export-ready')).toContainText('Beta workspace');
  expect(creates).toHaveLength(3);
  expect(creates[0]).toEqual(creates[1]);
  expect(creates[2]?.workspaceId).toBe(BETA_ID);
  expect(creates[2]?.body).toEqual({ workspaceId: BETA_ID });
  expect(creates[2]?.idempotencyKey).not.toBe(creates[1]?.idempotencyKey);

  releaseAlphaResponse?.();
  await lateAlphaResponse;
  await expect(page.getByTestId('workspace-export-ready')).toContainText('Beta workspace');
  await expect(page.getByTestId('workspace-export-ready')).not.toContainText('Alpha workspace');
  await page.getByTestId('workspace-export').screenshot({ path: testInfo.outputPath('workspace-export-usage-ready.png') });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`workspace-export-${EXPORT_BETA}.json`);
  await expect(page.getByTestId('usage-daily-credits')).toContainText('No AI usage yet.');
  await expect(page.getByTestId('usage-workspace-storage')).toContainText('17 bytes');
});

test('shows bounded, capacity, and unavailable errors without leaving a stale download', async ({ page }, testInfo) => {
  let alphaCreateCount = 0;
  const alphaKeys: string[] = [];
  await installUsageApi(page, async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { readonly workspaceId: string };
    if (body.workspaceId === ALPHA_ID) {
      alphaCreateCount += 1;
      alphaKeys.push(request.headers()['idempotency-key'] ?? '');
      if (alphaCreateCount === 1) {
        await route.fulfill({ status: 413, contentType: 'application/json', body: errorEnvelope('EXPORT_TOO_LARGE', 'The export exceeds its safe limits.') });
        return;
      }
      if (alphaCreateCount === 2) {
        await route.fulfill({ status: 422, contentType: 'application/json', body: errorEnvelope('EXPORT_CONTENT_UNSAFE', 'Workspace content contains credential-like text.') });
        return;
      }
      await fulfillCreated(route, EXPORT_ALPHA, ALPHA_ID);
      return;
    }
    await route.fulfill({ status: 429, contentType: 'application/json', body: errorEnvelope('EXPORT_LIMIT_REACHED', 'Too many exports are active.') });
  }, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: errorEnvelope('WORKSPACE_EXPORT_UNAVAILABLE', 'The workspace export is unavailable.')
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/usage');
  await expect(page.getByTestId('workspace-export')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-mobile.png'), fullPage: true });
  const workspaceSelect = page.getByTestId('workspace-export-project-select');
  await workspaceSelect.focus();
  await page.keyboard.press('ArrowDown');
  await expect(workspaceSelect).toHaveValue(ALPHA_ID);
  await page.keyboard.press('Tab');
  const prepareExport = page.getByRole('button', { name: 'Prepare export' });
  await expect(prepareExport).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workspace-export-create-error')).toContainText('exceeds the supported export size');
  await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-size-error.png'), fullPage: true });

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(prepareExport).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-320px.png'), fullPage: true });
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(prepareExport).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-640css-reflow.png'), fullPage: true });

  await workspaceSelect.selectOption(BETA_ID);
  await prepareExport.click();
  await expect(page.getByTestId('workspace-export-create-error')).toContainText('At most two exports can be active');
  await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);

  await workspaceSelect.selectOption(ALPHA_ID);
  await prepareExport.click();
  await expect(page.getByTestId('workspace-export-create-error')).toContainText('looks like a credential');
  await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);

  await prepareExport.click();
  await expect(page.getByTestId('workspace-export-ready')).toContainText('Alpha workspace');
  expect(alphaKeys[2]).not.toBe(alphaKeys[1]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-ready-desktop.png'), fullPage: true });
  const download = page.getByRole('button', { name: 'Download JSON' });
  await download.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workspace-export-download-error')).toContainText('This export is unavailable. Prepare a new export.');
  await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);
  await expect(page.getByTestId('usage-lifetime-credits')).toContainText('No AI usage yet.');
  await expect(page.getByTestId('usage-workspace-storage')).toContainText('17 bytes');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-export-unavailable-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(prepareExport).toBeVisible();
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function installUsageApi(
  page: import('@playwright/test').Page,
  create: (route: import('@playwright/test').Route) => Promise<void>,
  download: (route: import('@playwright/test').Route) => Promise<void>
): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/session') {
      await respond(route, 200, {
        principal: { id: 'preview-owner', displayName: 'Preview owner', accountKind: 'regular', role: 'user' },
        csrfToken: PREVIEW_CSRF, expiresAt: '2026-10-20T09:00:00.000Z'
      });
      return;
    }
    if (url.pathname === '/api/v1/projects') {
      await respond(route, 200, { projects: [project(ALPHA_ID, 'Alpha workspace'), project(BETA_ID, 'Beta workspace')] });
      return;
    }
    if (url.pathname === '/api/v1/account/usage') {
      await respond(route, 200, {
        asOf: PREVIEW_TIME, expiresAt: null,
        daily: { limitUnits: '100', settledUnits: '0', reservedUnits: '0', remainingUnits: '100', resetAt: PREVIEW_TIME, timeZone: 'UTC' },
        lifetime: { limitUnits: '1000', settledUnits: '0', reservedUnits: '0', remainingUnits: '1000' },
        storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '17', reservedBytes: '0', limitBytes: '1000', availableBytes: '983', overLimit: false, asOf: PREVIEW_TIME },
        availability: { status: 'available', reason: null, canSubmit: true }
      });
      return;
    }
    if (url.pathname === '/api/v1/assistant/execution-policy') {
      await respond(route, 200, {
        scope: { kind: url.searchParams.get('scope') ?? 'home', label: 'Preview workspace' },
        policy: { enabled: true, revision: 'preview-policy', provider: { name: 'Preview inference provider', model: 'preview-only' }, included: { categories: [], items: [] }, exclusionsEnforced: true, capabilities: [] },
        fileAccess: false, readiness: { state: 'ready' }
      });
      return;
    }
    if (url.pathname === '/api/v1/workspace-exports' && request.method() === 'POST') {
      await create(route);
      return;
    }
    if (url.pathname.startsWith('/api/v1/workspace-exports/') && request.method() === 'GET') {
      await download(route);
      return;
    }
    await respond(route, 404, null, { code: 'NOT_FOUND', message: 'No preview API route is configured.' });
  });
}

function project(id: string, name: string) {
  return {
    id, name, slug: name.toLowerCase().replaceAll(' ', '-'), objective: null, workspaceMode: 'planning',
    capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1,
    createdAt: PREVIEW_TIME, updatedAt: PREVIEW_TIME
  };
}

async function fulfillCreated(route: import('@playwright/test').Route, id: string, workspaceId: string): Promise<void> {
  await respond(route, 201, { export: { id, workspaceId, sizeBytes: 512, expiresAt: '2026-10-20T08:15:00.000Z' } });
}

async function respond(
  route: import('@playwright/test').Route,
  status: number,
  data: unknown,
  error: { readonly code: string; readonly message: string } | null = null
): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
}

function errorEnvelope(code: string, message: string): string { return JSON.stringify({ data: null, error: { code, message } }); }
