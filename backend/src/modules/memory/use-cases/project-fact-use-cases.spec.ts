import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectFactArchivedProjectError, ProjectFactAlreadyExistsError, ProjectFactNotFoundError, ProjectFactVersionConflictError } from '@/modules/memory/domain/project-fact-errors';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { CreateProjectFactUseCase } from '@/modules/memory/use-cases/create-project-fact';
import { DeleteProjectFactUseCase } from '@/modules/memory/use-cases/delete-project-fact';
import { ListProjectFactsUseCase } from '@/modules/memory/use-cases/list-project-facts';
import { ReviewProjectFactUseCase } from '@/modules/memory/use-cases/review-project-fact';
import { UpdateProjectFactUseCase } from '@/modules/memory/use-cases/update-project-fact';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FACT_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-26T00:00:00.000Z');

function makeProject(status: Project['status'] = 'active'): Project {
  return { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', objective: null, status, version: 1, createdAt: NOW, updatedAt: NOW };
}

function makeFact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    id: FACT_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    key: 'test command',
    title: 'Test command',
    content: 'Run pnpm test.',
    source: { kind: 'user', label: 'Added by you', reference: null },
    version: 1,
    verifiedAt: null,
    verificationStatus: 'needs_review',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function projects(status: Project['status'] = 'active'): jest.Mocked<IProjectRepository> {
  return {
    listByOwner: jest.fn(),
    findByIdForOwner: jest.fn().mockResolvedValue(makeProject(status)),
    listActiveRoots: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn()
  } as unknown as jest.Mocked<IProjectRepository>;
}

function facts(overrides: Partial<IProjectFactRepository> = {}): jest.Mocked<IProjectFactRepository> {
  return {
    listActiveByProject: jest.fn().mockResolvedValue([makeFact()]),
    findActiveById: jest.fn().mockResolvedValue(makeFact()),
    findActiveByIds: jest.fn().mockResolvedValue([makeFact()]),
    create: jest.fn().mockResolvedValue(makeFact()),
    update: jest.fn().mockResolvedValue(makeFact({ version: 2 })),
    verify: jest.fn().mockResolvedValue(makeFact({ version: 2, verifiedAt: NOW, verificationStatus: 'verified' })),
    softDelete: jest.fn().mockResolvedValue(true),
    ...overrides
  } as jest.Mocked<IProjectFactRepository>;
}

describe('project fact use cases', () => {
  it('lists active facts only within the requested owner and project', async () => {
    const repository = facts();
    const useCase = new ListProjectFactsUseCase(projects(), repository);

    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toEqual([makeFact()]);
    expect(repository.listActiveByProject).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
  });

  it('records user source on the server and normalizes the active unique label key', async () => {
    const repository = facts();
    const useCase = new CreateProjectFactUseCase(projects(), repository);

    await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: '  Preferred   Test ', content: ' Run pnpm test. ' });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      title: 'Preferred   Test',
      content: 'Run pnpm test.',
      key: 'preferred test'
    }));
  });

  it('rejects writes to archived projects and credential-like fact content', async () => {
    const repository = facts();
    const archivedUseCase = new CreateProjectFactUseCase(projects('archived'), repository);
    await expect(archivedUseCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Note', content: 'Ordinary text.' }))
      .rejects.toBeInstanceOf(ProjectFactArchivedProjectError);

    const activeUseCase = new CreateProjectFactUseCase(projects(), repository);
    await expect(activeUseCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Key', content: 'NVIDIA_API_KEY=secret-value-123' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('resets verification after an optimistic edit and rejects stale versions', async () => {
    const repository = facts({ update: jest.fn().mockResolvedValue(makeFact({ version: 2, verifiedAt: null, verificationStatus: 'needs_review' })) });
    const useCase = new UpdateProjectFactUseCase(projects(), repository);

    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, title: 'Test command', content: 'Run pnpm test --run.', expectedVersion: 1 }))
      .resolves.toMatchObject({ version: 2, verifiedAt: null, verificationStatus: 'needs_review' });
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1 }));

    const stale = facts({ update: jest.fn().mockResolvedValue(null), findActiveById: jest.fn().mockResolvedValue(makeFact({ version: 2 })) });
    await expect(new UpdateProjectFactUseCase(projects(), stale).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, title: 'Test command', content: 'Run pnpm test.', expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ProjectFactVersionConflictError);
  });

  it('records review only for the current version and soft-deletes from active memory', async () => {
    const repository = facts();
    const review = new ReviewProjectFactUseCase(projects(), repository);
    await expect(review.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 }))
      .resolves.toMatchObject({ version: 2, verificationStatus: 'verified', verifiedAt: NOW });

    await expect(new DeleteProjectFactUseCase(projects(), repository).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 }))
      .resolves.toBeUndefined();
    expect(repository.softDelete).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1 }));

    const missing = facts({ softDelete: jest.fn().mockResolvedValue(false), findActiveById: jest.fn().mockResolvedValue(null) });
    await expect(new DeleteProjectFactUseCase(projects(), missing).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ProjectFactNotFoundError);
  });

  it('maps active duplicate names to a stable conflict error', async () => {
    const repository = facts({ create: jest.fn().mockRejectedValue(new ProjectFactAlreadyExistsError()) });
    await expect(new CreateProjectFactUseCase(projects(), repository).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Test command', content: 'Run pnpm test.' }))
      .rejects.toBeInstanceOf(ProjectFactAlreadyExistsError);
  });
});
