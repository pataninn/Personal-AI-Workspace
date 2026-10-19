import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { SESSION_COOKIE_NAME } from '@/modules/auth/controllers/request-auth';
import type { SessionRecord } from '@/modules/auth/domain/auth-types';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { IClock, IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import type { AssistantScopePolicy } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import { createAssistantExecutionPolicyRouter } from '@/modules/assistant-policy/controllers/assistant-execution-policy-router';
import { GetAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/get-assistant-execution-policy';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectDomainError } from '@/modules/projects/domain/project-errors';
import { AppError } from '@/shared/errors/app-error';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';
const TOKEN_A = 'owner-a-policy-session-token-with-more-than-32-chars';
const TOKEN_B = 'owner-b-policy-session-token-with-more-than-32-chars';
const NOW = new Date('2026-10-19T00:00:00.000Z');

describe('assistant execution policy route', () => {
  it('derives scope ownership from the authenticated session and returns safe unavailable readiness', async () => {
    const { app, findPolicy, findProject, authorize } = buildApp();
    const home = await request(app).get('/api/v1/assistant/execution-policy?scope=home').set('Cookie', cookie(TOKEN_A));
    const workspace = await request(app).get(`/api/v1/assistant/execution-policy?scope=workspace&projectId=${PROJECT_A}`)
      .set('Cookie', cookie(TOKEN_B));

    expect(home.status).toBe(200);
    expect(home.body.data).toMatchObject({
      scope: { kind: 'home', label: 'Home' },
      policy: { enabled: true, provider: { name: 'NVIDIA hosted NIM' } },
      readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' }
    });
    expect(workspace.status).toBe(200);
    expect(findPolicy).toHaveBeenNthCalledWith(1, { ownerId: OWNER_A, scopeKind: 'home', projectId: null });
    expect(findProject).toHaveBeenCalledWith(OWNER_B, PROJECT_A);
    expect(findPolicy).toHaveBeenNthCalledWith(2, { ownerId: OWNER_B, scopeKind: 'project', projectId: PROJECT_A });
    expect(authorize).toHaveBeenNthCalledWith(1, OWNER_A);
    expect(authorize).toHaveBeenNthCalledWith(2, OWNER_B);
    expect(JSON.stringify(workspace.body)).not.toContain(OWNER_B);
    expect(JSON.stringify(workspace.body)).not.toContain(PROJECT_A);
  });

  it('rejects extra, repeated, or incompatible scope parameters before reading policy', async () => {
    const { app, findPolicy } = buildApp();
    for (const path of [
      `/api/v1/assistant/execution-policy?scope=home&projectId=${PROJECT_A}`,
      '/api/v1/assistant/execution-policy?scope=workspace',
      `/api/v1/assistant/execution-policy?scope=workspace&projectId=${PROJECT_A}&ownerId=${OWNER_B}`,
      `/api/v1/assistant/execution-policy?scope=workspace&scope=home&projectId=${PROJECT_A}`
    ]) {
      const response = await request(app).get(path).set('Cookie', cookie(TOKEN_A));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(findPolicy).not.toHaveBeenCalled();
  });

  it('requires an authenticated session but no Origin or CSRF token for a read', async () => {
    const { app, findPolicy, clearSessionCookie } = buildApp();
    const unauthenticated = await request(app).get('/api/v1/assistant/execution-policy?scope=home');
    expect(unauthenticated.status).toBe(401);
    expect(findPolicy).not.toHaveBeenCalled();
    expect(clearSessionCookie).toHaveBeenCalledTimes(1);

    const authenticated = await request(app).get('/api/v1/assistant/execution-policy?scope=home').set('Cookie', cookie(TOKEN_A));
    expect(authenticated.status).toBe(200);
  });
});

function buildApp() {
  const sessionRepository: ISessionRepository = {
    create: async () => { throw new Error('Session writes are outside this read-route test.'); },
    findByTokenHash: async (tokenHash) => {
      const ownerId = tokenHash === `digest:${TOKEN_A}` ? OWNER_A : tokenHash === `digest:${TOKEN_B}` ? OWNER_B : null;
      return ownerId ? session(ownerId) : null;
    },
    revoke: async () => { throw new Error('Session writes are outside this read-route test.'); }
  };
  const tokens: IOpaqueTokenProvider = {
    createToken: () => 'unused',
    digestToken: (token) => `digest:${token}`,
    createCsrfToken: (token) => `csrf:${token}`
  };
  const clock: IClock = { now: () => NOW };
  const getSession = new GetSessionUseCase(sessionRepository, tokens, clock);
  const policy = jest.fn(async (scope: { ownerId: string; scopeKind: 'home' | 'project'; projectId: string | null }) =>
    policyRow({ ownerId: scope.ownerId, scopeKind: scope.scopeKind, projectId: scope.projectId,
      policyProfile: scope.scopeKind === 'home' ? 'home_in_scope_v1' : 'workspace_in_scope_v1' }));
  const policies: IAssistantScopePolicyRepository = {
    find: policy,
    synchronizeProviderConfiguration: async () => undefined,
    fillConfiguredProvider: async () => null,
    revoke: async () => null
  };
  const findProject = jest.fn(async (ownerId: string, projectId: string) => ownerId === OWNER_B && projectId === PROJECT_A ? projectRow() : null);
  const projects = { findByIdForOwner: findProject } as unknown as Pick<IProjectRepository, 'findByIdForOwner'>;
  const authorize = jest.fn(async () => undefined);
  const principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'> = { assertActive: authorize };
  const getExecutionPolicy = new GetAssistantExecutionPolicyUseCase(policies, projects, principalAuthorization);
  const clearSessionCookie = jest.fn();
  const app = express();
  app.use(cookieParser());
  app.use('/api/v1', createAssistantExecutionPolicyRouter({ getExecutionPolicy, getSession, clearSessionCookie }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof UnauthenticatedError) {
      response.status(401).json({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: error.message } });
      return;
    }
    if (error instanceof ProjectDomainError || error instanceof AppError) {
      response.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
  });
  return { app, findPolicy: policy, findProject, authorize, clearSessionCookie };
}

function session(ownerId: string): SessionRecord {
  return {
    id: `session-${ownerId}`, userId: ownerId, displayName: 'Test user', accountKind: 'regular', role: 'user',
    accountExpiresAt: null, expiresAt: new Date('2027-01-01T00:00:00.000Z'), revokedAt: null
  };
}

function cookie(token: string): string { return `${SESSION_COOKIE_NAME}=${token}`; }

function policyRow(overrides: Partial<AssistantScopePolicy> = {}): AssistantScopePolicy {
  return {
    id: 'policy-id', ownerId: OWNER_A, scopeKind: 'home', projectId: null, policyProfile: 'home_in_scope_v1',
    providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b', enabled: true, revokedAt: null,
    revision: '2', createdAt: NOW, updatedAt: NOW, ...overrides
  };
}

function projectRow(): Project {
  return {
    id: PROJECT_A, ownerId: OWNER_B, name: 'Owner B workspace', slug: 'owner-b-workspace',
    relativeRoot: null, storageKind: null, objective: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW
  };
}
