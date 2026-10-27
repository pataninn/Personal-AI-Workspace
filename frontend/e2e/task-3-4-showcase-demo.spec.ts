import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SESSION_COOKIE = 'pai_demo_session';

test('keeps the public showcase read-only and two private demos isolated', async ({ browser, page }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('A loopback preview URL is required for this fixture test.');

  const first = createFixture('first');
  const second = createFixture('second');
  const secondContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true
  });
  const secondPage = await secondContext.newPage();
  await installFixture(page.context(), first);
  await installFixture(secondContext, second);

  try {
    await page.goto('/showcase');
    await expectPublicReadOnly(page);
    const publicScreenshot = testInfo.outputPath('task-3-4-public-showcase-desktop.png');
    await mkdir(dirname(publicScreenshot), { recursive: true });
    await page.screenshot({ path: publicScreenshot, fullPage: true });

    await enterDemo(page, first);
    await expect(page.getByTestId('private-demo-banner')).toContainText('Planning only');
    const privateScreenshot = testInfo.outputPath('task-3-4-private-demo-desktop.png');
    await mkdir(dirname(privateScreenshot), { recursive: true });
    await page.screenshot({ path: privateScreenshot, fullPage: true });

    const editedTitle = 'Edited in the first private demo only';
    await editPrivateTask(page, first, `/projects/${first.project.id}/tasks`);
    await expect(page.getByTestId(`project-task-row-${first.task.id}`)).toContainText(editedTitle);

    // Returning to the public route while an HttpOnly demo cookie exists must still be cookie-less.
    await page.goto('/showcase');
    await expectPublicReadOnly(page);

    await secondPage.goto(new URL('/showcase', baseURL).toString());
    await expectPublicReadOnly(secondPage);
    await enterDemo(secondPage, second);
    await expect(secondPage.getByTestId('private-demo-banner')).toContainText('Planning only');
    await secondPage.goto(new URL(`/projects/${second.project.id}/tasks`, baseURL).toString());
    const secondTaskRow = secondPage.getByTestId(`project-task-row-${second.task.id}`);
    await expect(secondTaskRow).toContainText('Private demo task');
    await expect(secondTaskRow).not.toContainText(editedTitle);
    await editPrivateTask(secondPage, second, new URL(`/projects/${second.project.id}/tasks`, baseURL).toString());
    await expect(secondPage.getByTestId(`project-task-row-${second.task.id}`)).toContainText('Edited in the second private demo only');

    const mobileScreenshot = testInfo.outputPath('task-3-4-private-demo-mobile.png');
    await mkdir(dirname(mobileScreenshot), { recursive: true });
    await secondPage.screenshot({ path: mobileScreenshot, fullPage: true });
    await secondPage.goto(new URL('/showcase', baseURL).toString());
    await expectPublicReadOnly(secondPage);

    for (const fixture of [first, second]) {
      expect(fixture.admissionKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(fixture.publicRequests.length).toBeGreaterThanOrEqual(2);
      expect(fixture.publicRequests.every((request) => request.cookie === undefined)).toBe(true);
      expect(fixture.privateCookies.length).toBeGreaterThan(0);
      expect(fixture.privateCookies.every((cookie) => cookie === `${SESSION_COOKIE}=${fixture.cookieValue}`)).toBe(true);
    }
    expect(first.copyStatusReads).toBeGreaterThanOrEqual(2);
    expect(second.copyStatusReads).toBeGreaterThanOrEqual(1);
    expect(first.task.title).toBe(editedTitle);
    expect(second.task.title).toBe('Edited in the second private demo only');
    expect(first.cookieValue).not.toBe(second.cookieValue);
  } finally {
    await secondContext.close();
  }
});

interface DemoFixture {
  readonly label: string;
  readonly cookieValue: string;
  readonly principalId: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly objective: string;
    readonly workspaceMode: 'planning';
    readonly capabilities: { readonly planning: true; readonly fileAccess: false };
    readonly status: 'active';
    readonly version: 1;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  task: {
    readonly id: string;
    readonly projectId: string;
    title: string;
    details: string;
    readonly importance: 'medium';
    readonly deadline: null;
    readonly subtasks: readonly [];
    readonly status: 'todo';
    readonly position: 0;
    version: number;
    readonly source: { readonly kind: 'user'; readonly label: string; readonly suggestionId: null; readonly runId: null; readonly conversationId: null; readonly acceptedAt: null };
    readonly createdAt: string;
    updatedAt: string;
    readonly completedAt: null;
    readonly archivedAt: null;
  };
  admissionKey: string;
  copyStatusReads: number;
  readonly publicRequests: { readonly path: string; readonly cookie: string | undefined }[];
  readonly privateCookies: string[];
}

function createFixture(label: string): DemoFixture {
  const suffix = label === 'first' ? '111' : '222';
  const projectId = `${suffix}11111-1111-4111-8111-111111111111`;
  const taskId = `${suffix}22222-2222-4222-8222-222222222222`;
  return {
    label,
    cookieValue: `private-${label}-cookie`,
    principalId: `${suffix}33333-3333-4333-8333-333333333333`,
    project: {
      id: projectId,
      name: `Private ${label} workspace`,
      slug: `private-${label}-workspace`,
      objective: `Fixture workspace for the ${label} browser context.`,
      workspaceMode: 'planning',
      capabilities: { planning: true, fileAccess: false },
      status: 'active',
      version: 1,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z'
    },
    task: {
      id: taskId,
      projectId,
      title: 'Private demo task',
      details: 'Manual task edits remain available in this fixture.',
      importance: 'medium',
      deadline: null,
      subtasks: [],
      status: 'todo',
      position: 0,
      version: 1,
      source: { kind: 'user', label: 'Created in this private demo', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      completedAt: null,
      archivedAt: null
    },
    admissionKey: '',
    copyStatusReads: 0,
    publicRequests: [],
    privateCookies: []
  };
}

async function installFixture(context: BrowserContext, fixture: DemoFixture): Promise<void> {
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const cookie = request.headers().cookie;
    const projectPath = `/api/v1/projects/${fixture.project.id}`;
    const projectTaskPath = `${projectPath}/tasks`;

    if (path === '/api/v1/auth/session' && method === 'GET') {
      if (cookie === `${SESSION_COOKIE}=${fixture.cookieValue}`) {
        fixture.privateCookies.push(cookie);
        await route.fulfill(apiResponse(sessionData(fixture)));
      } else {
        await route.fulfill(apiResponse(null, { code: 'SESSION_UNAUTHENTICATED', message: 'Sign in.' }, 401));
      }
      return;
    }
    if (path === '/api/v1/showcases/current' && method === 'GET') {
      fixture.publicRequests.push({ path, cookie });
      await route.fulfill(apiResponse({
        version: '11111111-1111-4111-8111-111111111111',
        publishedAt: '2026-10-19T00:00:00.000Z',
        project: { name: 'Development fixture — sample content only; not operator-provided or published.', objective: 'Fixture data used only by this browser test.' },
        tasks: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Read-only example task', details: 'This published fixture is not editable.', status: 'todo', importance: 'low', deadline: null, checklist: [] }],
        facts: [],
        files: []
      }));
      return;
    }
    if (path === '/api/v1/demo/availability' && method === 'GET') {
      fixture.publicRequests.push({ path, cookie });
      await route.fulfill(apiResponse({ available: true }));
      return;
    }
    if (path === '/api/v1/demo/session' && method === 'POST') {
      fixture.admissionKey = request.headers()['idempotency-key'] ?? '';
      expect(request.postDataJSON()).toEqual({});
      await route.fulfill({
        ...apiResponse(sessionData(fixture), null, 201),
        headers: { 'Set-Cookie': `${SESSION_COOKIE}=${fixture.cookieValue}; Path=/; HttpOnly; SameSite=Strict` }
      });
      return;
    }
    if (path === '/api/v1/demo/showcase-copy' && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      fixture.copyStatusReads += 1;
      const pending = fixture.label === 'first' && fixture.copyStatusReads === 1;
      await route.fulfill(apiResponse({
        state: pending ? 'pending' : 'ready',
        projectId: pending ? null : fixture.project.id,
        retryAllowed: false,
        workspaceMode: pending ? null : 'planning',
        capabilities: pending ? null : { planning: true, fileAccess: false }
      }));
      return;
    }
    if (path === '/api/v1/projects/overview' && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      await route.fulfill(apiResponse({ projects: [{ ...fixture.project, lastActivityAt: fixture.project.updatedAt }], tasks: [] }));
      return;
    }
    if (path === '/api/v1/projects' && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      await route.fulfill(apiResponse({ projects: [fixture.project] }));
      return;
    }
    if (path === projectPath && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      await route.fulfill(apiResponse(fixture.project));
      return;
    }
    if (path === projectTaskPath && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      await route.fulfill(apiResponse({ tasks: [fixture.task], orderVersion: 1 }));
      return;
    }
    if (path.startsWith(`${projectTaskPath}/`) && method === 'PATCH') {
      fixture.privateCookies.push(cookie ?? '');
      const update = request.postDataJSON() as Partial<DemoFixture['task']>;
      fixture.task = { ...fixture.task, ...update, version: fixture.task.version + 1, updatedAt: '2026-10-19T00:01:00.000Z' };
      await route.fulfill(apiResponse({ task: fixture.task, orderVersion: 1 }));
      return;
    }
    if (path === `${projectPath}/task-suggestions` && method === 'GET') {
      fixture.privateCookies.push(cookie ?? '');
      await route.fulfill(apiResponse({ taskSuggestions: [] }));
      return;
    }
    if (path === '/api/v1/home/conversations' && method === 'GET') {
      await route.fulfill(apiResponse({ conversations: [], nextCursor: null }));
      return;
    }
    await route.fulfill(apiResponse({}, { code: 'NOT_FOUND', message: 'Not found.' }, 404));
  });
}

async function expectPublicReadOnly(page: Page): Promise<void> {
  await expect(page.getByTestId('showcase-content')).toBeVisible();
  await expect(page.getByText('Read-only example task')).toBeVisible();
  await expect(page.getByText(/Development fixture — sample content only/)).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
}

async function enterDemo(page: Page, fixture: DemoFixture): Promise<void> {
  await page.getByRole('link', { name: 'Try demo', exact: true }).click();
  const tryDemo = page.getByTestId('try-demo-button');
  await expect(tryDemo).toBeEnabled();
  await tryDemo.click();
  if (fixture.label === 'first') {
    await expect(page.getByTestId('demo-copy-unavailable')).toBeVisible();
  }
  await expect(page).toHaveURL(new RegExp(`/projects/${fixture.project.id}$`, 'u'));
  await expect(page.getByTestId('private-demo-banner')).toBeVisible();
  await expect(page.getByTestId('demo-copy-preparing')).toHaveCount(0);
  await expect(page.getByTestId('demo-copy-opening')).toHaveCount(0);
}

async function editPrivateTask(page: Page, fixture: DemoFixture, url: string): Promise<void> {
  await page.goto(url);
  const row = page.getByTestId(`project-task-row-${fixture.task.id}`);
  await expect(row).toBeVisible();
  await row.locator('summary').click();
  await row.getByTestId(`project-task-actions-${fixture.task.id}`).click();
  await page.getByTestId(`project-task-edit-${fixture.task.id}`).click();
  const newTitle = fixture.label === 'first' ? 'Edited in the first private demo only' : 'Edited in the second private demo only';
  await page.getByTestId('project-task-title-input').fill(newTitle);
  const updated = page.waitForResponse((response) => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `/api/v1/projects/${fixture.project.id}/tasks/${fixture.task.id}`);
  await page.getByTestId('project-task-editor-save').click();
  expect((await updated).status()).toBe(200);
  await expect(row).toContainText(newTitle);
}

function sessionData(fixture: DemoFixture) {
  return {
    state: 'ready',
    principal: { id: fixture.principalId, displayName: `Demo ${fixture.label}`, accountKind: 'demo', role: 'user' },
    csrfToken: `csrf-${fixture.label}`,
    expiresAt: '2026-10-20T00:00:00.000Z'
  };
}

function apiResponse(data: unknown, error: { readonly code: string; readonly message: string } | null = null, status = 200): {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
} {
  return { status, contentType: 'application/json', body: JSON.stringify({ data, error }) };
}
