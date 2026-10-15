import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { clearSessionCookie } from '@/modules/auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { IProjectFactRepository, CreateProjectFactRecord, UpdateProjectFactRecord, ProjectFactVersionRecord } from '@/modules/memory/repositories/project-fact-repository';
import { CreateProjectFactUseCase } from '@/modules/memory/use-cases/create-project-fact';
import { DeleteProjectFactUseCase } from '@/modules/memory/use-cases/delete-project-fact';
import { ListProjectFactsUseCase } from '@/modules/memory/use-cases/list-project-facts';
import { ReviewProjectFactUseCase } from '@/modules/memory/use-cases/review-project-fact';
import { UpdateProjectFactUseCase } from '@/modules/memory/use-cases/update-project-fact';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const FACT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-26T00:00:00.000Z');

class ProjectFixture implements IProjectRepository {
  public status: Project['status'] = 'active';

  public async listByOwner(): Promise<readonly Project[]> { return []; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    return ownerId === OWNER_ID && projectId === PROJECT_ID ? this.project() : null;
  }
  public async listActiveRoots(): Promise<readonly string[]> { return []; }
  public async create(): Promise<never> { throw new Error('Not used by project fact integration tests.'); }
  public async updateStatus(): Promise<never> { throw new Error('Not used by project fact integration tests.'); }

  private project(): Project {
    return { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', objective: null, status: this.status, version: 1, createdAt: NOW, updatedAt: NOW };
  }
}

class ProjectFactFixture implements IProjectFactRepository {
  public readonly records = new Map<string, ProjectFact>();
  private readonly deleted = new Set<string>();

  public async listActiveByProject(ownerId: string, projectId: string): Promise<readonly ProjectFact[]> {
    return [...this.records.values()].filter((fact) => fact.ownerId === ownerId && fact.projectId === projectId && !this.deleted.has(fact.id));
  }
  public async findActiveById(ownerId: string, projectId: string, factId: string): Promise<ProjectFact | null> {
    const fact = this.records.get(factId);
    return fact && fact.ownerId === ownerId && fact.projectId === projectId && !this.deleted.has(fact.id) ? fact : null;
  }
  public async findActiveByIds(ownerId: string, projectId: string, factIds: readonly string[]): Promise<readonly ProjectFact[]> {
    const found = await Promise.all(factIds.map((factId) => this.findActiveById(ownerId, projectId, factId)));
    return found.filter((fact): fact is ProjectFact => fact !== null);
  }
  public async create(input: CreateProjectFactRecord): Promise<ProjectFact> {
    const fact = this.makeFact({ ...input, id: FACT_ID, version: 1, verifiedAt: null, createdAt: NOW, updatedAt: NOW });
    this.records.set(fact.id, fact);
    return fact;
  }
  public async update(input: UpdateProjectFactRecord): Promise<ProjectFact | null> {
    const current = await this.findActiveById(input.ownerId, input.projectId, input.factId);
    if (!current || current.version !== input.expectedVersion) { return null; }
    const updated = this.makeFact({ ...input, id: current.id, version: current.version + 1, verifiedAt: null, createdAt: current.createdAt, updatedAt: new Date(NOW.getTime() + 1) });
    this.records.set(updated.id, updated);
    return updated;
  }
  public async verify(input: ProjectFactVersionRecord): Promise<ProjectFact | null> {
    const current = await this.findActiveById(input.ownerId, input.projectId, input.factId);
    if (!current || current.version !== input.expectedVersion) { return null; }
    const updated = { ...current, version: current.version + 1, verifiedAt: new Date(NOW.getTime() + 2), verificationStatus: 'verified' as const, updatedAt: new Date(NOW.getTime() + 2) };
    this.records.set(updated.id, updated);
    return updated;
  }
  public async softDelete(input: ProjectFactVersionRecord): Promise<boolean> {
    const current = await this.findActiveById(input.ownerId, input.projectId, input.factId);
    if (!current || current.version !== input.expectedVersion) { return false; }
    this.deleted.add(current.id);
    this.records.set(current.id, { ...current, version: current.version + 1, updatedAt: new Date(NOW.getTime() + 3) });
    return true;
  }

  private makeFact(input: { readonly id: string; readonly ownerId: string; readonly projectId: string; readonly key: string; readonly title: string; readonly content: string; readonly version: number; readonly verifiedAt: Date | null; readonly createdAt: Date; readonly updatedAt: Date }): ProjectFact {
    return { ...input, source: { kind: 'user', label: 'Added by you', reference: null }, verificationStatus: input.verifiedAt ? 'verified' : 'needs_review' };
  }
}

function buildApp(projects: ProjectFixture, facts: ProjectFactFixture): express.Express {
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = { execute: jest.fn().mockResolvedValue({ sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) }) } as unknown as GetSessionUseCase;
  return createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    projectFacts: {
      getSession,
      listFacts: new ListProjectFactsUseCase(projects, facts),
      createFact: new CreateProjectFactUseCase(projects, facts),
      updateFact: new UpdateProjectFactUseCase(projects, facts),
      reviewFact: new ReviewProjectFactUseCase(projects, facts),
      deleteFact: new DeleteProjectFactUseCase(projects, facts),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    }
  });
}

const mutationHeaders = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test-session', 'X-CSRF-Token': 'csrf-token' };

describe('project facts API (integration)', () => {
  it('creates, verifies, edits, and removes facts with server-owned attribution and optimistic versions', async () => {
    const projects = new ProjectFixture();
    const facts = new ProjectFactFixture();
    const app = buildApp(projects, facts);
    const path = `/api/v1/projects/${PROJECT_ID}/facts`;

    const created = await request(app).post(path).set(mutationHeaders).send({ title: 'Preferred language', content: 'Use TypeScript.' }).expect(201);
    expect(created.body.data.fact).toMatchObject({ source: { kind: 'user', label: 'Added by you', reference: null }, version: 1, verifiedAt: null, verificationStatus: 'needs_review' });
    expect(created.headers.location).toContain(created.body.data.fact.id);

    const reviewed = await request(app).post(`${path}/${FACT_ID}/verification`).set(mutationHeaders).send({ expectedVersion: 1 }).expect(200);
    expect(reviewed.body.data.fact).toMatchObject({ version: 2, verificationStatus: 'verified' });

    const edited = await request(app).patch(`${path}/${FACT_ID}`).set(mutationHeaders).send({ title: 'Preferred language', content: 'Keep TypeScript.', expectedVersion: 2 }).expect(200);
    expect(edited.body.data.fact).toMatchObject({ version: 3, verifiedAt: null, verificationStatus: 'needs_review' });

    await request(app).delete(`${path}/${FACT_ID}`).set(mutationHeaders).expect(400);
    await request(app).delete(`${path}/${FACT_ID}`).set({ ...mutationHeaders, 'If-Match': '"2"' }).expect(409);
    await request(app).delete(`${path}/${FACT_ID}`).set({ ...mutationHeaders, 'If-Match': '"3"' }).expect(204);
    const listed = await request(app).get(path).set('Cookie', '__Host-pa_session=test-session').expect(200);
    expect(listed.body.data.facts).toEqual([]);
    expect(facts.records.has(FACT_ID)).toBe(true);
  });

  it('rejects client-supplied attribution, foreign projects, stale versions, and archived mutations', async () => {
    const projects = new ProjectFixture();
    const facts = new ProjectFactFixture();
    const app = buildApp(projects, facts);
    const path = `/api/v1/projects/${PROJECT_ID}/facts`;

    await request(app).post(path).set(mutationHeaders).send({ title: 'Fact', content: 'Value', source: { kind: 'assistant' } }).expect(400);
    await request(app).get(`/api/v1/projects/${OTHER_PROJECT_ID}/facts`).set('Cookie', '__Host-pa_session=test-session').expect(404);

    await request(app).post(path).set(mutationHeaders).send({ title: 'Fact', content: 'Value' }).expect(201);
    await request(app).patch(`${path}/55555555-5555-4555-8555-555555555555`).set(mutationHeaders).send({ title: 'Fact', content: 'Foreign fact', expectedVersion: 1 }).expect(404);
    await request(app).patch(`${path}/${FACT_ID}`).set(mutationHeaders).send({ title: 'Fact', content: 'New value', expectedVersion: 99 }).expect(409);
    projects.status = 'archived';
    await request(app).post(path).set(mutationHeaders).send({ title: 'Archived', content: 'Read only' }).expect(409);
    await request(app).get(path).set('Cookie', '__Host-pa_session=test-session').expect(200);
  });

  it('requires same-origin and CSRF protection for mutations', async () => {
    const app = buildApp(new ProjectFixture(), new ProjectFactFixture());
    const path = `/api/v1/projects/${PROJECT_ID}/facts`;

    await request(app).post(path).set({ ...mutationHeaders, Origin: 'https://attacker.example' }).send({ title: 'Fact', content: 'Value' }).expect(403);
    await request(app).post(path).set({ Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test-session' }).send({ title: 'Fact', content: 'Value' }).expect(403);
  });
});
