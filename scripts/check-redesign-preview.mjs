import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '../frontend/node_modules/@playwright/test/index.mjs';

const base = 'http://127.0.0.1:5173';
const projectId = '873c096a-bc57-4a0c-85da-10d4febde96b';
const conversationId = '489541da-57a5-416d-afb6-45b19ad7bc98';
const taskTitle = `Browser checklist ${Date.now()}`;
const artifacts = path.resolve('../.codex/docs/personal-ai-workspace-mvp/task-r-chat-task-redesign/artifacts');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const headers = { 'X-CSRF-Token': 'preview-only-csrf-token' };
try {
  await context.request.post(`${base}/api/v1/auth/login`, { data: { password: 'mock-preview-only' } });
  for (let index = 0; index < 4; index++) {
    const result = await context.request.post(`${base}/api/v1/projects`, { headers, data: { name: `Preview extra ${index}`, relativeRoot: `preview-extra-${Date.now()}-${index}` } });
    assert.equal(result.status(), 201);
  }
  await page.goto(`${base}/dashboard`);
  await page.getByRole('heading', { name: 'Recent projects' }).waitFor();
  assert.equal(await page.locator('section[aria-labelledby="recent-projects-heading"] [data-testid="project-item"]').count(), 4);
  assert.equal(await page.getByTestId('home-more-projects').evaluate((node) => node.open), false);
  await page.getByTestId('home-more-projects').locator('summary').click();
  await page.getByRole('heading', { name: 'Website redesign', exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'home-desktop.png'), fullPage: true });

  await page.goto(`${base}/projects/${projectId}/conversations/${conversationId}`);
  await page.getByRole('heading', { name: 'Homepage ideas' }).waitFor();
  await page.getByTestId('project-task-results').locator('summary').first().waitFor();
  const chat = await page.locator('.workspace-chat').boundingBox();
  const tasks = await page.locator('.workspace-tasks').boundingBox();
  const files = await page.locator('.workspace-files').boundingBox();
  assert(chat.width > tasks.width); assert(tasks.x > chat.x); assert(files.y > tasks.y);
  assert.equal(await page.getByTestId('workspace-panel-picker').isVisible(), false);

  await page.getByRole('button', { name: /^Suggested/ }).click();
  await page.getByText('Prepare the launch checklist', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByTestId('project-task-add').click();
  assert.equal(await page.getByLabel('Importance', { exact: true }).inputValue(), 'medium');
  await page.getByLabel('Task title', { exact: true }).fill(taskTitle);
  await page.getByLabel('Importance', { exact: true }).selectOption('urgent');
  await page.getByLabel('Deadline (optional)', { exact: true }).fill('2026-10-08');
  await page.getByTestId('project-task-add-subtask').click();
  await page.getByLabel('Subtask 1', { exact: true }).fill('First item');
  await page.getByTestId('project-task-add-subtask').click();
  await page.getByLabel('Subtask 2', { exact: true }).fill('Second item');
  await page.getByRole('button', { name: 'Add task', exact: true }).last().click();
  const row = page.getByTestId('project-task-results').locator('li[data-testid^="project-task-row"]').filter({ has: page.locator('summary', { hasText: taskTitle }) });
  await row.locator('summary').click();
  await row.getByRole('checkbox', { name: 'First item' }).click();
  await expect(row.getByRole('checkbox', { name: 'First item' })).toBeChecked();
  await expect(row.getByRole('button', { name: 'Mark complete' })).toBeEnabled();
  await row.getByRole('button', { name: 'Mark complete' }).click();
  // Switch to completed work after the open filter removes the finished task.
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const completed = page.getByTestId('project-task-results').locator('li[data-testid^="project-task-row"]').filter({ has: page.locator('summary', { hasText: taskTitle }) });
  await completed.locator('summary').click();
  assert.equal(await completed.getByRole('checkbox', { name: 'Second item' }).isChecked(), true);
  await completed.getByRole('checkbox', { name: 'First item' }).click();
  await completed.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByText(taskTitle, { exact: true }).waitFor();

  await page.getByLabel('Message', { exact: true }).fill('Show a plan with Markdown and math');
  const assistantCount = await page.locator('.message-assistant').count();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message-assistant')).toHaveCount(assistantCount + 1);
  await page.locator('.message-assistant').last().locator('.markdown-content table').waitFor();
  assert.equal(await page.locator('.message-assistant').last().locator('.katex').count(), 1);
  await page.getByRole('button', { name: 'Copy code' }).last().click();
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes('nextStep'));
  const scroll = await page.getByTestId('conversation-history').evaluate((node) => ({ bottom: node.scrollHeight - node.scrollTop - node.clientHeight }));
  assert(scroll.bottom < 90);
  await page.screenshot({ path: path.join(artifacts, 'workspace-desktop.png'), fullPage: true });

  // Bounded synthetic history tests scrolling without making provider requests.
  const historyUrl = `${base}/api/v1/conversations/${conversationId}?projectId=${projectId}`;
  const persisted = (await (await context.request.get(historyUrl)).json()).data;
  const historyRoute = `**/api/v1/conversations/${conversationId}?*`;
  await page.route(historyRoute, async (route) => {
    const older = new URL(route.request().url()).searchParams.has('beforeSequence');
    const first = older ? 61 : 81;
    const messages = Array.from({ length: 20 }, (_, index) => ({ id: `scroll-${first + index}`, conversationId, role: 'user', sequence: first + index, content: `History message ${first + index}\n${'A longer paragraph to exercise the history viewport. '.repeat(6)}`, createdAt: '2026-10-01T12:00:00Z' }));
    await route.fulfill({ json: { data: { ...persisted, messages, nextBeforeSequence: older ? null : 81 }, error: null } });
  });
  await page.reload();
  const viewport = page.getByTestId('conversation-history');
  await page.getByText(/History message 100/).waitFor();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(80);
  await viewport.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await page.getByTestId('chat-jump-latest').waitFor();
  const anchor = page.getByTestId('message-item').filter({ hasText: 'History message 81' });
  const anchorBefore = (await anchor.boundingBox()).y;
  await page.getByTestId('conversation-history-load-older').click();
  await page.getByText(/History message 61/).waitFor();
  await expect.poll(async () => Math.abs((await anchor.boundingBox()).y - anchorBefore)).toBeLessThan(80);
  await page.getByTestId('chat-jump-latest').click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(80);
  await page.unroute(historyRoute);

  const folder = page.locator('.file-folder').filter({ has: page.locator('summary', { hasText: /^src\/$/ }) }).first();
  assert.equal(await folder.evaluate((node) => node.open), false);
  await page.locator('input[type="file"]').setInputFiles({ name: 'browser-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Browser note\n\nOriginal content') });
  const fileRow = page.locator('.project-file-row').filter({ has: page.locator('summary', { hasText: 'browser-notes.md' }) });
  await fileRow.locator('summary').click();
  await fileRow.getByRole('heading', { name: 'Browser note' }).waitFor();
  await fileRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await fileRow.getByLabel('File content').fill('# Browser note\n\nUpdated content');
  await fileRow.getByRole('button', { name: 'Save', exact: true }).click();
  await fileRow.getByText('Updated content', { exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await fileRow.getByRole('button', { name: 'Download', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'browser-notes.md');
  await fileRow.getByRole('button', { name: 'Delete file', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete file', exact: true }).click();
  await fileRow.waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByTestId('workspace-panel-picker').inputValue(), 'chat');
  assert.equal(await page.locator('.workspace-side').isVisible(), false);
  await page.getByTestId('workspace-panel-picker').selectOption('tasks');
  assert.equal(await page.locator('.workspace-tasks').isVisible(), true);
  assert.equal(await page.locator('.workspace-chat').isVisible(), false);
  await page.screenshot({ path: path.join(artifacts, 'workspace-mobile-tasks.png'), fullPage: true });
  await page.getByTestId('workspace-panel-picker').selectOption('files');
  assert.equal(await page.locator('.workspace-files').isVisible(), true);
  await page.getByTestId('workspace-panel-picker').selectOption('chat');
  await page.screenshot({ path: path.join(artifacts, 'workspace-mobile-chat.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'browser-preview.json'), JSON.stringify({ passed: true, desktopChatWidth: chat.width, tasksWidth: tasks.width, checks: ['home four+collapsed remainder', 'inline checklist completion/reopen', 'suggestions current chat', 'Markdown/math/code copy', 'latest chat bottom', 'file upload/edit/download/delete', 'collapsed folders', 'mobile dropdown panels', 'no page errors'], pageErrors: errors }, null, 2));
  process.stdout.write('Preview browser checks passed. Screenshots and evidence saved.\n');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'browser-preview-failure.png'), fullPage: true });
  await writeFile(path.join(artifacts, 'browser-preview-error.txt'), String(error));
  throw error;
} finally { await browser.close(); }
