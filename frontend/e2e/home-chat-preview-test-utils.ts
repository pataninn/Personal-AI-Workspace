import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { expect, type Locator, type Page, type Request, type Response, type TestInfo } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';

export interface HomeRequestEvidence {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly idempotencyKey: string | null;
}

export interface HomeResponseEvidence {
  readonly url: string;
  readonly status: number;
}

export interface BrowserEvidence {
  readonly requests: HomeRequestEvidence[];
  readonly responses: HomeResponseEvidence[];
  readonly failedRequests: Array<{ readonly url: string; readonly failure: string | null }>;
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly metadata: Record<string, unknown>;
}

const evidenceByPage = new WeakMap<Page, BrowserEvidence>();
const fixtureByPage = new WeakMap<Page, HomeChatPreviewApi>();

export function startBrowserEvidence(page: Page): void {
  const evidence: BrowserEvidence = { requests: [], responses: [], failedRequests: [], consoleErrors: [], pageErrors: [], metadata: {} };
  evidenceByPage.set(page, evidence);
  page.on('request', (request) => captureRequest(evidence, request));
  page.on('response', (response) => captureResponse(evidence, response));
  page.on('requestfailed', (request) => evidence.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
}

export function setBrowserEvidenceMetadata(page: Page, key: string, value: unknown): void {
  const evidence = evidenceByPage.get(page);
  if (evidence) evidence.metadata[key] = value;
}

export async function installFixture(page: Page, fixture: HomeChatPreviewApi): Promise<void> {
  fixtureByPage.set(page, fixture);
  await fixture.install();
}

export async function saveBrowserEvidence(page: Page, title: string, fallbackDirectory: string): Promise<void> {
  const evidence = evidenceByPage.get(page);
  if (!evidence) return;
  const fixture = fixtureByPage.get(page);
  if (fixture) {
    evidence.metadata.homeApiCalls = fixture.calls;
    evidence.metadata.blockedProviderOrBridgeRequests = fixture.getBlockedExternalRequests();
  }
  const directory = process.env.PAI_HOME_CHAT_ARTIFACT_DIR ? resolve(process.env.PAI_HOME_CHAT_ARTIFACT_DIR) : fallbackDirectory;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${slug(title)}-browser-evidence.json`), JSON.stringify(evidence, null, 2), 'utf8');
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

export async function openHomeAsk(page: Page, conversationId?: string): Promise<void> {
  await page.getByTestId('home-ask-launcher').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  if (conversationId) {
    await page.getByTestId('home-chat-conversation-trigger').click();
    await page.getByTestId(`home-chat-history-item-${conversationId}`).click();
  }
}

export async function approveByKeyboard(page: Page, dialog: Locator, buttonName: string): Promise<void> {
  const firstButton = dialog.getByRole('button', { name: 'Keep private' });
  await expect(firstButton).toBeFocused();
  if (buttonName === 'Keep private') {
    await page.keyboard.press('Enter');
    return;
  }
  await page.keyboard.press('Tab');
  const target = dialog.getByRole('button', { name: buttonName });
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
}

export async function captureScreenshot(page: Page, testInfo: Pick<TestInfo, 'outputPath'>, name: string): Promise<void> {
  const directory = process.env.PAI_HOME_CHAT_ARTIFACT_DIR ? resolve(process.env.PAI_HOME_CHAT_ARTIFACT_DIR) : dirname(testInfo.outputPath('evidence'));
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: true });
}

export interface SyntheticProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly workspaceMode: 'planning' | 'file_backed';
  readonly capabilities: { readonly planning: true; readonly fileAccess: boolean };
  readonly status: 'active' | 'archived';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function archivedWorkspace(id: string, time: string): SyntheticProject {
  return {
    id,
    name: 'Planning workspace',
    slug: 'planning-workspace',
    workspaceMode: 'planning',
    capabilities: { planning: true, fileAccess: false },
    status: 'archived',
    version: 2,
    createdAt: time,
    updatedAt: time
  };
}

export function fileBackedProject(time: string): SyntheticProject {
  return {
    id: 'file-backed-id',
    name: 'File-backed project',
    slug: 'file-backed-project',
    workspaceMode: 'file_backed',
    capabilities: { planning: true, fileAccess: true },
    status: 'active',
    version: 1,
    createdAt: time,
    updatedAt: time
  };
}

function captureRequest(evidence: BrowserEvidence, request: Request): void {
  if (!request.url().includes('/api/v1/home/conversations')) return;
  evidence.requests.push({
    method: request.method(),
    url: request.url(),
    body: request.postData(),
    idempotencyKey: request.headers()['idempotency-key'] ?? null
  });
}

function captureResponse(evidence: BrowserEvidence, response: Response): void {
  if (response.url().includes('/api/v1/home/conversations')) evidence.responses.push({ url: response.url(), status: response.status() });
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '');
}
