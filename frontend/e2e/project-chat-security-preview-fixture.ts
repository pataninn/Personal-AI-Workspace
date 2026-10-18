import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Page, Route, TestInfo } from '@playwright/test';
import {
  CONVERSATION_ID, MODEL, OWNER_ID, PERMISSION_ID, PREVIEW_CSRF_TOKEN, PREVIEW_TIME,
  PROJECT_ID, PROVIDER, PROVIDER_PROFILE, type ApiRequestRecord, type BrowserEvidence,
  type ProviderPermission, type RunPlan, type RunSnapshot, readRecord, readString, safeBody
} from './project-chat-security-preview-data';

interface SyntheticMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant';
  readonly sequence: number;
  readonly content: string;
  readonly createdAt: string;
}


export class ProjectChatPreviewFixture {
  readonly apiRequests: ApiRequestRecord[] = [];
  readonly runReadStatuses: string[] = [];
  readonly disclosedManifestHashes: string[] = [];
  readonly unhandledApiCalls: string[] = [];
  readonly providerPermissionsRevoked: string[] = [];
  readonly evidence: BrowserEvidence = {
    requests: [], responses: [], lifecycle: [], failedRequests: [], consoleErrors: [], pageErrors: [], blockedExternalRequests: []
  };

  private readonly runs = new Map<string, RunSnapshot>();
  private readonly manifests = new Map<string, Record<string, unknown>>();
  private readonly runIds: string[] = [];
  private readonly startRequests: ApiRequestRecord[] = [];
  private readonly cancelRequests: ApiRequestRecord[] = [];
  private readonly consentDecisions: ApiRequestRecord[] = [];
  private readonly permissions: ProviderPermission[] = [];
  private readonly submissions: ApiRequestRecord[] = [];
  private readonly messages: SyntheticMessage[] = [];
  private signedIn = false;
  private nextMessageId = 1;

  constructor(private readonly page: Page, private readonly plan: RunPlan) {
    page.on('request', (request) => this.captureRequest(request));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/v1/')) {
        this.evidence.responses.push({ path: url.pathname, status: response.status() });
        this.evidence.lifecycle.push({ step: 'response', method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });
    page.on('requestfinished', (request) => this.captureLifecycle(request, 'finished'));
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? null;
      this.evidence.failedRequests.push({ url: request.url(), failure });
      this.captureLifecycle(request, 'failed', failure);
    });
    page.on('console', (message) => { if (message.type() === 'error') this.evidence.consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => this.evidence.pageErrors.push(error.message));
  }

  async install(): Promise<void> {
    await this.page.route('**/*', (route) => this.blockExternalRequests(route));
    await this.page.route('**/api/v1/**', (route) => this.handleApi(route));
  }

  get submissionsCreated(): readonly ApiRequestRecord[] { return [...this.submissions]; }
  get starts(): readonly ApiRequestRecord[] { return [...this.startRequests]; }
  get cancellations(): readonly ApiRequestRecord[] { return [...this.cancelRequests]; }
  get decisions(): readonly ApiRequestRecord[] { return [...this.consentDecisions]; }
  get createdRunIds(): readonly string[] { return [...this.runIds]; }

  appendLaterMessage(content: string): void {
    this.addMessage(content);
  }

  confirmSavedCancellation(runId: string): void {
    const current = this.runs.get(runId);
    if (current) this.runs.set(runId, { ...current, status: 'cancelled', phase: 'terminal', cleanup: 'complete', safeMessage: 'Run cancelled.' });
  }

  async saveEvidence(testInfo: Pick<TestInfo, 'outputPath'>, name: string): Promise<void> {
    const root = process.env.PAI_TASK51_ARTIFACT_DIR ? resolve(process.env.PAI_TASK51_ARTIFACT_DIR) : testInfo.outputPath('browser-evidence');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${name}.json`), JSON.stringify({
      evidence: this.evidence,
      apiRequests: this.apiRequests,
      runReadStatuses: this.runReadStatuses,
      unhandledApiCalls: this.unhandledApiCalls,
      providerPermissionsRevoked: this.providerPermissionsRevoked,
      syntheticState: {
        runIds: this.runIds,
        submissions: this.submissions,
        consentDecisions: this.consentDecisions,
        startRunIds: this.startRequests.map((request) => request.path.split('/')[3]),
        cancellationRunIds: this.cancelRequests.map((request) => request.path.split('/')[3])
      }
    }, null, 2), 'utf8');
  }

  async screenshot(testInfo: Pick<TestInfo, 'outputPath'>, name: string): Promise<void> {
    const root = process.env.PAI_TASK51_ARTIFACT_DIR ? resolve(process.env.PAI_TASK51_ARTIFACT_DIR) : testInfo.outputPath('browser-evidence');
    await mkdir(root, { recursive: true });
    await this.page.screenshot({ path: join(root, name), fullPage: true });
  }

  private captureRequest(request: import('@playwright/test').Request): void {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/v1/')) return;
    const body = url.pathname.endsWith('/auth/login') ? '<redacted>' : safeBody(request.postData());
    const record: ApiRequestRecord = {
      method: request.method(), path: url.pathname, body,
      idempotencyKey: request.headers()['idempotency-key'] ?? null,
      csrfToken: request.headers()['x-csrf-token'] ?? null
    };
    this.apiRequests.push(record);
    this.evidence.lifecycle.push({ step: 'request', method: record.method, path: record.path });
  }

  private async blockExternalRequests(route: Route): Promise<void> {
    const requestUrl = new URL(route.request().url());
    const localOrigin = process.env.PAI_PREVIEW_BASE_URL ?? 'http://127.0.0.1:5173';
    if (requestUrl.origin === new URL(localOrigin).origin) return route.fallback();
    this.evidence.blockedExternalRequests.push(`${requestUrl.origin}${requestUrl.pathname}`);
    await route.abort();
  }

  private async handleApi(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/v1/auth/session' && method === 'GET') return this.respond(route, this.session(), this.signedIn ? 200 : 401, this.signedIn ? null : { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
    if (path === '/api/v1/auth/login' && method === 'POST') { this.signedIn = true; return this.respond(route, this.session()); }
    if (path === '/api/v1/auth/logout' && method === 'POST') { this.signedIn = false; return route.fulfill({ status: 204, body: '' }); }
    if (path === '/api/v1/home/conversations' && method === 'GET') return this.respond(route, { conversations: [], nextCursor: null });
    if (path === '/api/v1/projects' && method === 'GET') return this.respond(route, { projects: [this.project()] });
    if (path === '/api/v1/projects/overview' && method === 'GET') return this.respond(route, { projects: [{ ...this.project(), lastActivityAt: PREVIEW_TIME }], tasks: [] });
    if (path === '/api/v1/tasks/inbox/count' && method === 'GET') return this.respond(route, { count: 0 });
    if (path === `/api/v1/projects/${PROJECT_ID}` && method === 'GET') return this.respond(route, this.project());
    if (path === `/api/v1/projects/${PROJECT_ID}/conversations` && method === 'GET') return this.respond(route, { conversations: [this.conversation()], nextCursor: null });
    if (path === `/api/v1/conversations/${CONVERSATION_ID}` && method === 'GET') return this.respond(route, { conversation: this.conversation(), messages: [...this.messages], nextBeforeSequence: null });
    if (path === `/api/v1/projects/${PROJECT_ID}/files/tree` && method === 'GET') return this.respond(route, { directory: 'fixture/project', depth: 4, entries: [], truncated: false });
    if (path === `/api/v1/projects/${PROJECT_ID}/tasks` && method === 'GET') return this.respond(route, { tasks: [], orderVersion: 1 });
    if (path === `/api/v1/projects/${PROJECT_ID}/task-suggestions` && method === 'GET') return this.respond(route, { taskSuggestions: [] });
    const permissionPath = `/api/v1/projects/${PROJECT_ID}/provider-permissions`;
    if (path === permissionPath || path.startsWith(`${permissionPath}/`)) return this.handlePermissions(route, method);
    if (path === `/api/v1/projects/${PROJECT_ID}/chat-runs` && method === 'POST') return this.createRun(route);
    if (path.startsWith('/api/v1/ai-runs/')) return this.handleRun(route, path, method);
    this.unhandledApiCalls.push(`${method} ${path}`);
    await this.respond(route, null, 501, { code: 'PREVIEW_ROUTE_NOT_FOUND', message: 'No synthetic handler for this API route.' });
  }

  private async handlePermissions(route: Route, method: string): Promise<void> {
    if (method === 'GET') return this.respond(route, { permissions: this.permissions });
    const permissionId = route.request().url().split('/').at(-1) ?? '';
    if (method !== 'DELETE') return this.unhandled(route);
    this.providerPermissionsRevoked.push(permissionId);
    const index = this.permissions.findIndex((item) => item.id === permissionId);
    const permission = this.permissions[index];
    if (permission) this.permissions[index] = { ...permission, revokedAt: PREVIEW_TIME };
    await route.fulfill({ status: 204 });
  }

  private async createRun(route: Route): Promise<void> {
    const request = this.recordMutation(route);
    this.submissions.push(request);
    this.addMessage(readString(readRecord(request.body)?.request));
    const runId = this.nextRunId();
    const manifestHash = this.hashFor(this.runIds.length);
    this.disclosedManifestHashes.push(manifestHash);
    const matchingPermission = this.permissions.some((permission) => permission.revokedAt === null
      && permission.subject.ownerId === OWNER_ID && permission.projectId === PROJECT_ID
      && permission.providerProfile === PROVIDER_PROFILE && permission.model === MODEL
      && permission.capability === 'send_selected_context');
    const remembered = this.plan === 'permissions' && matchingPermission;
    const run = this.snapshot(runId, manifestHash, remembered ? 'ready' : 'pending_approval', remembered ? 'approved' : 'pending', remembered ? 'remembered_permission' : undefined);
    const manifest = this.manifest(runId, manifestHash, remembered ? 'ready' : 'pending_approval');
    this.runs.set(runId, run);
    this.manifests.set(runId, manifest);
    await this.respond(route, { run, manifest }, 202);
  }

  private async handleRun(route: Route, path: string, method: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    const runId = parts[3] ?? '';
    const suffix = parts.slice(4).join('/');
    const current = this.runs.get(runId);
    if (suffix === 'events' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache' }, body: ': synthetic preview stream\n\n' });
      return;
    }
    if (method === 'GET' && suffix === '' && current) {
      this.runReadStatuses.push(current.status);
      await this.respond(route, current);
      return;
    }
    if (method === 'GET' && suffix === 'egress-manifest' && current) return this.respond(route, this.manifests.get(runId) ?? null);
    if (method === 'POST' && suffix === 'egress-decision' && current) return this.decide(route, runId, current);
    if (method === 'POST' && suffix === 'start' && current) return this.start(route, runId, current);
    if (method === 'POST' && suffix === 'cancel' && current) return this.cancel(route, runId, current);
    await this.unhandled(route);
  }

  private async decide(route: Route, runId: string, current: RunSnapshot): Promise<void> {
    const request = this.recordMutation(route);
    this.consentDecisions.push(request);
    const body = readRecord(request.body);
    const approved = body?.decision === 'approve';
    const remembered = approved && body?.rememberProviderPermission === true;
    const next = this.snapshot(runId, current.manifestHash, approved ? 'ready' : 'rejected', approved ? 'approved' : 'rejected', remembered ? 'one_time' : approved ? 'one_time' : undefined);
    this.runs.set(runId, next);
    this.manifests.set(runId, this.manifest(runId, current.manifestHash, approved ? 'ready' : 'rejected'));
    if (remembered) this.permissions.push(this.permission());
    await this.respond(route, next);
  }

  private async start(route: Route, runId: string, current: RunSnapshot): Promise<void> {
    this.startRequests.push(this.recordMutation(route));
    let next: RunSnapshot;
    if (this.plan === 'cancellation') next = this.snapshot(runId, current.manifestHash, 'running', 'approved', current.providerApprovalMode ?? 'one_time', 'transmitted_confirmed');
    else if (this.plan === 'recovery') {
      const outcomeIndex = this.startRequests.length - 1;
      next = outcomeIndex === 0
        ? this.snapshot(runId, current.manifestHash, 'review_required', 'approved', 'one_time', 'not_started_confirmed')
        : this.snapshot(runId, current.manifestHash, 'review_required', 'approved', 'one_time', 'unknown');
    } else next = this.snapshot(runId, current.manifestHash, 'succeeded', 'approved', current.providerApprovalMode ?? 'one_time', 'transmitted_confirmed');
    this.runs.set(runId, next);
    await this.respond(route, next);
  }

  private async cancel(route: Route, runId: string, current: RunSnapshot): Promise<void> {
    this.cancelRequests.push(this.recordMutation(route));
    const next = this.snapshot(runId, current.manifestHash, 'cancel_requested', 'approved', current.providerApprovalMode ?? 'one_time', 'transmitted_confirmed');
    this.runs.set(runId, next);
    await this.respond(route, next);
  }

  private snapshot(runId: string, manifestHash: string, status: string, decision: string, providerApprovalMode?: 'remembered_permission' | 'one_time', providerTransmission = 'not_started'): RunSnapshot {
    return {
      runId, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, status,
      phase: status === 'pending_approval' ? 'decision' : status === 'review_required' ? 'review' : status === 'cancelled' || status === 'rejected' || status === 'succeeded' ? 'terminal' : status === 'running' || status === 'cancel_requested' ? 'inference' : 'runtime',
      manifestHash, decision, ...(providerApprovalMode ? { providerApprovalMode } : {}),
      safeMessage: status === 'review_required' ? 'The synthetic run requires a status review.' : status === 'cancel_requested' ? 'Cancellation is pending.' : 'Synthetic preview state.',
      cleanup: status === 'cancelled' || status === 'succeeded' || status === 'rejected' ? 'complete' : 'unknown',
      providerTransmission, stagingItemCount: 0
    };
  }

  private manifest(runId: string, manifestHash: string, status: string): Record<string, unknown> {
    return {
      runId, manifestHash, status, provider: PROVIDER, providerProfile: PROVIDER_PROFILE, model: MODEL,
      content: { categories: ['Request'], relativePaths: [], itemCount: 1, messageCount: 0, facts: [], byteEstimate: 38, tokenEstimate: 9 },
      redaction: { excludedItemCount: 0, omittedItemCount: 0, summary: 'No context items were omitted.' }, bestEffortSecretDetection: true
    };
  }

  private permission(): ProviderPermission {
    return { id: PERMISSION_ID, subject: { ownerId: OWNER_ID }, projectId: PROJECT_ID, providerProfile: PROVIDER_PROFILE,
      model: MODEL, capability: 'send_selected_context', persistence: 'until_revoked', expiresAt: null, createdAt: PREVIEW_TIME, revokedAt: null };
  }

  private project(): Record<string, unknown> {
    return { id: PROJECT_ID, name: 'Website redesign', slug: 'website-redesign', relativeRoot: 'fixtures/website-redesign', workspaceMode: 'file_backed',
      objective: 'Keep the synthetic project isolated.', capabilities: { planning: true, fileAccess: true }, status: 'active', version: 1, createdAt: PREVIEW_TIME, updatedAt: PREVIEW_TIME };
  }

  private conversation(): Record<string, unknown> {
    return { id: CONVERSATION_ID, projectId: PROJECT_ID, title: 'Consent regression fixture', status: 'active', lastActivityAt: PREVIEW_TIME, createdAt: PREVIEW_TIME, updatedAt: PREVIEW_TIME };
  }

  private session(): Record<string, unknown> {
    return { principal: { id: OWNER_ID, displayName: 'Preview user', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: PREVIEW_CSRF_TOKEN, expiresAt: '2027-01-01T00:00:00.000Z' };
  }

  private addMessage(content: string): void {
    this.messages.push({ id: `synthetic-message-${this.nextMessageId}`, conversationId: CONVERSATION_ID, role: 'user', sequence: this.nextMessageId, content, createdAt: PREVIEW_TIME });
    this.nextMessageId += 1;
  }

  private nextRunId(): string {
    const runId = `b7fa23e0-9a91-4b77-9c0c-${String(this.runIds.length + 1).padStart(12, '0')}`;
    this.runIds.push(runId);
    return runId;
  }

  private hashFor(index: number): string { return String(index + 1).padStart(64, '0'); }

  private recordMutation(route: Route): ApiRequestRecord {
    const request = route.request();
    const url = new URL(request.url());
    const body = safeBody(request.postData());
    return { method: request.method(), path: url.pathname, body, idempotencyKey: request.headers()['idempotency-key'] ?? null, csrfToken: request.headers()['x-csrf-token'] ?? null };
  }

  private captureLifecycle(request: import('@playwright/test').Request, step: 'finished' | 'failed', failure?: string | null): void {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/v1/')) return;
    this.evidence.lifecycle.push({ step, method: request.method(), path: url.pathname, ...(step === 'failed' ? { failure: failure ?? null } : {}) });
  }

  private async respond(route: Route, data: unknown, status = 200, error: unknown = null): Promise<void> {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
  }

  private async unhandled(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    this.unhandledApiCalls.push(`${request.method()} ${path}`);
    await this.respond(route, null, 501, { code: 'PREVIEW_ROUTE_NOT_FOUND', message: 'No synthetic handler for this API route.' });
  }
}

export async function signInToProjectChat(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier-input').fill('owner');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
}
