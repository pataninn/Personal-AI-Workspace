import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Page, Route, TestInfo } from '@playwright/test';

const PROJECTS_PATH = '/api/v1/projects';
const OVERVIEW_PATH = '/api/v1/projects/overview';
const INBOX_COUNT_PATH = '/api/v1/tasks/inbox/count';
const HOME_CONVERSATIONS_PATH = '/api/v1/home/conversations';
const AUTH_SESSION_PATH = '/api/v1/auth/session';
const AUTH_LOGIN_PATH = '/api/v1/auth/login';
const SYNTHETIC_SESSION = {
  principal: { id: 'home-summaries-preview-user', displayName: 'Synthetic preview user' },
  csrfToken: 'preview-only-csrf-token',
  expiresAt: '2099-01-01T00:00:00.000Z'
} as const;

export const SYNTHETIC_SUMMARY_TIME = '2026-10-01T12:00:00.000Z';
export const ACTIVE_WORKSPACE_ID = 'b3100000-0000-4000-8000-000000000001';
export const ARCHIVED_WORKSPACE_ID = 'b3100000-0000-4000-8000-000000000002';
export const FIRST_UP_NEXT_TASK_ID = 'b3100000-0000-4000-8000-000000000003';
export const SECOND_UP_NEXT_TASK_ID = 'b3100000-0000-4000-8000-000000000004';
export const HOME_SUMMARY_CONVERSATION_ID = 'b3200000-0000-4000-8000-000000000001';
export const HOME_SUMMARY_TURN_ID = 'b3200000-0000-4000-8000-000000000002';
export const HOME_SUMMARY_MESSAGE_ID = 'b3200000-0000-4000-8000-000000000003';
export const CONFLICT_RECEIPT_ID = 'b3200000-0000-4000-8000-000000000010';
export const RETRY_RECEIPT_ID = 'b3200000-0000-4000-8000-000000000011';
export const CONFLICT_TASK_ID = 'b3200000-0000-4000-8000-000000000020';
export const RETRY_TASK_ID = 'b3200000-0000-4000-8000-000000000021';
export const DRAFT_PROPOSAL_ID = 'b3200000-0000-4000-8000-000000000030';
export const ACCEPT_PROPOSAL_ID = 'b3200000-0000-4000-8000-000000000031';
export const DRAFT_ITEM_ONE_ID = 'b3200000-0000-4000-8000-000000000040';
export const DRAFT_ITEM_TWO_ID = 'b3200000-0000-4000-8000-000000000041';
export const PARTIAL_UPDATE_ITEM_ID = 'b3200000-0000-4000-8000-000000000044';
export const STATUS_ONLY_UPDATE_ITEM_ID = 'b3200000-0000-4000-8000-000000000045';
export const PARTIAL_UPDATE_TASK_ID = 'b3200000-0000-4000-8000-000000000046';
export const STATUS_ONLY_UPDATE_TASK_ID = 'b3200000-0000-4000-8000-000000000047';
export const ACCEPT_ITEM_ONE_ID = 'b3200000-0000-4000-8000-000000000050';
export const ACCEPT_ITEM_TWO_ID = 'b3200000-0000-4000-8000-000000000051';
export const ACCEPT_ITEM_THREE_ID = 'b3200000-0000-4000-8000-000000000052';
export const ACCEPT_RECEIPT_ONE_ID = 'b3200000-0000-4000-8000-000000000070';
export const ACCEPT_RECEIPT_TWO_ID = 'b3200000-0000-4000-8000-000000000071';
export const ACCEPT_TASK_ONE_ID = 'b3200000-0000-4000-8000-000000000080';
export const ACCEPT_TASK_TWO_ID = 'b3200000-0000-4000-8000-000000000081';
export const ACCEPT_TASK_THREE_ID = 'b3200000-0000-4000-8000-000000000082';

export const SYNTHETIC_ACTIVE_WORKSPACE = {
  id: ACTIVE_WORKSPACE_ID,
  name: 'Synthetic Planning Workspace',
  slug: 'synthetic-planning-workspace',
  relativeRoot: null,
  objective: 'Prepare the next release review.',
  workspaceMode: 'planning',
  capabilities: { planning: true, fileAccess: false },
  status: 'active',
  version: 1,
  createdAt: SYNTHETIC_SUMMARY_TIME,
  updatedAt: SYNTHETIC_SUMMARY_TIME
} as const;

export const SYNTHETIC_ARCHIVED_WORKSPACE = {
  id: ARCHIVED_WORKSPACE_ID,
  name: 'Synthetic Archived Workspace',
  slug: 'synthetic-archived-workspace',
  relativeRoot: null,
  objective: 'Prior release planning.',
  workspaceMode: 'planning',
  capabilities: { planning: true, fileAccess: false },
  status: 'archived',
  version: 2,
  createdAt: SYNTHETIC_SUMMARY_TIME,
  updatedAt: SYNTHETIC_SUMMARY_TIME
} as const;

export const SYNTHETIC_UP_NEXT_TASKS = [
  {
    id: FIRST_UP_NEXT_TASK_ID,
    projectId: ACTIVE_WORKSPACE_ID,
    projectName: SYNTHETIC_ACTIVE_WORKSPACE.name,
    title: 'Write the synthetic release review plan and verify its longest title wraps safely in a narrow viewport',
    status: 'in_progress',
    importance: 'high',
    deadline: '2099-10-05',
    version: 1
  },
  {
    id: SECOND_UP_NEXT_TASK_ID,
    projectId: ACTIVE_WORKSPACE_ID,
    projectName: SYNTHETIC_ACTIVE_WORKSPACE.name,
    title: 'Confirm the synthetic handoff checklist',
    status: 'todo',
    importance: 'medium',
    deadline: null,
    version: 1
  }
] as const;

export interface SummaryPreviewCalls {
  readonly auth: Array<{ readonly method: 'GET' | 'POST'; readonly status: number }>;
  readonly overview: string[];
  readonly projectLists: string[];
  inboxCount: number;
}

export interface PreviewBrowserEvidence {
  readonly requests: Array<{ readonly method: string; readonly url: string; readonly body: string | null }>;
  readonly responses: Array<{ readonly method: string; readonly url: string; readonly status: number }>;
  readonly failedRequests: Array<{ readonly url: string; readonly failure: string | null }>;
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly metadata: Record<string, unknown>;
}

interface SyntheticHomeEvent {
  readonly sequence: number;
  readonly type: string;
  readonly turnId: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  readonly createdAt: string;
}

interface SyntheticReceiptMetadata {
  readonly id: string;
  readonly actionKind: string;
  readonly targetKind: 'task';
  readonly targetId: string;
  readonly postVersion: number | null;
  readonly undoStatus: 'available' | 'not_reversible' | 'undone';
  readonly undoActionId: string | null;
}

type SyntheticUndoBehavior = 'success' | 'conflict' | 'response-lost-once';

interface SyntheticReceiptRecord {
  metadata: SyntheticReceiptMetadata;
  readonly behavior: SyntheticUndoBehavior;
  undoAttempts: number;
}

interface SyntheticProposalItem {
  readonly id: string;
  readonly position: number;
  readonly action: 'task.create' | 'task.update';
  readonly command: Readonly<Record<string, unknown>>;
  readonly deadlineResolution: { readonly timeZone: string; readonly source: 'configured' | 'utc-fallback' } | null;
  readonly state: 'ready' | 'saved' | 'failed' | 'unknown';
  readonly receiptId: string | null;
  readonly resultCode: string | null;
}

interface SyntheticProposal {
  readonly id: string;
  readonly sourceTurnId: string;
  readonly scope: { readonly kind: 'home' };
  state: 'review_required' | 'partial';
  revision: number;
  acceptedRevision: number | null;
  acceptanceId: string | null;
  itemCount: number;
  readonly createdAt: string;
  updatedAt: string;
  items: SyntheticProposalItem[];
}

export interface HomePlanningPreviewCalls {
  readonly eventCursors: number[];
  readonly receiptReads: string[];
  readonly targetReads: string[];
  readonly undoRequests: Array<{ readonly receiptId: string; readonly idempotencyKey: string; readonly body: unknown }>;
  readonly proposalListQueries: string[];
  readonly proposalDetails: string[];
  readonly proposalEdits: Array<{ readonly proposalId: string; readonly itemId: string; readonly body: unknown }>;
  readonly proposalRemovals: Array<{ readonly proposalId: string; readonly itemId: string; readonly ifMatch: string | null }>;
  readonly proposalAcceptances: Array<{ readonly proposalId: string; readonly body: unknown }>;
  readonly proposalResumes: string[];
  readonly proposalCancellations: Array<{ readonly proposalId: string; readonly body: unknown }>;
}

const evidenceByPage = new WeakMap<Page, PreviewBrowserEvidence>();

export class HomeSummariesPreviewApi {
  readonly calls: SummaryPreviewCalls = { auth: [], overview: [], projectLists: [], inboxCount: 0 };
  private authenticated = false;

  constructor(private readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.route(`**${AUTH_SESSION_PATH}`, async (route) => this.handleSession(route));
    await this.page.route(`**${AUTH_LOGIN_PATH}`, async (route) => this.handleLogin(route));
    await this.page.route(`**${PROJECTS_PATH}**`, async (route) => this.handleProjects(route));
    await this.page.route(`**${INBOX_COUNT_PATH}`, async (route) => this.handleInboxCount(route));
  }

  getCalls(): SummaryPreviewCalls {
    return this.calls;
  }

  private async handleSession(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') return route.fallback();
    const status = this.authenticated ? 200 : 401;
    this.calls.auth.push({ method: 'GET', status });
    if (this.authenticated) return respond(route, SYNTHETIC_SESSION);
    await respond(route, null, status, { code: 'SESSION_UNAUTHENTICATED', message: 'Sign in is required.' });
  }

  private async handleLogin(route: Route): Promise<void> {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = asRecord(await readJsonBody(route));
    if (typeof body?.password !== 'string' || body.password.trim().length === 0) {
      this.calls.auth.push({ method: 'POST', status: 401 });
      await respond(route, null, 401, { code: 'SESSION_UNAUTHENTICATED', message: 'A preview password is required.' });
      return;
    }
    this.authenticated = true;
    this.calls.auth.push({ method: 'POST', status: 200 });
    await respond(route, SYNTHETIC_SESSION);
  }

  private async handleProjects(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();

    if (url.pathname === OVERVIEW_PATH) {
      this.calls.overview.push(url.search);
      await respond(route, {
        projects: [{ ...SYNTHETIC_ACTIVE_WORKSPACE, lastActivityAt: SYNTHETIC_SUMMARY_TIME }],
        tasks: SYNTHETIC_UP_NEXT_TASKS
      });
      return;
    }

    if (url.pathname === PROJECTS_PATH && url.searchParams.get('includeArchived') === 'true') {
      this.calls.projectLists.push(url.search);
      await respond(route, { projects: [SYNTHETIC_ACTIVE_WORKSPACE, SYNTHETIC_ARCHIVED_WORKSPACE] });
      return;
    }

    await route.fallback();
  }

  private async handleInboxCount(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') return route.fallback();
    this.calls.inboxCount += 1;
    await respond(route, { count: 3 });
  }
}

/** Synthetic event, receipt, target, and proposal APIs for Home planning-card browser checks. */
export class HomePlanningRecordsPreviewApi {
  readonly calls: HomePlanningPreviewCalls = {
    eventCursors: [], receiptReads: [], targetReads: [], undoRequests: [], proposalListQueries: [], proposalDetails: [],
    proposalEdits: [], proposalRemovals: [], proposalAcceptances: [], proposalResumes: [], proposalCancellations: []
  };

  private events: SyntheticHomeEvent[] = [];
  private readonly receipts = new Map<string, SyntheticReceiptRecord>();
  private readonly proposals = new Map<string, SyntheticProposal>();
  private readonly tasks = new Map<string, Record<string, unknown>>();

  constructor(private readonly page: Page, options: { readonly includeInitialReceipts?: boolean } = {}) {
    this.seedTask(CONFLICT_TASK_ID, 'Synthetic task with a changed version');
    this.seedTask(RETRY_TASK_ID, 'Synthetic task with an uncertain undo');
    this.seedTask(ACCEPT_TASK_ONE_ID, 'Prepare release checklist');
    this.seedTask(ACCEPT_TASK_TWO_ID, 'Verify release handoff');
    this.seedTask(ACCEPT_TASK_THREE_ID, 'Confirm the rollout window');
    this.seedTask(PARTIAL_UPDATE_TASK_ID, 'Task with a partial update');
    this.seedTask(STATUS_ONLY_UPDATE_TASK_ID, 'Task with a status-only update');
    this.seedReceipt(CONFLICT_RECEIPT_ID, CONFLICT_TASK_ID, 'conflict');
    this.seedReceipt(RETRY_RECEIPT_ID, RETRY_TASK_ID, 'response-lost-once');
    this.proposals.set(DRAFT_PROPOSAL_ID, makeDraftProposal());
    this.proposals.set(ACCEPT_PROPOSAL_ID, makeAcceptProposal());
    if (options.includeInitialReceipts ?? true) {
      this.appendEvent('action.receipt', CONFLICT_RECEIPT_ID, { actionKind: 'task.create', targetKind: 'task', targetId: CONFLICT_TASK_ID });
      this.appendEvent('action.receipt', RETRY_RECEIPT_ID, { actionKind: 'task.create', targetKind: 'task', targetId: RETRY_TASK_ID });
    }
  }

  async install(): Promise<void> {
    await this.page.route(`**${HOME_CONVERSATIONS_PATH}/**`, async (route) => this.handleConversationRoute(route));
    await this.page.route('**/api/v1/actions/**', async (route) => this.handleActionRoute(route));
    await this.page.route('**/api/v1/tasks/**', async (route) => this.handleTaskRoute(route));
    await this.page.route('**/api/v1/projects/**', async (route) => this.handleProjectRoute(route));
  }

  getCalls(): HomePlanningPreviewCalls {
    return this.calls;
  }

  private async handleConversationRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const prefix = `${HOME_CONVERSATIONS_PATH}/${HOME_SUMMARY_CONVERSATION_ID}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return route.fallback();
    const segments = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] === 'events' && request.method() === 'GET') return this.listEvents(route, url);
    if (segments[0] !== 'proposals') return route.fallback();
    if (segments.length === 1 && request.method() === 'GET') return this.listProposals(route, url);
    if (segments.length === 2 && request.method() === 'GET') return this.getProposal(route, segments[1] ?? '');
    if (segments.length === 4 && segments[2] === 'items' && request.method() === 'PATCH') return this.editProposalItem(route, segments[1] ?? '', segments[3] ?? '');
    if (segments.length === 4 && segments[2] === 'items' && request.method() === 'DELETE') return this.removeProposalItem(route, segments[1] ?? '', segments[3] ?? '');
    if (segments.length === 3 && segments[2] === 'acceptance' && request.method() === 'POST') return this.acceptProposal(route, segments[1] ?? '');
    if (segments.length === 3 && segments[2] === 'execution' && request.method() === 'POST') return this.resumeProposal(route, segments[1] ?? '');
    if (segments.length === 3 && segments[2] === 'cancellation' && request.method() === 'POST') return this.cancelProposal(route, segments[1] ?? '');
    return route.fallback();
  }

  private async listEvents(route: Route, url: URL): Promise<void> {
    const cursor = Number(url.searchParams.get('afterSequence') ?? '0');
    this.calls.eventCursors.push(cursor);
    await respond(route, { events: this.events.filter((event) => event.sequence > cursor), nextAfterSequence: null, lastEventSequence: this.lastSequence() });
  }

  private async listProposals(route: Route, url: URL): Promise<void> {
    this.calls.proposalListQueries.push(url.search);
    const proposals = [...this.proposals.values()].map((proposal) => ({
      id: proposal.id,
      sourceTurnId: proposal.sourceTurnId,
      state: proposal.state,
      revision: proposal.revision,
      itemCount: proposal.items.length,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt
    }));
    await respond(route, { proposals, nextCursor: null });
  }

  private async getProposal(route: Route, proposalId: string): Promise<void> {
    this.calls.proposalDetails.push(proposalId);
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal not found.' });
    await respond(route, { proposal });
  }

  private async editProposalItem(route: Route, proposalId: string, itemId: string): Promise<void> {
    const body = await readJsonBody(route);
    this.calls.proposalEdits.push({ proposalId, itemId, body });
    const proposal = this.proposals.get(proposalId);
    const changes = asRecord(body)?.changes;
    const item = proposal?.items.find((candidate) => candidate.id === itemId);
    if (!proposal || !item || !isRecord(changes)) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal item not found.' });
    proposal.revision += 1;
    proposal.updatedAt = new Date(Date.parse(SYNTHETIC_SUMMARY_TIME) + proposal.revision * 1000).toISOString();
    proposal.items = proposal.items.map((candidate) => candidate.id === itemId
      ? { ...candidate, command: { ...candidate.command, ...changes } }
      : candidate);
    proposal.itemCount = proposal.items.length;
    this.appendEvent('proposal.updated', proposal.id, { state: proposal.state });
    await respond(route, { proposal });
  }

  private async removeProposalItem(route: Route, proposalId: string, itemId: string): Promise<void> {
    this.calls.proposalRemovals.push({ proposalId, itemId, ifMatch: route.request().headers()['if-match'] ?? null });
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal not found.' });
    proposal.revision += 1;
    proposal.updatedAt = new Date(Date.parse(SYNTHETIC_SUMMARY_TIME) + proposal.revision * 1000).toISOString();
    proposal.items = proposal.items.filter((candidate) => candidate.id !== itemId).map((candidate, position) => ({ ...candidate, position }));
    proposal.itemCount = proposal.items.length;
    this.appendEvent('proposal.updated', proposal.id, { state: proposal.state });
    await respond(route, { proposal });
  }

  private async acceptProposal(route: Route, proposalId: string): Promise<void> {
    const body = await readJsonBody(route);
    this.calls.proposalAcceptances.push({ proposalId, body });
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal not found.' });
    const acceptedRevision = Number(asRecord(body)?.expectedRevision ?? proposal.revision);
    const items = proposal.items.map((item, index): SyntheticProposalItem => {
      if (index === 0) return { ...item, state: 'saved', receiptId: ACCEPT_RECEIPT_ONE_ID, resultCode: null };
      if (index === 1) return { ...item, state: 'saved', receiptId: ACCEPT_RECEIPT_TWO_ID, resultCode: null };
      return { ...item, state: 'unknown', receiptId: null, resultCode: 'execution_not_confirmed' };
    });
    proposal.state = 'partial';
    proposal.revision = acceptedRevision + 1;
    proposal.acceptedRevision = acceptedRevision;
    proposal.acceptanceId = 'b3200000-0000-4000-8000-000000000060';
    proposal.updatedAt = new Date(Date.parse(SYNTHETIC_SUMMARY_TIME) + proposal.revision * 1000).toISOString();
    proposal.items = items;
    proposal.itemCount = items.length;
    this.appendEvent('proposal.accepted', proposal.id, { state: proposal.state });
    this.appendEvent('action.receipt', ACCEPT_RECEIPT_ONE_ID, { actionKind: 'task.create', targetKind: 'task', targetId: ACCEPT_TASK_ONE_ID });
    this.appendEvent('action.receipt', ACCEPT_RECEIPT_TWO_ID, { actionKind: 'task.create', targetKind: 'task', targetId: ACCEPT_TASK_TWO_ID });
    this.receipts.set(ACCEPT_RECEIPT_ONE_ID, receiptRecord(ACCEPT_RECEIPT_ONE_ID, ACCEPT_TASK_ONE_ID, 'success'));
    this.receipts.set(ACCEPT_RECEIPT_TWO_ID, receiptRecord(ACCEPT_RECEIPT_TWO_ID, ACCEPT_TASK_TWO_ID, 'success'));
    await respond(route, {
      proposal,
      acceptance: { id: proposal.acceptanceId, revision: acceptedRevision },
      execution: { state: 'partial', items: items.map((item) => ({ itemId: item.id, state: item.state, receiptId: item.receiptId, resultCode: item.resultCode })) },
      replayed: false
    });
  }

  private async resumeProposal(route: Route, proposalId: string): Promise<void> {
    this.calls.proposalResumes.push(proposalId);
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal not found.' });
    const resumedItem = proposal.items.find((item) => item.state === 'unknown' && item.receiptId === null);
    const items = proposal.items.map((item) => item.id === resumedItem?.id
      ? { ...item, state: 'saved' as const, receiptId: 'b3200000-0000-4000-8000-000000000072', resultCode: null }
      : item);
    proposal.state = 'partial';
    proposal.revision += 1;
    proposal.updatedAt = new Date(Date.parse(SYNTHETIC_SUMMARY_TIME) + proposal.revision * 1000).toISOString();
    proposal.items = items;
    this.receipts.set('b3200000-0000-4000-8000-000000000072', receiptRecord('b3200000-0000-4000-8000-000000000072', ACCEPT_TASK_THREE_ID, 'success'));
    this.appendEvent('action.receipt', 'b3200000-0000-4000-8000-000000000072', { actionKind: 'task.create', targetKind: 'task', targetId: ACCEPT_TASK_THREE_ID });
    this.appendEvent('proposal.item_status_changed', proposal.id, { state: proposal.state });
    await respond(route, {
      proposal,
      execution: { state: 'partial', items: items.map((item) => ({ itemId: item.id, state: item.state, receiptId: item.receiptId, resultCode: item.resultCode })) },
      replayed: false
    });
  }

  private async cancelProposal(route: Route, proposalId: string): Promise<void> {
    const body = await readJsonBody(route);
    this.calls.proposalCancellations.push({ proposalId, body });
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic proposal not found.' });
    proposal.state = 'partial';
    proposal.revision += 1;
    proposal.updatedAt = new Date(Date.parse(SYNTHETIC_SUMMARY_TIME) + proposal.revision * 1000).toISOString();
    this.appendEvent('proposal.cancelled', proposal.id, { state: proposal.state });
    await respond(route, { proposal });
  }

  private async handleActionRoute(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const receiptId = parts[3] ?? '';
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic receipt not found.' });
    if (route.request().method() === 'GET' && parts.length === 4) {
      this.calls.receiptReads.push(receiptId);
      await respond(route, receipt.metadata);
      return;
    }
    if (route.request().method() !== 'POST' || parts.length !== 5 || parts[4] !== 'undo') return route.fallback();
    const body = await readJsonBody(route);
    const idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    this.calls.undoRequests.push({ receiptId, idempotencyKey, body });
    receipt.undoAttempts += 1;
    if (receipt.behavior === 'conflict') {
      receipt.metadata = { ...receipt.metadata, postVersion: 2 };
      await respond(route, { reason: 'changed', originalAction: receipt.metadata }, 409, { code: 'ACTION_UNDO_CONFLICT', message: 'Synthetic target changed.' });
      return;
    }
    if (receipt.behavior === 'response-lost-once' && receipt.undoAttempts === 1) {
      await respond(route, null, 503, { code: 'PREVIEW_TEMPORARY_ERROR', message: 'Synthetic response was lost before confirmation.' });
      return;
    }
    receipt.metadata = { ...receipt.metadata, undoStatus: 'undone', undoActionId: 'b3200000-0000-4000-8000-000000000090' };
    const task = this.tasks.get(receipt.metadata.targetId) ?? null;
    await respond(route, {
      originalAction: receipt.metadata,
      undoReceipt: { ...receipt.metadata, actionKind: 'undo', undoStatus: 'not_reversible', undoActionId: null },
      target: task ? { kind: 'task', item: { task, collection: 'inbox', workspace: null } } : null,
      replayed: false
    });
  }

  private async handleTaskRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method() !== 'GET' || parts.length !== 4 || parts[3] === 'inbox') return route.fallback();
    const taskId = decodeURIComponent(parts[3] ?? '');
    const task = this.tasks.get(taskId);
    if (!task) return respond(route, null, 404, { code: 'PREVIEW_NOT_FOUND', message: 'Synthetic task target not found.' });
    this.calls.targetReads.push(taskId);
    await respond(route, { task, collection: 'inbox', workspace: null });
  }

  private async handleProjectRoute(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    if (route.request().method() !== 'GET' || parts.length !== 4) return route.fallback();
    const projectId = decodeURIComponent(parts[3] ?? '');
    if (projectId !== ACTIVE_WORKSPACE_ID && projectId !== ARCHIVED_WORKSPACE_ID) return route.fallback();
    this.calls.targetReads.push(projectId);
    const project = projectId === ACTIVE_WORKSPACE_ID ? SYNTHETIC_ACTIVE_WORKSPACE : SYNTHETIC_ARCHIVED_WORKSPACE;
    await respond(route, project);
  }

  private seedTask(id: string, title: string): void {
    this.tasks.set(id, {
      id,
      projectId: null,
      title,
      details: null,
      importance: 'medium',
      deadline: null,
      subtasks: [],
      status: 'todo',
      position: 0,
      version: 1,
      source: { kind: 'user', label: 'Created by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: SYNTHETIC_SUMMARY_TIME,
      updatedAt: SYNTHETIC_SUMMARY_TIME,
      completedAt: null,
      archivedAt: null
    });
  }

  private seedReceipt(id: string, targetId: string, behavior: SyntheticUndoBehavior): void {
    this.receipts.set(id, receiptRecord(id, targetId, behavior));
  }

  private appendEvent(type: string, entityId: string, payload: SyntheticHomeEvent['payload']): void {
    this.events.push({ sequence: this.lastSequence() + 1, type, turnId: HOME_SUMMARY_TURN_ID, entityId, payload, createdAt: SYNTHETIC_SUMMARY_TIME });
  }

  private lastSequence(): number {
    return Math.max(0, ...this.events.map((event) => event.sequence));
  }
}

export function startPreviewBrowserEvidence(page: Page): void {
  const evidence: PreviewBrowserEvidence = { requests: [], responses: [], failedRequests: [], consoleErrors: [], pageErrors: [], metadata: {} };
  evidenceByPage.set(page, evidence);
  page.on('request', (request) => evidence.requests.push({ method: request.method(), url: request.url(), body: safeRequestBody(request.postData()) }));
  page.on('response', (response) => evidence.responses.push({ method: response.request().method(), url: response.url(), status: response.status() }));
  page.on('requestfailed', (request) => evidence.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
}

export function setPreviewBrowserEvidenceMetadata(page: Page, key: string, value: unknown): void {
  const evidence = evidenceByPage.get(page);
  if (evidence) evidence.metadata[key] = value;
}

export async function savePreviewBrowserEvidence(
  page: Page,
  fixture: HomeSummariesPreviewApi,
  title: string,
  testInfo: TestInfo,
  planningFixture?: HomePlanningRecordsPreviewApi,
  blockedExternalRequests: readonly string[] = []
): Promise<void> {
  const evidence = evidenceByPage.get(page);
  if (!evidence) return;
  const directory = process.env.PAI_HOME_SUMMARY_ARTIFACT_DIR
    ? resolve(process.env.PAI_HOME_SUMMARY_ARTIFACT_DIR)
    : dirname(testInfo.outputPath('evidence'));
  await mkdir(directory, { recursive: true });
  const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '')}-browser-evidence.json`;
  await writeFile(join(directory, filename), JSON.stringify({
    syntheticApi: true,
    calls: fixture.getCalls(),
    planningCardCalls: planningFixture?.getCalls() ?? null,
    blockedExternalRequests,
    ...evidence
  }, null, 2), 'utf8');
}

function makeDraftProposal(): SyntheticProposal {
  return makeProposal(DRAFT_PROPOSAL_ID, [
    makeProposalItem(DRAFT_ITEM_ONE_ID, 0, 'Prepare release checklist', 'b3200000-0000-4000-8000-000000000042'),
    makeProposalItem(DRAFT_ITEM_TWO_ID, 1, 'Confirm reviewer availability', 'b3200000-0000-4000-8000-000000000043'),
    makeTaskUpdateProposalItem(PARTIAL_UPDATE_ITEM_ID, 2, PARTIAL_UPDATE_TASK_ID, { title: 'Task with a partial update' }),
    makeTaskUpdateProposalItem(STATUS_ONLY_UPDATE_ITEM_ID, 3, STATUS_ONLY_UPDATE_TASK_ID, { status: 'todo' })
  ]);
}

function makeAcceptProposal(): SyntheticProposal {
  return makeProposal(ACCEPT_PROPOSAL_ID, [
    makeProposalItem(ACCEPT_ITEM_ONE_ID, 0, 'Prepare release checklist', ACCEPT_TASK_ONE_ID, {
      date: '2026-11-12',
      timeZone: 'America/Los_Angeles',
      source: 'configured'
    }),
    makeProposalItem(ACCEPT_ITEM_TWO_ID, 1, 'Verify release handoff', ACCEPT_TASK_TWO_ID),
    makeProposalItem(ACCEPT_ITEM_THREE_ID, 2, 'Confirm the rollout window', ACCEPT_TASK_THREE_ID)
  ]);
}

function makeProposal(id: string, items: SyntheticProposalItem[]): SyntheticProposal {
  return {
    id,
    sourceTurnId: HOME_SUMMARY_TURN_ID,
    scope: { kind: 'home' },
    state: 'review_required',
    revision: 1,
    acceptedRevision: null,
    acceptanceId: null,
    itemCount: items.length,
    createdAt: SYNTHETIC_SUMMARY_TIME,
    updatedAt: SYNTHETIC_SUMMARY_TIME,
    items
  };
}

function makeProposalItem(
  id: string,
  position: number,
  title: string,
  taskId: string,
  deadline?: { readonly date: string; readonly timeZone: string; readonly source: 'configured' | 'utc-fallback' }
): SyntheticProposalItem {
  return {
    id,
    position,
    action: 'task.create',
    command: { action: 'task.create', taskId, title, details: null, workspaceId: null, importance: 'medium', deadline: deadline?.date ?? null, subtasks: [] },
    deadlineResolution: deadline ? { timeZone: deadline.timeZone, source: deadline.source } : null,
    state: 'ready',
    receiptId: null,
    resultCode: null
  };
}

function makeTaskUpdateProposalItem(id: string, position: number, taskId: string, commandFields: Readonly<Record<string, unknown>>): SyntheticProposalItem {
  return {
    id,
    position,
    action: 'task.update',
    command: { action: 'task.update', taskId, expectedVersion: 1, ...commandFields },
    deadlineResolution: null,
    state: 'ready',
    receiptId: null,
    resultCode: null
  };
}

function receiptRecord(id: string, targetId: string, behavior: SyntheticUndoBehavior): SyntheticReceiptRecord {
  return {
    metadata: { id, actionKind: 'task.create', targetKind: 'task', targetId, postVersion: 1, undoStatus: 'available', undoActionId: null },
    behavior,
    undoAttempts: 0
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function safeRequestBody(body: string | null): string | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body);
    const record = asRecord(value);
    if (record && typeof record.password === 'string') return JSON.stringify({ ...record, password: '[redacted]' });
  } catch {
    return body;
  }
  return body;
}

async function readJsonBody(route: Route): Promise<unknown> {
  try {
    return await route.request().postDataJSON();
  } catch {
    return {};
  }
}

async function respond(
  route: Route,
  data: unknown,
  status = 200,
  error: { readonly code: string; readonly message: string } | null = null
): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
}
