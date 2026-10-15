import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { clearSessionCookie } from '@/modules/auth';
import type { LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { LoginUseCase } from '@/modules/auth/use-cases/login';
import { LogoutUseCase } from '@/modules/auth/use-cases/logout';
import type { IClock, ILoginRateLimiter, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { CreateSessionInput, ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { CreateLocalUserInput, IUserRepository } from '@/modules/auth/repositories/user-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import type { Project, ProjectStatus } from '@/modules/projects/domain/project-types';
import type { CreateProjectRecord, IProjectRepository, UpdateProjectStatusRecord } from '@/modules/projects/repositories/project-repository';
import type { Conversation, ConversationPage, Message, MessagePage, PersistedResource } from '@/modules/conversations/domain/conversation-types';
import { ConversationQueryInvalidError, IdempotencyKeyReusedError } from '@/modules/conversations/domain/conversation-errors';
import type { AddMessageRecord, CreateConversationRecord, FindConversationInput, IConversationRepository, ListConversationsInput } from '@/modules/conversations/repositories/conversation-repository';
import { AddUserMessageUseCase, CreateConversationUseCase, GetConversationUseCase, ListConversationsUseCase } from '@/modules/conversations';
import { createLogger } from '@/shared/logging/logger';

export const APP_ORIGIN = 'https://127.0.0.1:8443';
export const OWNER_ID = 'user-1';
export const OTHER_OWNER_ID = 'user-2';
export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const SECOND_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_OWNER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
export const RAW_TOKEN = 'opaque-token-value-with-valid-length-123456';
export const NOW = new Date('2026-09-12T12:00:00.000Z');

export function makeProject(id: string, ownerId: string, status: ProjectStatus = 'active'): Project {
  return {
    id,
    ownerId,
    name: `Project ${id.slice(0, 4)}`,
    slug: `project-${id.slice(0, 4)}`,
    relativeRoot: `root-${id.slice(0, 4)}`,
    objective: null,
    status,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  };
}

export class ConversationProjectFixture implements IProjectRepository {
  private readonly records = new Map<string, Project>();

  public constructor() {
    this.records.set(PROJECT_ID, makeProject(PROJECT_ID, OWNER_ID));
    this.records.set(SECOND_PROJECT_ID, makeProject(SECOND_PROJECT_ID, OWNER_ID));
    this.records.set(OTHER_OWNER_PROJECT_ID, makeProject(OTHER_OWNER_PROJECT_ID, OTHER_OWNER_ID));
  }

  public archive(projectId: string): void {
    const project = this.records.get(projectId);
    if (project) {
      this.records.set(projectId, { ...project, status: 'archived', version: project.version + 1 });
    }
  }

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && (includeArchived || project.status === 'active'));
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const project = this.records.get(projectId);
    return project?.ownerId === ownerId ? project : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && project.status === 'active').flatMap((project) => project.relativeRoot === null ? [] : [project.relativeRoot]);
  }

  public async create(input: CreateProjectRecord): Promise<Project> {
    const created = { ...makeProject(`44444444-4444-4444-8444-${String(this.records.size).padStart(12, '0')}`, input.ownerId), ...input };
    this.records.set(created.id, created);
    return created;
  }

  public async updateStatus(input: UpdateProjectStatusRecord): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion) {
      return null;
    }
    const updated = { ...current, status: input.status, version: current.version + 1 };
    this.records.set(updated.id, updated);
    return updated;
  }
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly resourceId: string;
}

interface CursorValue {
  readonly lastActivityAt: string;
  readonly id: string;
}

export class ConversationRepositoryFixture implements IConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private nextConversationNumber = 1;
  private nextMessageNumber = 1;

  public seed(conversation: Conversation, messages: readonly Message[] = []): void {
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, [...messages]);
  }

  public async listByProjectForOwner(input: ListConversationsInput): Promise<ConversationPage> {
    const records = [...this.conversations.values()]
      .filter((conversation) => conversation.ownerId === input.ownerId && conversation.projectId === input.projectId)
      .sort(compareConversations);
    const start = input.cursor ? records.findIndex((record) => isAfterCursor(record, decodeCursor(input.cursor as string))) : 0;
    const visible = records.slice(start, start + input.limit + 1);
    const page = visible.slice(0, input.limit);
    return { conversations: page, nextCursor: visible.length > input.limit ? encodeCursor(page[page.length - 1] as Conversation) : null };
  }

  public async findWithMessagesForOwner(input: FindConversationInput): Promise<MessagePage | null> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.ownerId !== input.ownerId || conversation.projectId !== input.projectId) {
      return null;
    }
    const allMessages = [...(this.messages.get(conversation.id) ?? [])].sort((left, right) => left.sequence - right.sequence);
    const beforeSequence = input.beforeSequence;
    const older = beforeSequence === undefined ? allMessages : allMessages.filter((message) => message.sequence < beforeSequence);
    const page = older.slice(Math.max(0, older.length - input.limit));
    const hasMore = older.length > input.limit;
    return { conversation, messages: page, nextBeforeSequence: hasMore ? page[0]?.sequence ?? null : null };
  }

  public async create(input: CreateConversationRecord): Promise<PersistedResource<Conversation>> {
    return this.withLock(`conversation:${input.ownerId}:${input.projectId}:${input.idempotencyKey}`, async () => {
      const key = idempotencyKey(input.ownerId, input.projectId, 'conversation', input.idempotencyKey);
      const previous = this.idempotency.get(key);
      if (previous) {
        if (previous.fingerprint !== input.requestFingerprint) {
          throw new IdempotencyKeyReusedError();
        }
        const replay = this.conversations.get(previous.resourceId);
        if (!replay) {
          throw new Error('Conversation fixture lost an idempotent resource.');
        }
        return { resource: replay, replayed: true };
      }
      const id = `44444444-4444-4444-8444-${String(this.nextConversationNumber++).padStart(12, '0')}`;
      const conversation: Conversation = {
        id,
        ownerId: input.ownerId,
        projectId: input.projectId,
        title: input.title,
        status: 'active',
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      };
      this.conversations.set(id, conversation);
      this.messages.set(id, []);
      this.idempotency.set(key, { fingerprint: input.requestFingerprint, resourceId: id });
      return { resource: conversation, replayed: false };
    });
  }

  public async addUserMessage(input: AddMessageRecord): Promise<PersistedResource<Message>> {
    return this.withLock(`message:${input.ownerId}:${input.projectId}:${input.conversationId}`, async () => {
      const key = idempotencyKey(input.ownerId, input.projectId, 'message', input.idempotencyKey);
      const previous = this.idempotency.get(key);
      if (previous) {
        if (previous.fingerprint !== input.requestFingerprint) {
          throw new IdempotencyKeyReusedError();
        }
        const replay = this.messages.get(input.conversationId)?.find((message) => message.id === previous.resourceId);
        if (!replay) {
          throw new Error('Message fixture lost an idempotent resource.');
        }
        return { resource: replay, replayed: true };
      }
      const conversation = this.conversations.get(input.conversationId);
      if (!conversation || conversation.ownerId !== input.ownerId || conversation.projectId !== input.projectId) {
        throw new Error('Conversation fixture could not resolve the message target.');
      }
      const currentMessages = this.messages.get(conversation.id) ?? [];
      const message: Message = {
        id: `55555555-5555-4555-8555-${String(this.nextMessageNumber++).padStart(12, '0')}`,
        conversationId: conversation.id,
        role: 'user',
        sequence: currentMessages.length + 1,
        content: input.content,
        createdAt: new Date(NOW.getTime() + currentMessages.length + 1)
      };
      this.messages.set(conversation.id, [...currentMessages, message]);
      this.conversations.set(conversation.id, { ...conversation, lastActivityAt: message.createdAt, updatedAt: message.createdAt });
      this.idempotency.set(key, { fingerprint: input.requestFingerprint, resourceId: message.id });
      return { resource: message, replayed: false };
    });
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }
}

function compareConversations(left: Conversation, right: Conversation): number {
  const activity = right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  return activity === 0 ? left.id.localeCompare(right.id) : activity;
}

function isAfterCursor(conversation: Conversation, cursor: CursorValue): boolean {
  const timestamp = conversation.lastActivityAt.toISOString();
  return timestamp < cursor.lastActivityAt || (timestamp === cursor.lastActivityAt && conversation.id > cursor.id);
}

function decodeCursor(value: string): CursorValue {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') {
      throw new Error('invalid cursor');
    }
    const candidate = decoded as { lastActivityAt?: unknown; id?: unknown };
    if (typeof candidate.lastActivityAt !== 'string' || typeof candidate.id !== 'string') {
      throw new Error('invalid cursor');
    }
    return { lastActivityAt: candidate.lastActivityAt, id: candidate.id };
  } catch {
    throw new ConversationQueryInvalidError('cursor', 'The conversation cursor is invalid.');
  }
}

function encodeCursor(conversation: Conversation): string {
  return Buffer.from(JSON.stringify({ lastActivityAt: conversation.lastActivityAt.toISOString(), id: conversation.id })).toString('base64url');
}

function idempotencyKey(ownerId: string, projectId: string, operation: string, key: string): string {
  return `${ownerId}:${projectId}:${operation}:${key}`;
}

class FixedUserRepository implements IUserRepository {
  public async findActiveLocalUser(): Promise<LocalUserRecord> {
    return { id: OWNER_ID, displayName: 'Local user', passwordHash: 'stored-hash', isActive: true };
  }

  public async findActiveLocalUserById(): Promise<LocalUserRecord> {
    return { id: OWNER_ID, displayName: 'Local user', passwordHash: 'stored-hash', isActive: true };
  }

  public async createLocalUser(_input: CreateLocalUserInput): Promise<LocalUserRecord> {
    throw new Error('The conversation integration fixture does not bootstrap users.');
  }
}

class FixedSessionRepository implements ISessionRepository {
  private readonly records = new Map<string, SessionRecord>();

  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> {
    const record: SessionRecord = { id: 'session-1', userId: input.userId, displayName: 'Local user', expiresAt: input.expiresAt, revokedAt: null };
    this.records.set(input.tokenHash, record);
    return { id: record.id, userId: record.userId, expiresAt: record.expiresAt };
  }

  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  public async revoke(sessionId: string): Promise<void> {
    for (const [token, record] of this.records.entries()) {
      if (record.id === sessionId) {
        this.records.set(token, { ...record, revokedAt: NOW });
      }
    }
  }
}

class FixedTokenProvider implements IOpaqueTokenProvider {
  public createToken(): string { return RAW_TOKEN; }
  public digestToken(token: string): string { return `hash:${token}`; }
  public createCsrfToken(token: string): string { return `csrf:${token}`; }
}

class FixedClock implements IClock {
  public now(): Date { return NOW; }
}

class FixedPasswordHasher implements IPasswordHasher {
  public async hash(password: string): Promise<string> { return `hash:${password}`; }
  public async verify(password: string, hash: string): Promise<boolean> { return password === 'correct-password' && hash === 'stored-hash'; }
}

class FixedRateLimiter implements ILoginRateLimiter {
  public consume(): boolean { return true; }
}

export function buildConversationApp(projects: ConversationProjectFixture, conversations: ConversationRepositoryFixture): express.Express {
  const sessions = new FixedSessionRepository();
  const tokenProvider = new FixedTokenProvider();
  const clock = new FixedClock();
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = new GetSessionUseCase(sessions, tokenProvider, clock);
  return createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    auth: {
      login: new LoginUseCase(new FixedUserRepository(), sessions, new FixedPasswordHasher(), tokenProvider, clock, { sessionLifetimeMs: 60_000 }),
      getSession,
      logout: new LogoutUseCase(sessions),
      appOrigin: APP_ORIGIN,
      cookieSecure: true,
      sessionLifetimeMs: 60_000,
      rateLimiter: new FixedRateLimiter()
    },
    conversations: {
      getSession,
      listConversations: new ListConversationsUseCase(projects, conversations),
      createConversation: new CreateConversationUseCase(projects, conversations),
      getConversation: new GetConversationUseCase(projects, conversations),
      addUserMessage: new AddUserMessageUseCase(projects, conversations),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    }
  });
}

export function cookiePair(response: request.Response): string {
  const values = response.headers['set-cookie'];
  const cookies = typeof values === 'string' ? [values] : values ?? [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('__Host-pa_session='));
  if (!sessionCookie) {
    throw new Error('The conversation fixture did not receive a session cookie.');
  }
  return sessionCookie.split(';')[0] ?? sessionCookie;
}

export async function login(app: express.Express): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', APP_ORIGIN)
    .send({ password: 'correct-password' })
    .expect(200);
  return { cookie: cookiePair(response), csrf: response.body.data.csrfToken as string };
}
