import type { Page, Route } from '@playwright/test';
import { SYNTHETIC_TIME, type HomeChatFixtureCalls, type HomeChatFixtureOptions, type SyntheticConversation, type SyntheticEvent, type SyntheticMessage, type SyntheticScope, type SyntheticTurn, type SyntheticTurnStatus } from './home-chat-preview-data';

const CONVERSATIONS_PATH = '/api/v1/home/conversations';
const CREATED_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000001';
const TURN_ID = 'c3100000-0000-4000-8000-000000000002';
const MESSAGE_ID = 'c3100000-0000-4000-8000-000000000003';
const INITIAL_DISCLOSURE_ID = 'c3100000-0000-4000-8000-000000000004';
const DYNAMIC_DISCLOSURE_ID = 'c3100000-0000-4000-8000-000000000005';

export class HomeChatPreviewApi {
  readonly calls: HomeChatFixtureCalls = {
    listQueries: [],
    createRequests: [],
    submitRequests: [],
    consentDecisions: [],
    eventCursors: [],
    cancellationRequests: 0,
    turnStatusReads: 0
  };

  readonly blockedExternalRequests: string[] = [];
  private conversations: SyntheticConversation[];
  private messages: SyntheticMessage[];
  private turns: SyntheticTurn[];
  private events: SyntheticEvent[];
  private failEventReads: number;
  private failTurnSubmissions: number;
  private turnReadStatuses: SyntheticTurnStatus[];
  private pendingDisclosure: { readonly id: string; readonly phase: 'initial' | 'tool_result' } | null = null;

  constructor(private readonly page: Page, private readonly options: HomeChatFixtureOptions = {}) {
    this.conversations = [...(options.conversations ?? [])];
    this.messages = [...(options.messages ?? [])];
    this.turns = [...(options.turns ?? [])];
    this.events = [...(options.events ?? [])];
    this.failEventReads = options.failEventReads ?? 0;
    this.failTurnSubmissions = options.failTurnSubmissions ?? 0;
    this.turnReadStatuses = [...(options.turnReadStatuses ?? [])];
  }

  async install(): Promise<void> {
    await this.page.route('**/*', async (route) => this.blockProviderOrBridge(route));
    await this.page.route('**/api/v1/home/conversations**', async (route) => this.handleHomeApi(route));
  }

  getConversationId(): string | null {
    return this.conversations[0]?.id ?? null;
  }

  getBlockedExternalRequests(): readonly string[] {
    return this.blockedExternalRequests;
  }

  private async blockProviderOrBridge(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const host = url.hostname.toLowerCase();
    const isProvider = host.includes('nvidia') || host.includes('nebius');
    const isBridge = url.port === '17871';
    if (isProvider || isBridge) {
      this.blockedExternalRequests.push(url.toString());
      await route.abort();
      return;
    }
    await route.fallback();
  }

  private async handleHomeApi(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const suffix = url.pathname.slice(CONVERSATIONS_PATH.length);
    const segments = suffix.split('/').filter(Boolean).map(decodeURIComponent);

    if (segments.length === 0 && method === 'GET') return this.listConversations(route, url);
    if (segments.length === 0 && method === 'POST') return this.createConversation(route);
    if (segments.length === 1 && method === 'GET') return this.getConversation(route, segments[0] ?? '');
    if (segments.length === 2 && segments[1] === 'messages' && method === 'GET') return this.listMessages(route);
    if (segments.length === 2 && segments[1] === 'turns' && method === 'GET') return this.listTurns(route);
    if (segments.length === 2 && segments[1] === 'events' && method === 'GET') return this.listEvents(route, url);
    if (segments.length === 2 && segments[1] === 'turns' && method === 'POST') return this.submitTurn(route);
    if (segments.length === 3 && segments[1] === 'turns' && method === 'GET') return this.getTurn(route);
    if (segments.length === 4 && segments[1] === 'turns' && segments[3] === 'consent-decisions' && method === 'POST') return this.decideConsent(route);
    if (segments.length === 4 && segments[1] === 'turns' && segments[3] === 'cancellation' && method === 'POST') return this.cancelTurn(route);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'PREVIEW_HOME_ROUTE_NOT_FOUND', message: 'Synthetic Home route not found.' } }) });
  }

  private async listConversations(route: Route, url: URL): Promise<void> {
    this.calls.listQueries.push({ scope: url.searchParams.get('scope'), workspaceId: url.searchParams.get('workspaceId') });
    const requestedScope = url.searchParams.get('scope');
    const workspaceId = url.searchParams.get('workspaceId');
    const conversations = this.conversations.filter((item) => item.scope.kind === requestedScope && (requestedScope !== 'workspace' || (item.scope.kind === 'workspace' && item.scope.workspaceId === workspaceId)));
    await this.respond(route, { conversations, nextCursor: null });
  }

  private async createConversation(route: Route): Promise<void> {
    const body = await this.readBody(route);
    const idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    this.calls.createRequests.push({ body, idempotencyKey });
    const scope = isSyntheticScope(body.scope) ? body.scope : { kind: 'home' as const };
    const title = typeof body.title === 'string' ? body.title : 'New Home conversation';
    const conversation = this.makeConversation(CREATED_CONVERSATION_ID, scope, title);
    this.conversations = [conversation, ...this.conversations.filter((item) => item.id !== conversation.id)];
    await this.respond(route, { ...conversation, replayed: false }, 201);
  }

  private async getConversation(route: Route, id: string): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return this.notFound(route);
    await this.respond(route, { ...conversation, lastEventSequence: this.lastEventSequence() });
  }

  private async listMessages(route: Route): Promise<void> {
    await this.respond(route, { messages: this.messages, nextBeforeSequence: null });
  }

  private async listTurns(route: Route): Promise<void> {
    await this.respond(route, { turns: this.turns, nextAfterSequence: null });
  }

  private async listEvents(route: Route, url: URL): Promise<void> {
    const cursor = Number(url.searchParams.get('afterSequence') ?? '0');
    this.calls.eventCursors.push(cursor);
    if (this.failEventReads > 0) {
      this.failEventReads -= 1;
      await this.respond(route, null, 503, { code: 'PREVIEW_TEMPORARY_ERROR', message: 'Synthetic event feed interruption.' });
      return;
    }
    await this.respond(route, {
      events: this.events.filter((event) => event.sequence > cursor),
      nextAfterSequence: null,
      lastEventSequence: this.lastEventSequence()
    });
  }

  private async submitTurn(route: Route): Promise<void> {
    const body = await this.readBody(route);
    const idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    this.calls.submitRequests.push({ body, idempotencyKey });
    if (this.failTurnSubmissions > 0) {
      this.failTurnSubmissions -= 1;
      await this.respond(route, null, 503, { code: 'PREVIEW_TEMPORARY_ERROR', message: 'Synthetic turn response was lost.' });
      return;
    }
    const conversation = this.conversations[0];
    if (!conversation) return this.notFound(route);
    const messageText = typeof body.message === 'string' ? body.message : '';
    const sequence = Math.max(0, ...this.turns.map((turn) => turn.sequence)) + 1;
    const turn = this.makeTurn(conversation.id, sequence, 'pending');
    const message: SyntheticMessage = { id: MESSAGE_ID, turnId: turn.id, sequence: this.messages.length + 1, role: 'user', content: messageText, createdAt: SYNTHETIC_TIME };
    this.turns = [...this.turns, turn];
    this.messages = [...this.messages, message];
    this.pendingDisclosure = { id: INITIAL_DISCLOSURE_ID, phase: 'initial' };
    this.appendEvent('turn.created', turn.id, null, { status: 'pending' });
    this.appendEvent('consent.requested', turn.id, this.pendingDisclosure.id, this.consentRequestedPayload('initial'));
    await this.respond(route, {
      turn,
      message,
      execution: { state: 'consent_required', disclosure: this.initialDisclosure(conversation.scope) },
      replayed: false
    }, 201);
  }

  private async decideConsent(route: Route): Promise<void> {
    const body = await this.readBody(route);
    const decision = body.decision === 'allow' ? 'allow' : 'deny';
    const disclosure = this.pendingDisclosure ?? { id: INITIAL_DISCLOSURE_ID, phase: 'initial' as const };
    this.calls.consentDecisions.push({ body, phase: disclosure.phase });
    const turn = this.turns.at(-1);
    if (!turn) return this.notFound(route);
    const status: SyntheticTurnStatus = disclosure.phase === 'initial' && decision === 'deny' ? 'cancelled' : 'running';
    const updatedTurn = { ...turn, status, updatedAt: SYNTHETIC_TIME };
    this.turns = [...this.turns.slice(0, -1), updatedTurn];
    this.appendEvent('consent.decided', turn.id, disclosure.id, { decision });
    this.appendEvent('turn.status_changed', turn.id, null, { status });
    if (disclosure.phase === 'initial' && decision === 'allow' && this.options.dynamicConsentAfterAllow) {
      this.pendingDisclosure = { id: DYNAMIC_DISCLOSURE_ID, phase: 'tool_result' };
      this.appendEvent('consent.requested', turn.id, DYNAMIC_DISCLOSURE_ID, this.consentRequestedPayload('tool_result'));
    } else {
      this.pendingDisclosure = null;
    }
    await this.respond(route, {
      turn: updatedTurn,
      disclosureId: disclosure.id,
      decision,
      execution: { state: status === 'cancelled' ? 'cancelled' : 'running' },
      replayed: false
    });
  }

  private async cancelTurn(route: Route): Promise<void> {
    this.calls.cancellationRequests += 1;
    const current = this.turns.at(-1);
    if (!current) return this.notFound(route);
    const turn = { ...current, status: 'cancel_requested' as const, updatedAt: SYNTHETIC_TIME };
    this.turns = [...this.turns.slice(0, -1), turn];
    this.appendEvent('turn.status_changed', turn.id, null, { status: turn.status });
    await this.respond(route, { turn, replayed: false });
  }

  private async getTurn(route: Route): Promise<void> {
    this.calls.turnStatusReads += 1;
    const current = this.turns.at(-1);
    if (!current) return this.notFound(route);
    const nextStatus = this.turnReadStatuses.shift() ?? current.status;
    const turn = { ...current, status: nextStatus, updatedAt: SYNTHETIC_TIME };
    this.turns = [...this.turns.slice(0, -1), turn];
    this.appendEvent('turn.status_changed', turn.id, null, { status: turn.status });
    await this.respond(route, turn);
  }

  private initialDisclosure(scope: SyntheticScope): Readonly<Record<string, unknown>> {
    return {
      disclosureId: INITIAL_DISCLOSURE_ID,
      phase: 'initial',
      provider: { profile: 'nvidia-hosted-nim', name: 'NVIDIA hosted NIM', model: 'synthetic-planner-1' },
      scope,
      categories: ['current_message'],
      itemCount: 1,
      byteLimit: 65536
    };
  }

  private consentRequestedPayload(phase: 'initial' | 'tool_result'): SyntheticEvent['payload'] {
    const conversation = this.conversations[0];
    const scope = conversation?.scope ?? { kind: 'home' as const };
    const scopeKind = scope.kind;
    const scopeId = scope.kind === 'workspace' ? scope.workspaceId : null;
    const categories = phase === 'initial' ? ['current_message'] : ['task_metadata'];
    return {
      phase,
      categories,
      providerProfile: 'nvidia-hosted-nim',
      model: 'synthetic-planner-1',
      scopeKind,
      scopeId,
      itemCount: phase === 'initial' ? 1 : 2,
      byteLimit: 65536
    };
  }

  private appendEvent(type: string, turnId: string | null, entityId: string | null, payload: SyntheticEvent['payload']): void {
    this.events = [...this.events, { sequence: this.lastEventSequence() + 1, type, turnId, entityId, payload, createdAt: SYNTHETIC_TIME }];
  }

  private makeConversation(id: string, scope: SyntheticScope, title: string): SyntheticConversation {
    return { id, scope, title, lastEventSequence: this.lastEventSequence(), lastActivityAt: SYNTHETIC_TIME, createdAt: SYNTHETIC_TIME, updatedAt: SYNTHETIC_TIME };
  }

  private makeTurn(conversationId: string, sequence: number, status: SyntheticTurnStatus): SyntheticTurn {
    return { id: TURN_ID, conversationId, sequence, status, createdAt: SYNTHETIC_TIME, updatedAt: SYNTHETIC_TIME };
  }

  private lastEventSequence(): number {
    return Math.max(0, ...this.events.map((event) => event.sequence));
  }

  private async readBody(route: Route): Promise<Readonly<Record<string, unknown>>> {
    const value: unknown = await route.request().postDataJSON();
    return isRecord(value) ? value : {};
  }

  private async respond(route: Route, data: unknown, status = 200, error: { readonly code: string; readonly message: string } | null = null): Promise<void> {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, error }) });
  }

  private async notFound(route: Route): Promise<void> {
    await this.respond(route, null, 404, { code: 'PREVIEW_HOME_NOT_FOUND', message: 'Synthetic Home resource not found.' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyntheticScope(value: unknown): value is SyntheticScope {
  if (!isRecord(value)) return false;
  if (value.kind === 'home') return true;
  return value.kind === 'workspace' && typeof value.workspaceId === 'string';
}
