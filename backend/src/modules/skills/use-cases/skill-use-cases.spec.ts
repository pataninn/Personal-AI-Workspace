import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { Skill } from '@/modules/skills/domain/skill-types';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import { CreateSkillUseCase } from '@/modules/skills/use-cases/create-skill';
import { DeleteSkillUseCase } from '@/modules/skills/use-cases/delete-skill';
import { ListSkillsUseCase } from '@/modules/skills/use-cases/list-skills';
import { UpdateSkillUseCase } from '@/modules/skills/use-cases/update-skill';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const REVISION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-01T00:00:00.000Z');

function makeProject(status: Project['status'] = 'active'): Project {
  return { id: WORKSPACE_ID, ownerId: OWNER_ID, name: 'Workspace', slug: 'workspace', relativeRoot: null, storageKind: null, objective: null, status, version: 1, createdAt: NOW, updatedAt: NOW };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: SKILL_ID,
    revisionId: REVISION_ID,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    title: 'Plan today',
    instructions: 'Review the tasks and summarize a plan.',
    declaredTools: ['home_task_read'],
    enabled: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function projectRepository(status: Project['status'] = 'active'): jest.Mocked<IProjectRepository> {
  return {
    listByOwner: jest.fn(),
    findByIdForOwner: jest.fn().mockResolvedValue(makeProject(status)),
    listActiveRoots: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn()
  } as unknown as jest.Mocked<IProjectRepository>;
}

function skillRepository(overrides: Partial<ISkillRepository> = {}): jest.Mocked<ISkillRepository> {
  return {
    listActive: jest.fn().mockResolvedValue([makeSkill()]),
    findActiveById: jest.fn().mockResolvedValue(makeSkill()),
    create: jest.fn().mockImplementation(async (record) => ({ skill: makeSkill({ ...record, id: SKILL_ID, revisionId: REVISION_ID, version: 1, createdAt: NOW, updatedAt: NOW }), replayed: false })),
    update: jest.fn().mockResolvedValue(makeSkill({ version: 2 })),
    softDelete: jest.fn().mockResolvedValue(makeSkill()),
    ...overrides
  } as jest.Mocked<ISkillRepository>;
}

describe('skill use cases', () => {
  it('creates a private custom skill with an owner-scoped idempotency digest', async () => {
    const repository = skillRepository();
    const useCase = new CreateSkillUseCase(projectRepository(), repository);

    await expect(useCase.execute({
      ownerId: OWNER_ID,
      idempotencyKey: 'create-skill-01',
      workspaceId: WORKSPACE_ID,
      title: ' Plan today ',
      instructions: ' Read and prioritize tasks. ',
      declaredTools: ['home_task_read']
    })).resolves.toMatchObject({ skill: { ownerId: OWNER_ID, version: 1 }, replayed: false });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Plan today',
      instructions: 'Read and prioritize tasks.',
      idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    }));
  });

  it('copies only the fixed starter template content and rejects unavailable workspaces', async () => {
    const repository = skillRepository();
    const useCase = new CreateSkillUseCase(projectRepository(), repository);
    await useCase.execute({ ownerId: OWNER_ID, idempotencyKey: 'template-key-01', templateId: 'daily-briefing' });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Daily briefing',
      enabled: true,
      declaredTools: ['home_task_read']
    }));

    const unavailableProjects = projectRepository('archived');
    await expect(new CreateSkillUseCase(unavailableProjects, repository).execute({
      ownerId: OWNER_ID,
      idempotencyKey: 'template-key-02',
      templateId: 'daily-briefing',
      workspaceId: WORKSPACE_ID
    })).rejects.toMatchObject({ code: 'SKILL_WORKSPACE_NOT_FOUND' });
  });

  it('lists only the requested owner and workspace through the repository port', async () => {
    const repository = skillRepository();
    await expect(new ListSkillsUseCase(repository).execute({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID })).resolves.toEqual([makeSkill()]);
    expect(repository.listActive).toHaveBeenCalledWith(OWNER_ID, WORKSPACE_ID);
  });

  it('applies a partial update against the current revision and rejects stale writes', async () => {
    const repository = skillRepository({ update: jest.fn().mockResolvedValue(makeSkill({ title: 'New title', version: 2 })) });
    const useCase = new UpdateSkillUseCase(projectRepository(), repository);
    await expect(useCase.execute({ ownerId: OWNER_ID, skillId: SKILL_ID, expectedVersion: 1, title: 'New title' }))
      .resolves.toMatchObject({ title: 'New title', version: 2 });
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER_ID,
      skillId: SKILL_ID,
      expectedVersion: 1,
      instructions: 'Review the tasks and summarize a plan.',
      declaredTools: ['home_task_read'],
      enabled: true
    }));

    const stale = skillRepository({ findActiveById: jest.fn().mockResolvedValue(makeSkill({ version: 2 })) });
    await expect(new UpdateSkillUseCase(projectRepository(), stale).execute({ ownerId: OWNER_ID, skillId: SKILL_ID, expectedVersion: 1, title: 'Stale' }))
      .rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT' });
  });

  it('soft deletes with the expected version and distinguishes a conflict from a missing skill', async () => {
    const repository = skillRepository();
    await expect(new DeleteSkillUseCase(repository).execute({ ownerId: OWNER_ID, skillId: SKILL_ID, expectedVersion: 1 })).resolves.toBeUndefined();
    expect(repository.softDelete).toHaveBeenCalledWith({ ownerId: OWNER_ID, skillId: SKILL_ID, expectedVersion: 1 });

    const missing = skillRepository({ softDelete: jest.fn().mockResolvedValue(null), findActiveById: jest.fn().mockResolvedValue(null) });
    await expect(new DeleteSkillUseCase(missing).execute({ ownerId: OWNER_ID, skillId: SKILL_ID, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });
});
