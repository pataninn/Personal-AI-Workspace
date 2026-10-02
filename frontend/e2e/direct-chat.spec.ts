import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

class DirectChatPage {
  public constructor(private readonly page: Page) {}
  public async open(projectId: string, conversationId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/conversations/${conversationId}`);
    await expect(this.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  }
  public async send(content: string): Promise<void> {
    await this.page.getByRole('textbox', { name: 'Message', exact: true }).fill(content);
    await this.page.getByRole('button', { name: 'Send', exact: true }).click();
  }
}

test('uses saved files, ticked memory, and previous project conversations when sending directly', async ({ page }) => {
  test.setTimeout(180_000);
  const marker = randomUUID().slice(0, 8);
  const relativeRoot = `apps/direct-chat-check-${marker}`;
  const repositoryRoot = resolve(process.cwd(), '..');
  const workspaceRoot = resolve(process.env.PAI_E2E_WORKSPACE_ROOT ?? repositoryRoot);
  const fixtureDirectory = resolve(workspaceRoot, relativeRoot);
  const fixtureFile = join(fixtureDirectory, 'context-example.txt');
  const artifactDirectory = resolve(repositoryRoot, '..', '.codex', 'docs', 'personal-ai-workspace-mvp', 'project-docs', 'artifacts');
  const historyCode = `HISTORY_CEDAR_${marker}`;
  const factCode = `MEMORY_ORCHID_${marker}`;
  const fileCode = `FILE_MAPLE_${marker}`;
  let projectId: string | null = null;
  let csrfToken = '';
  let sentRunId: string | null = null;
  let sendKey = '';
  const requestText = 'What are the three context codes from our previous conversation, selected memory fact, and selected file? Reply with those three codes only.';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    const privateRoot = join(process.env.LOCALAPPDATA ?? '', 'Personal-AI-Workspace', 'private');
    const password = readFileSync(join(privateRoot, 'secrets', 'local_user_password'), 'utf8').trim();
    await page.goto('/login');
    await page.getByTestId('login-password-input').fill(password);
    await page.getByTestId('login-submit-button').click();
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
    const sessionResponse = await page.request.get('/api/v1/auth/session');
    csrfToken = (await sessionResponse.json()).data.csrfToken;
    const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID() };
    const projectResponse = await page.request.post('/api/v1/projects', { headers, data: { name: `Direct chat check ${marker}`, relativeRoot } });
    expect(projectResponse.status()).toBe(201);
    projectId = (await projectResponse.json()).data.id;
    if (!projectId || !fixtureDirectory.startsWith(workspaceRoot + sep)) throw new Error('Invalid test project directory');
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(fixtureFile, `The selected file context code is ${fileCode}.\n`, 'utf8');
    const createConversation = async (title: string): Promise<string> => {
      const response = await page.request.post(`/api/v1/projects/${projectId}/conversations`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { title } });
      expect(response.status()).toBe(201);
      return (await response.json()).data.id;
    };
    const previousConversationId = await createConversation('Earlier discussion');
    const conversationId = await createConversation('Follow-up chat');
    const seed = await page.request.post(`/api/v1/conversations/${previousConversationId}/messages?projectId=${projectId}`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { content: `Remember that our earlier conversation context code is ${historyCode}.` }
    });
    expect(seed.status()).toBe(201);
    const factTitle = `Context code ${marker}`;
    const factResponse = await page.request.post(`/api/v1/projects/${projectId}/facts`, { headers, data: { title: factTitle, content: `The memory context code is ${factCode}.` } });
    expect(factResponse.status()).toBe(201);
    const factData = (await factResponse.json()).data;
    const factId = (factData.fact ?? factData).id;

    await page.goto(`/projects/${projectId}/memory`);
    const memoryCheckbox = page.getByRole('checkbox', { name: `Use ${factTitle} in all chats`, exact: true });
    await expect(memoryCheckbox).toBeEnabled();
    await memoryCheckbox.check();
    await expect(memoryCheckbox).toBeChecked();
    await expect(page.getByText('Memory selection applied to every chat in this project.')).toBeVisible();
    await page.reload();
    await expect(memoryCheckbox).toBeChecked();

    await page.getByRole('link', { name: 'Context', exact: true }).click();
    const fileCheckbox = page.getByRole('checkbox', { name: 'context-example.txt', exact: true });
    await expect(fileCheckbox).toBeEnabled();
    await fileCheckbox.check();
    await expect(page.getByRole('checkbox', { name: /Include recent messages/ })).toBeChecked();
    await page.getByRole('button', { name: 'Apply to all chats' }).click();
    await expect(page.getByText('Context applied to all chats in this project.')).toBeVisible();
    await page.reload();
    await expect(fileCheckbox).toBeChecked();
    const stored = (await (await page.request.get(`/api/v1/projects/${projectId}/chat-context`)).json()).data;
    expect(stored).toEqual({ relativePaths: ['context-example.txt'], factIds: [factId], includeProjectConversations: true });
    mkdirSync(artifactDirectory, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(artifactDirectory, 'project-context.png'), fullPage: true });

    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/projects/${projectId}/chat-runs`) sendKey = request.headers()['idempotency-key'] ?? '';
    });
    const chat = new DirectChatPage(page);
    await chat.open(projectId, conversationId);
    await expect(page.getByRole('button', { name: 'Save message' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose context' })).toHaveCount(0);
    await expect(page.getByTestId('provider-permission-manager')).toHaveCount(0);
    const sendResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/chat-runs`);
    await chat.send(requestText);
    const sent = await sendResponse;
    expect(sent.status()).toBe(202);
    const intent = (await sent.json()).data;
    sentRunId = intent.run.runId;
    expect(intent.run.decision).toBe('approved');
    expect(intent.manifest.content.messageCount).toBe(1);
    expect(intent.manifest.content.factCount).toBe(1);
    expect(intent.manifest.content.relativePaths).toEqual(['context-example.txt']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await expect.poll(async () => (await (await page.request.get(`/api/v1/ai-runs/${sentRunId}`)).json()).data.status, { timeout: 100_000 }).toBe('succeeded');
    await expect(page.getByTestId('message-content').filter({ hasText: historyCode })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('message-content').filter({ hasText: factCode })).toBeVisible();
    await expect(page.getByTestId('message-content').filter({ hasText: fileCode })).toBeVisible();
    await expect(page.getByTestId('assistant-stream')).toHaveCount(0);
    const replay = await page.request.post(`/api/v1/projects/${projectId}/chat-runs`, { headers: { ...headers, 'Idempotency-Key': sendKey }, data: { conversationId, request: requestText } });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).data.run.runId).toBe(sentRunId);
    const history = (await (await page.request.get(`/api/v1/conversations/${conversationId}?projectId=${projectId}`)).json()).data;
    expect(history.messages).toHaveLength(2);
    await page.reload();
    await expect(page.getByTestId('message-content').filter({ hasText: fileCode })).toBeVisible();
    await expect(page.getByTestId('ai-run-timeline')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(artifactDirectory, 'direct-chat-workspace.png'), fullPage: true });
  } finally {
    if (projectId && csrfToken) {
      const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID() };
      if (sentRunId) {
        const runResponse = await page.request.get(`/api/v1/ai-runs/${sentRunId}`);
        const run = (await runResponse.json()).data;
        if (['ready', 'queued', 'running', 'waiting_approval'].includes(run.status)) await page.request.post(`/api/v1/ai-runs/${sentRunId}/cancel`, { headers, data: {} });
      }
      const projectResponse = await page.request.get(`/api/v1/projects/${projectId}`);
      const project = (await projectResponse.json()).data;
      if (project.status === 'active') {
        const archived = await page.request.patch(`/api/v1/projects/${projectId}`, { headers: { ...headers, 'If-Match': String(project.version) }, data: { status: 'archived' } });
        expect(archived.status()).toBe(200);
      }
    }
    if (existsSync(fixtureFile)) unlinkSync(fixtureFile);
    try { rmdirSync(fixtureDirectory); } catch { /* Leave any unexpected files untouched. */ }
  }
});

test('automatically creates, edits, and deletes workspace files without asking for approval', async ({ page }) => {
  test.setTimeout(180_000);
  const marker = randomUUID().slice(0, 8);
  const repositoryRoot = resolve(process.cwd(), '..');
  const workspaceRoot = resolve(process.env.PAI_E2E_WORKSPACE_ROOT ?? repositoryRoot);
  const relativeRoot = `apps/automatic-files-check-${marker}`;
  const fixtureDirectory = resolve(workspaceRoot, relativeRoot);
  const fixtureNames = ['edit.txt', 'remove.txt', 'unused.bin', 'New.svelte'];
  let projectId: string | null = null;
  let runId: string | null = null;
  let csrfToken = '';
  const pageErrors: string[] = [];
  const decisions: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/proposed-change-set/decision')) decisions.push(request.url());
  });
  try {
    const privateRoot = join(process.env.LOCALAPPDATA ?? '', 'Personal-AI-Workspace', 'private');
    const password = readFileSync(join(privateRoot, 'secrets', 'local_user_password'), 'utf8').trim();
    await page.goto('/login');
    await page.getByTestId('login-password-input').fill(password);
    await page.getByTestId('login-submit-button').click();
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
    csrfToken = (await (await page.request.get('/api/v1/auth/session')).json()).data.csrfToken;
    const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID() };
    const created = await page.request.post('/api/v1/projects', { headers, data: { name: `Automatic files check ${marker}`, relativeRoot } });
    expect(created.status()).toBe(201);
    projectId = (await created.json()).data.id;
    if (!projectId || !fixtureDirectory.startsWith(workspaceRoot + sep)) throw new Error('Invalid test project directory');
    writeFileSync(join(fixtureDirectory, 'edit.txt'), 'Original text\n', 'utf8');
    writeFileSync(join(fixtureDirectory, 'remove.txt'), 'This file should be removed\n', 'utf8');
    writeFileSync(join(fixtureDirectory, 'unused.bin'), Buffer.from([0, 255, 128, 42]));
    const context = await page.request.patch(`/api/v1/projects/${projectId}/chat-context`, { headers, data: { relativePaths: ['edit.txt', 'remove.txt'] } });
    expect(context.status()).toBe(200);
    const conversation = await page.request.post(`/api/v1/projects/${projectId}/conversations`, { headers, data: { title: 'Automatic file work' } });
    expect(conversation.status()).toBe(201);
    const conversationId: string = (await conversation.json()).data.id;
    const chat = new DirectChatPage(page);
    await chat.open(projectId, conversationId);
    const response = page.waitForResponse((value) => value.request().method() === 'POST' && new URL(value.url()).pathname === `/api/v1/projects/${projectId}/chat-runs`);
    await chat.send(`Create New.svelte with exactly <h1>AUTOMATIC_${marker}</h1> and a newline. Edit edit.txt to contain exactly UPDATED_${marker} and a newline. Delete remove.txt and unused.bin. Carry out all four file changes now using the application's changes format.`);
    const sent = await response;
    expect(sent.status()).toBe(202);
    runId = (await sent.json()).data.run.runId;
    await expect.poll(async () => (await (await page.request.get(`/api/v1/ai-runs/${runId}`)).json()).data.status, { timeout: 110_000 }).toMatch(/^(succeeded|failed|blocked|review_required|cancelled)$/u);
    const completedRun = (await (await page.request.get(`/api/v1/ai-runs/${runId}`)).json()).data;
    expect(completedRun.status, completedRun.safeMessage).toBe('succeeded');
    await expect(page.getByTestId('message-content').filter({ hasText: 'Applied 4 file changes in the project workspace.' })).toBeVisible();
    expect(readFileSync(join(fixtureDirectory, 'New.svelte'), 'utf8').trim()).toBe(`<h1>AUTOMATIC_${marker}</h1>`);
    expect(readFileSync(join(fixtureDirectory, 'edit.txt'), 'utf8').trim()).toBe(`UPDATED_${marker}`);
    expect(existsSync(join(fixtureDirectory, 'remove.txt'))).toBe(false);
    expect(existsSync(join(fixtureDirectory, 'unused.bin'))).toBe(false);
    const changeResponse = await page.request.get(`/api/v1/ai-runs/${runId}/proposed-change-set`);
    expect(changeResponse.status()).toBe(200);
    const changeSet = (await changeResponse.json()).data;
    expect(changeSet).toMatchObject({ status: 'applied', decision: 'approved', counts: { creates: 1, edits: 1, deletes: 2 }, result: { appliedCount: 4, backupCount: 2 } });
    const savedContext = (await (await page.request.get(`/api/v1/projects/${projectId}/chat-context`)).json()).data;
    expect(savedContext.relativePaths).toEqual(['edit.txt']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(decisions).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(repositoryRoot, '..', '.codex', 'docs', 'personal-ai-workspace-mvp', 'project-docs', 'artifacts', 'automatic-file-changes.png'), fullPage: true });
  } finally {
    if (projectId && csrfToken) {
      const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID() };
      if (runId) {
        const run = (await (await page.request.get(`/api/v1/ai-runs/${runId}`)).json()).data;
        if (['ready', 'queued', 'running', 'waiting_approval'].includes(run.status)) await page.request.post(`/api/v1/ai-runs/${runId}/cancel`, { headers, data: {} });
      }
      const project = (await (await page.request.get(`/api/v1/projects/${projectId}`)).json()).data;
      if (project.status === 'active') expect((await page.request.patch(`/api/v1/projects/${projectId}`, { headers: { ...headers, 'If-Match': String(project.version) }, data: { status: 'archived' } })).status()).toBe(200);
    }
    for (const name of fixtureNames) {
      const fixturePath = join(fixtureDirectory, name);
      if (existsSync(fixturePath)) unlinkSync(fixturePath);
    }
    try { rmdirSync(fixtureDirectory); } catch { /* Leave any unexpected files untouched. */ }
  }
});
