import { expect, test } from '@playwright/test';

const WORKSPACE_ID = '873c096a-bc57-4a0c-85da-10d4febde961';
const SKILL_ID = '873c096a-bc57-4a0c-85da-10d4febde962';
const SCHEDULE_ID = '773c0000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '773c0000-0000-4000-8000-000000000002';
const TURN_ID = '773c0000-0000-4000-8000-000000000003';
const TASK_ID = '773c0000-0000-4000-8000-000000000004';
const PREVIEW_CSRF = 'automation-interface-preview-csrf';
const NOW = '2026-10-21T00:00:00.000Z';

interface Schedule {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly localTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly nextDueAt: string | null;
  readonly lastRunStatus: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Occurrence {
  readonly id: string;
  readonly kind: 'scheduled' | 'manual';
  readonly intendedFor: string;
  readonly status: string;
  readonly scheduleRevision: number;
  readonly skillVersion: number;
  readonly homeTurnId: string | null;
  readonly failureCode: string | null;
  readonly attemptCount: number;
  readonly taskSources: readonly { taskId: string; revision: number; available: boolean; title: string | null; href: string | null }[];
  readonly providerUsage: {
    readonly state: 'not_started' | 'settled' | 'pending' | 'unknown';
    readonly calls: readonly { status: 'pending' | 'unknown' | 'settled' | 'over_bound'; providerProfile: string; model: string; inputTokens: number | null; outputTokens: number | null; chargedUnits: string | null }[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PreviewState {
  schedules: Schedule[];
  occurrences: Occurrence[];
  createRequests: { body: unknown; key: string | undefined }[];
  updateRequests: { body: unknown; key: string | undefined }[];
  runRequests: { body: unknown; key: string | undefined }[];
  runModes: ('budget' | 'network' | 'queued' | 'succeeded')[];
  conflictNextUpdate: boolean;
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID, workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID, skillVersion: 4,
    localTime: '08:30', timeZone: 'Asia/Shanghai', enabled: true, revision: 3,
    nextDueAt: '2026-10-21T00:30:00.000Z', lastRunStatus: null, createdAt: NOW, updatedAt: NOW, ...overrides
  };
}

function occurrence(status: 'queued' | 'succeeded' = 'queued'): Occurrence {
  return {
    id: '773c0000-0000-4000-8000-000000000005', kind: 'manual', intendedFor: NOW, status,
    scheduleRevision: 3, skillVersion: 4, homeTurnId: TURN_ID, failureCode: null, attemptCount: 1,
    taskSources: [{ taskId: TASK_ID, revision: 7, available: true, title: 'Prepare release note', href: `/tasks/${TASK_ID}` }],
    providerUsage: { state: 'settled', calls: [{ status: 'settled', providerProfile: 'preview-profile', model: 'preview-model', inputTokens: 1200, outputTokens: 180, chargedUnits: '4' }] },
    createdAt: NOW, updatedAt: NOW
  };
}

interface BrowserErrors {
  readonly uncaught: string[];
  readonly resource: string[];
}

function watchBrowserErrors(page: import('@playwright/test').Page): BrowserErrors {
  const errors: BrowserErrors = { uncaught: [], resource: [] };
  page.on('pageerror', (error) => errors.uncaught.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const entry = `${message.text()} ${message.location().url}`.trim();
    if (message.text().startsWith('Failed to load resource:') || message.text().includes('net::ERR_FAILED')) errors.resource.push(entry);
    else errors.uncaught.push(entry);
  });
  return errors;
}

function expectBrowserErrors(errors: BrowserErrors, expectedResourceErrors: readonly RegExp[] = []): void {
  expect(errors.uncaught).toEqual([]);
  expect(errors.resource).toHaveLength(expectedResourceErrors.length);
  expectedResourceErrors.forEach((expected, index) => expect(errors.resource[index]).toMatch(expected));
}

async function installApi(
  page: import('@playwright/test').Page,
  options: { readonly schedules?: readonly Schedule[]; readonly occurrences?: readonly Occurrence[]; readonly runModes?: PreviewState['runModes'] } = {}
): Promise<PreviewState> {
  const state: PreviewState = {
    schedules: [...(options.schedules ?? [])], occurrences: [...(options.occurrences ?? [])],
    createRequests: [], updateRequests: [], runRequests: [], runModes: [...(options.runModes ?? [])], conflictNextUpdate: false
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/auth/session') {
      await respond(route, 200, { principal: { id: 'preview-owner', displayName: 'Preview owner', accountKind: 'regular', role: 'user' }, csrfToken: PREVIEW_CSRF, expiresAt: '2026-10-21T02:00:00.000Z' });
      return;
    }
    if (path === '/api/v1/projects' && request.method() === 'GET') {
      await respond(route, 200, { projects: [project()] });
      return;
    }
    if (path === `/api/v1/projects/${WORKSPACE_ID}` && request.method() === 'GET') {
      await respond(route, 200, project());
      return;
    }
    if (path === '/api/v1/skills' && request.method() === 'GET') {
      await respond(route, 200, { skills: [skill()] });
      return;
    }
    if (path === '/api/v1/automations/schedules' && request.method() === 'GET') {
      await respond(route, 200, { schedules: state.schedules });
      return;
    }
    if (path === '/api/v1/automations/schedules' && request.method() === 'POST') {
      const body = request.postDataJSON() as { workspaceId: string; skillId: string; skillVersion: number; localTime: string; timeZone: string };
      state.createRequests.push({ body, key: request.headers()['idempotency-key'] });
      const created = schedule({ ...body, id: SCHEDULE_ID, conversationId: CONVERSATION_ID, enabled: true, revision: 1, nextDueAt: '2026-10-21T00:30:00.000Z', lastRunStatus: null });
      state.schedules = [created];
      await respond(route, 201, { schedule: created });
      return;
    }
    const schedulePath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)$/u);
    if (schedulePath && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { expectedRevision: number; enabled?: boolean; localTime?: string; timeZone?: string; skillId?: string; skillVersion?: number };
      state.updateRequests.push({ body, key: request.headers()['idempotency-key'] });
      if (state.conflictNextUpdate) {
        state.conflictNextUpdate = false;
        state.schedules = state.schedules.map((item) => item.id === SCHEDULE_ID ? { ...item, localTime: '09:00', revision: item.revision + 1, nextDueAt: '2026-10-21T01:00:00.000Z', updatedAt: NOW } : item);
        await respond(route, 409, null, { code: 'SCHEDULE_REVISION_CONFLICT', message: 'This schedule changed.' });
        return;
      }
      const updated = state.schedules.map((item) => item.id === SCHEDULE_ID ? {
        ...item, ...body, revision: item.revision + 1,
        nextDueAt: body.enabled === false ? null : body.enabled === true ? '2026-10-21T00:30:00.000Z' : item.nextDueAt,
        updatedAt: NOW
      } : item);
      state.schedules = updated;
      await respond(route, 200, { schedule: updated[0] });
      return;
    }
    const runPath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)\/runs$/u);
    if (runPath && request.method() === 'POST') {
      state.runRequests.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
      const mode = state.runModes.shift() ?? 'queued';
      if (mode === 'budget') {
        await respond(route, 422, null, { code: 'BUDGET_EXHAUSTED', message: 'The AI budget is exhausted.' });
        return;
      }
      if (mode === 'network') {
        await route.abort();
        return;
      }
      const result = occurrence(mode === 'succeeded' ? 'succeeded' : 'queued');
      state.occurrences = [result, ...state.occurrences.filter((item) => item.id !== result.id)];
      await respond(route, 202, { occurrence: result });
      return;
    }
    const historyPath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)\/occurrences$/u);
    if (historyPath && request.method() === 'GET') {
      await respond(route, 200, { occurrences: state.occurrences, nextCursor: null });
      return;
    }
    if (path === '/api/v1/assistant/execution-policy') {
      await respond(route, 200, { scope: { kind: url.searchParams.get('scope') ?? 'home', label: 'Preview workspace' }, policy: { enabled: true, revision: 'preview-policy', provider: { name: 'Preview provider', model: 'preview-model' }, included: { categories: [], items: [] }, exclusionsEnforced: true, capabilities: [] }, fileAccess: false, readiness: { state: 'ready' } });
      return;
    }
    if (path === '/api/v1/account/usage' && request.method() === 'GET') {
      await respond(route, 200, {
        asOf: NOW, expiresAt: null,
        daily: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null, resetAt: NOW, timeZone: 'Asia/Shanghai' },
        lifetime: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
        storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '0', reservedBytes: '0', limitBytes: null, availableBytes: null, overLimit: false, asOf: NOW },
        availability: { status: 'available', reason: null, canSubmit: true }
      });
      return;
    }
    if (path === '/api/v1/home/conversations' && request.method() === 'GET') {
      await respond(route, 200, { conversations: [homeConversation()], nextCursor: null });
      return;
    }
    if (path === `/api/v1/home/conversations/${CONVERSATION_ID}`) {
      await respond(route, 200, homeConversation());
      return;
    }
    if (path === `/api/v1/home/conversations/${CONVERSATION_ID}/messages`) {
      await respond(route, 200, { messages: [{ id: '773c0000-0000-4000-8000-000000000006', turnId: TURN_ID, sequence: 1, role: 'assistant', content: 'Your morning briefing is ready.', createdAt: NOW }], nextBeforeSequence: null });
      return;
    }
    if (path === `/api/v1/home/conversations/${CONVERSATION_ID}/turns`) {
      await respond(route, 200, { turns: [{ id: TURN_ID, conversationId: CONVERSATION_ID, sequence: 1, status: 'completed', createdAt: NOW, updatedAt: NOW }], nextAfterSequence: null });
      return;
    }
    if (path === `/api/v1/home/conversations/${CONVERSATION_ID}/events`) {
      await respond(route, 200, { events: [], nextAfterSequence: null, lastEventSequence: 0 });
      return;
    }
    if (path === `/api/v1/home/conversations/${CONVERSATION_ID}/proposals`) {
      await respond(route, 200, { proposals: [], nextCursor: null });
      return;
    }
    await respond(route, 404, null, { code: 'NOT_FOUND', message: 'No preview API route is configured.' });
  });
  return state;
}

test('creates an enabled local-time schedule with focused IANA-zone validation', async ({ page }, testInfo) => {
  const consoleErrors = watchBrowserErrors(page);
  const state = await installApi(page);
  await page.goto('/automations');
  await expect(page.getByTestId('automations-page')).toBeVisible();
  await page.getByRole('button', { name: 'Create daily briefing' }).first().click();
  await page.getByLabel('Workspace').selectOption(WORKSPACE_ID);
  await page.getByLabel('Enabled read-only skill').selectOption(`${SKILL_ID}:4`);
  await page.getByLabel('Time', { exact: true }).fill('08:30');
  await page.getByLabel('Time zone').fill('Mars/Base');
  await page.getByRole('button', { name: 'Save' }).click();
  const zone = page.getByLabel('Time zone');
  await expect(zone).toHaveAttribute('aria-invalid', 'true');
  await expect(zone).toBeFocused();
  await expect(page.getByTestId('automation-schedule-form')).toContainText('Enter a valid IANA time zone, such as Asia/Shanghai.');

  await zone.fill('Asia/Shanghai');
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId(`automation-schedule-${SCHEDULE_ID}`);
  await expect(row).toContainText('Enabled');
  await expect(row).toContainText('08:30 (Asia/Shanghai)');
  await expect(row).toContainText('Next run:');
  expect(state.createRequests).toHaveLength(1);
  expect(state.createRequests[0]).toEqual({
    body: { workspaceId: WORKSPACE_ID, skillId: SKILL_ID, skillVersion: 4, localTime: '08:30', timeZone: 'Asia/Shanghai' },
    key: expect.stringMatching(/^[A-Za-z0-9._~-]{8,128}$/u)
  });
  await row.screenshot({ path: testInfo.outputPath('automation-desktop-created.png') });
  expectBrowserErrors(consoleErrors);
});

test('pauses and resumes with the latest server revision while retaining history', async ({ page }) => {
  const consoleErrors = watchBrowserErrors(page);
  const state = await installApi(page, { schedules: [schedule({ lastRunStatus: 'succeeded' })], occurrences: [occurrence('succeeded')] });
  await page.goto('/automations');
  const row = page.getByTestId(`automation-schedule-${SCHEDULE_ID}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Run history' }).click();
  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row).toContainText('Paused');
  await expect(row).toContainText('No next run');
  await expect(row).toContainText('Succeeded');
  await row.getByRole('button', { name: 'Resume' }).click();
  await expect(row).toContainText('Enabled');
  expect(state.updateRequests.map((item) => item.body)).toEqual([
    { expectedRevision: 3, enabled: false }, { expectedRevision: 4, enabled: true }
  ]);
  expect(state.schedules[0]?.revision).toBe(5);
  expectBrowserErrors(consoleErrors);
});

test('preserves edit values after a revision conflict and reloads only on explicit action', async ({ page }) => {
  const consoleErrors = watchBrowserErrors(page);
  const state = await installApi(page, { schedules: [schedule()] });
  await page.goto('/automations');
  const row = page.getByTestId(`automation-schedule-${SCHEDULE_ID}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Time', { exact: true }).fill('09:45');
  state.conflictNextUpdate = true;
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('Your edits are preserved');
  await expect(page.getByLabel('Time', { exact: true })).toHaveValue('09:45');
  await page.getByRole('button', { name: 'Reload latest schedule' }).click();
  await expect(page.getByLabel('Time', { exact: true })).toHaveValue('09:00');
  expect(state.updateRequests[0]?.body).toEqual({ expectedRevision: 3, localTime: '09:45' });
  expectBrowserErrors(consoleErrors, [/status of 409 \(Conflict\).*automations\/schedules/u]);
});

test('runs a paused schedule without consent and opens the saved Home result with persisted sources and usage', async ({ page }) => {
  const consoleErrors = watchBrowserErrors(page);
  const state = await installApi(page, { schedules: [schedule({ enabled: false, nextDueAt: null })], runModes: ['succeeded'] });
  await page.goto('/automations');
  const row = page.getByTestId(`automation-schedule-${SCHEDULE_ID}`);
  await expect(row.getByRole('button', { name: 'Run now' }).first()).toBeEnabled();
  await row.getByRole('button', { name: 'Run now' }).first().click();
  await expect(page.getByTestId('automation-ready-notice')).toContainText('Your daily briefing is ready.');
  const history = page.getByTestId(`automation-history-${SCHEDULE_ID}`);
  await expect(history).toBeVisible();
  const run = history.getByTestId(`automation-occurrence-${occurrence('succeeded').id}`);
  await expect(run).toContainText('Succeeded');
  await expect(run).toContainText('preview-profile');
  await expect(run).toContainText('preview-model');
  await expect(run).toContainText('1200 input / 180 output tokens');
  await expect(run).toContainText('charged units: 4');
  await expect(run.getByRole('link', { name: 'Prepare release note · revision 7' })).toHaveAttribute('href', `/tasks/${TASK_ID}`);
  expect(state.runRequests).toHaveLength(1);
  expect(state.runRequests[0]?.body).toEqual({});
  expect(state.runRequests[0]?.key).toMatch(/^[A-Za-z0-9._~-]{8,128}$/u);
  expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByTestId('automation-ready-notice').getByRole('link', { name: 'Open briefing' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${WORKSPACE_ID}/planning-chat\\?conversation=${CONVERSATION_ID}$`, 'u'));
  await expect(page.getByText('Your morning briefing is ready.')).toBeVisible();
  expectBrowserErrors(consoleErrors);
});

test('shows budget exhaustion and retries an uncertain Run now with the same key and body', async ({ page }) => {
  const consoleErrors = watchBrowserErrors(page);
  const state = await installApi(page, { schedules: [schedule()], runModes: ['budget', 'network', 'queued'] });
  await page.goto('/automations');
  const row = page.getByTestId(`automation-schedule-${SCHEDULE_ID}`);
  await row.getByRole('button', { name: 'Run now' }).first().click();
  await expect(row).toContainText('AI budget is exhausted');
  await row.getByRole('button', { name: 'Run now' }).first().click();
  await expect(row.getByRole('button', { name: 'Retry same Run now' })).toBeEnabled();
  await row.getByRole('button', { name: 'Retry same Run now' }).click();
  await expect(row.getByTestId(`automation-occurrence-${occurrence().id}`)).toContainText('Queued');
  expect(state.runRequests).toHaveLength(3);
  expect(state.runRequests.map((request) => request.body)).toEqual([{}, {}, {}]);
  expect(state.runRequests[1]?.key).toBe(state.runRequests[2]?.key);
  expect(state.runRequests[0]?.key).not.toBe(state.runRequests[1]?.key);
  expectBrowserErrors(consoleErrors, [
    /status of 422 \(Unprocessable Entity\).*automations\/schedules/u,
    /net::ERR_FAILED.*automations\/schedules/u
  ]);
});

test('keeps the mobile workspace navigation and form keyboard accessible without horizontal overflow', async ({ page }, testInfo) => {
  const consoleErrors = watchBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto('/automations');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menu).toBeFocused();

  const create = page.getByRole('button', { name: 'Create daily briefing' }).first();
  await create.focus();
  await page.keyboard.press('Enter');
  const workspace = page.getByLabel('Workspace');
  await expect(workspace).toBeVisible();
  await workspace.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Enabled read-only skill')).toHaveValue(`${SKILL_ID}:4`);
  await page.getByLabel('Time zone').fill('Bad/Zone');
  await page.getByRole('button', { name: 'Save' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Time zone')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('automation-mobile-keyboard-validation.png'), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath('task-5-4-automations-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-5-4-automations-320px.png'), fullPage: true });

  await page.setViewportSize({ width: 640, height: 360 });
  await expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const save = page.getByRole('button', { name: 'Save' });
  await save.focus();
  const saveBounds = await save.boundingBox();
  expect(saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 360).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-5-4-automations-640css-reflow.png'), fullPage: true });
  expectBrowserErrors(consoleErrors);
});

function project() {
  return {
    id: WORKSPACE_ID, name: 'Preview workspace', slug: 'preview-workspace', objective: null,
    workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW
  };
}

function skill() {
  return { id: SKILL_ID, workspaceId: null, title: 'Morning briefing', instructions: 'Read-only preview skill.', declaredTools: ['home_task_read', 'home_workspace_read'], enabled: true, version: 4, createdAt: NOW, updatedAt: NOW };
}

function homeConversation() {
  return { id: CONVERSATION_ID, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID }, title: 'Daily briefing', lastEventSequence: 0, lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW };
}

async function respond(
  route: import('@playwright/test').Route,
  status: number,
  data: unknown,
  error: { readonly code: string; readonly message: string } | null = null
): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
}
