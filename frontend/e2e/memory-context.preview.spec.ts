import { expect, test } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';
import { installFixture, saveBrowserEvidence, setBrowserEvidenceMetadata, signIn, startBrowserEvidence } from './home-chat-preview-test-utils';

const PROJECT_ID = 'c6200000-0000-4000-8000-000000000061';
const FACT_ID = 'c6200000-0000-4000-8000-000000000062';
const SYNTHETIC_TIME = '2026-10-19T00:00:00.000Z';

test.beforeEach(async ({ page }) => startBrowserEvidence(page));

test.afterEach(async ({ page }, testInfo) => {
  await saveBrowserEvidence(page, testInfo.title, testInfo.outputDir);
});

test('planning-only memory disclosure and selected facts carry into a fresh workspace chat', async ({ page }, testInfo) => {
  const memoryState: { fact: Record<string, unknown> | null } = { fact: null };
  let context = {
    relativePaths: [] as string[],
    factIds: [] as string[],
    includeProjectConversations: true,
    excludedPaths: [] as string[],
    availablePaths: [] as string[],
    fileSelectionLimited: false
  };
  const fixture = new HomeChatPreviewApi(page, { scope: { kind: 'workspace', workspaceId: PROJECT_ID } });
  await installFixture(page, fixture);

  await page.route(`**/api/v1/projects/${PROJECT_ID}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.slice(`/api/v1/projects/${PROJECT_ID}`.length);

    if (!suffix && request.method() === 'GET') {
      await json(route, planningOnlyProject);
      return;
    }
    if (suffix === '/facts' && request.method() === 'GET') {
      await json(route, { facts: memoryState.fact ? [memoryState.fact] : [] });
      return;
    }
    if (suffix === '/facts' && request.method() === 'POST') {
      const body = request.postDataJSON() as { title: string; content: string };
      memoryState.fact = makeFact(body.title, body.content, 1);
      await json(route, { fact: memoryState.fact }, 201);
      return;
    }
    if (suffix === `/facts/${FACT_ID}` && request.method() === 'PATCH' && memoryState.fact) {
      const body = request.postDataJSON() as { title: string; content: string; expectedVersion: number };
      if (body.expectedVersion !== memoryState.fact.version) {
        await json(route, null, 409, { code: 'PROJECT_FACT_VERSION_CONFLICT', message: 'The synthetic fact changed.' });
        return;
      }
      memoryState.fact = makeFact(body.title, body.content, Number(memoryState.fact.version) + 1);
      await json(route, { fact: memoryState.fact });
      return;
    }
    if (suffix === `/facts/${FACT_ID}` && request.method() === 'DELETE') {
      memoryState.fact = null;
      await route.fulfill({ status: 204 });
      return;
    }
    if (suffix === '/chat-context' && request.method() === 'GET') {
      const activeIds = memoryState.fact ? context.factIds : [];
      await json(route, { ...context, factIds: activeIds });
      return;
    }
    if (suffix === '/chat-context' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Partial<typeof context>;
      context = { ...context, ...body };
      await json(route, { ...context, factIds: memoryState.fact ? context.factIds : [] });
      return;
    }
    await json(route, null, 404, { code: 'PREVIEW_PROJECT_ROUTE_NOT_FOUND', message: 'Synthetic project route not found.' });
  });

  const policyReadScopes: string[] = [];
  await page.route('**/api/v1/assistant/execution-policy**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('scope') !== 'workspace' || url.searchParams.get('projectId') !== PROJECT_ID) {
      await route.fallback();
      return;
    }
    policyReadScopes.push(`${url.searchParams.get('scope')}:${url.searchParams.get('projectId')}`);
    await json(route, {
      scope: { kind: 'workspace', label: 'Planning workspace' },
      policy: {
        enabled: true,
        revision: 'synthetic-policy-1',
        provider: { name: 'Synthetic browser fixture', model: 'preview-only' },
        included: { categories: ['current_message', 'project_facts'], items: [] },
        exclusionsEnforced: true,
        capabilities: []
      },
      fileAccess: false,
      readiness: { state: 'ready' }
    });
  });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_ID}/memory`);
  await expect(page.getByTestId('project-memory-page')).toBeVisible();
  const policy = page.getByRole('region', { name: 'Assistant policy summary' });
  await expect(policy).toContainText('Synthetic browser fixture');
  await expect(policy).toContainText('Selected project facts');
  await expect(policy).toContainText('Workspace data is stored on the operator-managed deployment.');
  await expect(page.getByText('Files and file context remain unavailable in this planning-only workspace.')).toBeVisible();

  await page.getByTestId('project-memory-add').click();
  await page.getByTestId('project-fact-title').fill('Release review window');
  await page.getByTestId('project-fact-content').fill('Hold reviews after 15:00 local time.');
  await page.getByTestId('project-fact-save').click();

  const factCard = page.getByTestId('project-memory-fact');
  await expect(factCard).toContainText('Release review window');
  const inclusion = factCard.getByLabel('Include in future AI context');
  await inclusion.check();
  await expect(page.getByTestId('project-memory-announcement')).toContainText('Memory selection applied to future permitted runs');
  expect(context.factIds).toEqual([FACT_ID]);

  await factCard.getByTestId(`project-fact-edit-${FACT_ID}`).click();
  await page.getByTestId('project-fact-content').fill('Hold reviews after 10:00 local time.');
  await page.getByTestId('project-fact-save').click();
  await expect(factCard).toContainText('Hold reviews after 10:00 local time.');
  expect(memoryState.fact?.version).toBe(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inclusion).toBeChecked();
  const mobileWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth
  }));
  expect(mobileWidth.scroll).toBeLessThanOrEqual(mobileWidth.client + 1);
  setBrowserEvidenceMetadata(page, 'planningOnlyMemoryMobile', { viewport: { width: 390, height: 844 }, ...mobileWidth });
  await page.screenshot({ path: testInfo.outputPath('planning-only-memory-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${PROJECT_ID}/planning-chat`);
  await expect(page.getByTestId('planning-chat')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Assistant policy summary' })).toContainText('Synthetic browser fixture');
  const request = 'Plan the review around the saved timing.';
  await page.getByTestId('home-chat-input').fill(request);
  await page.getByTestId('home-chat-send').click();
  await expect(page.getByTestId('home-chat-messages').getByText(request, { exact: true })).toBeVisible();
  await expect(page.getByTestId('home-chat-messages').getByText('Assistant is responding…', { exact: true })).toBeVisible();

  expect(fixture.calls.listQueries).toContainEqual({ scope: 'workspace', workspaceId: PROJECT_ID });
  expect(fixture.calls.createRequests).toHaveLength(1);
  expect(fixture.calls.createRequests[0]?.body.scope).toEqual({ kind: 'workspace', workspaceId: PROJECT_ID });
  expect(fixture.calls.submitRequests).toHaveLength(1);
  expect(fixture.calls.submitRequests[0]?.body.message).toBe(request);
  expect(context.factIds).toEqual([FACT_ID]);
  expect(memoryState.fact?.content).toBe('Hold reviews after 10:00 local time.');
  expect(policyReadScopes).toEqual([`workspace:${PROJECT_ID}`, `workspace:${PROJECT_ID}`]);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);

  setBrowserEvidenceMetadata(page, 'freshWorkspaceChat', {
    workspaceId: PROJECT_ID,
    persistedSelectionAtSend: context.factIds,
    currentFactVersion: memoryState.fact?.version,
    providerRuntime: 'synthetic preview fixture; no live provider request'
  });
  await page.screenshot({ path: testInfo.outputPath('planning-chat-with-selected-memory.png'), fullPage: true });

  await page.goto(`/projects/${PROJECT_ID}/memory`);
  const reloadedFactCard = page.getByTestId('project-memory-fact');
  await expect(reloadedFactCard.getByLabel('Include in future AI context')).toBeChecked();
  await reloadedFactCard.getByLabel('Include in future AI context').uncheck();
  await expect(page.getByTestId('project-memory-announcement')).toContainText('Memory selection applied to future permitted runs');
  expect(context.factIds).toEqual([]);

  const deletionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && url.pathname.endsWith(`/facts/${FACT_ID}`);
  });
  await reloadedFactCard.getByTestId(`project-fact-delete-${FACT_ID}`).click();
  await page.getByTestId('project-fact-delete-confirm').click();
  expect((await deletionResponse).status()).toBe(204);
  await expect(page.getByTestId('project-memory-empty')).toBeVisible();
  expect(memoryState.fact).toBeNull();
  await page.reload();
  await expect(page.getByTestId('project-memory-empty')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Assistant policy summary' })).toContainText('Synthetic browser fixture');
  expect(policyReadScopes).toContain(`workspace:${PROJECT_ID}`);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
});

const planningOnlyProject = {
  id: PROJECT_ID,
  name: 'Planning workspace',
  slug: 'planning-workspace',
  workspaceMode: 'planning' as const,
  capabilities: { planning: true as const, fileAccess: false },
  status: 'active' as const,
  version: 1,
  createdAt: SYNTHETIC_TIME,
  updatedAt: SYNTHETIC_TIME
};

function makeFact(title: string, content: string, version: number): Record<string, unknown> {
  return {
    id: FACT_ID,
    projectId: PROJECT_ID,
    title,
    content,
    source: { kind: 'user', label: 'Added by you', reference: null },
    createdAt: SYNTHETIC_TIME,
    updatedAt: SYNTHETIC_TIME,
    version,
    verifiedAt: null,
    verificationStatus: 'needs_review'
  };
}

async function json(route: import('@playwright/test').Route, data: unknown, status = 200, error: { code: string; message: string } | null = null): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
}
