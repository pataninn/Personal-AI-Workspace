import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { GlobalTaskItem } from '../src/entities/project-task';

test('all tasks displays readable priorities and responsive task rows', async ({ page }) => {
  test.skip(process.env.PAI_LIVE_TASK_UI_TEST !== '1', 'Explicit opt-in: creates an expiring local demo session.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByTestId('try-demo-button').click();
  await expect(page).toHaveURL(/\/dashboard/u);
  await expect.poll(async () => (await (await page.request.get('/api/v1/demo/showcase-copy')).json()).data.state).toBe('ready');
  // Exercise all visual states in this browser without changing the published data.
  await page.route(/\/api\/v1\/tasks(?:\?|$)/u, async (route) => {
    const response = await route.fetch();
    const body: { data: { items: GlobalTaskItem[]; nextCursor: string | null }; error: null } = await response.json();
    const importance = ['urgent', 'high', 'medium', 'low'] as const;
    const statuses = ['blocked', 'in_progress', 'todo', 'done'] as const;
    body.data.items = body.data.items.map((item, index) => ({ ...item, task: { ...item.task, importance: importance[index % 4], status: statuses[index % 4], deadline: index === 0 ? '2000-01-01' : null } }));
    await route.fulfill({ response, json: body });
  });
  await page.goto('/tasks');
  const rows = page.locator('.global-task-row');
  await expect(rows).toHaveCount(4);
  for (const priority of ['Urgent', 'High', 'Medium', 'Low']) {
    await expect(page.locator('.global-task-priority-badge').filter({ hasText: priority })).toBeVisible();
  }
  await expect(page.locator('.global-task-deadline.is-overdue')).toHaveCount(1);
  await expect(page.getByText('0/2 subtasks')).toBeVisible();
  await rows.first().focus(); await expect(rows.first()).toBeFocused();
  const screenshots = join(process.cwd(), '..', '.local');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'all-tasks-desktop.png'), fullPage: true });
  const colors = await page.locator('.global-task-priority-badge').evaluateAll((badges) => badges.map((badge) => getComputedStyle(badge).color));
  expect(new Set(colors).size).toBe(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, 'all-tasks-mobile.png'), fullPage: true });
});
