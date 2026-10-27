import type { Project } from '@/modules/projects/domain/project-types';
import { WorkspaceStorageUnavailableError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { CreateProjectUseCase } from '@/modules/projects/use-cases/create-project';
import { GetProjectUseCase } from '@/modules/projects/use-cases/get-project';
import { ListProjectsUseCase } from '@/modules/projects/use-cases/list-projects';
import { UpdateProjectStatusUseCase } from '@/modules/projects/use-cases/update-project-status';

const project: Project = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '11111111-1111-4111-8111-111111111111',
  name: 'Website',
  slug: 'website',
  relativeRoot: 'apps/website',
  storageKind: 'legacy',
  objective: null,
  status: 'active',
  version: 1,
  createdAt: new Date('2026-09-12T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z')
};

function repository(overrides: Partial<IProjectRepository> = {}): jest.Mocked<IProjectRepository> {
  return {
    listByOwner: jest.fn().mockResolvedValue([project]),
    findByIdForOwner: jest.fn().mockResolvedValue(project),
    listActiveRoots: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(project),
    recoverUncreatedRoot: jest.fn().mockImplementation(async (_ownerId: string, _projectId: string, discard: () => Promise<void>) => discard()),
    updateStatus: jest.fn().mockResolvedValue({ ...project, status: 'archived', version: 2 }),
    ...overrides
  } as unknown as jest.Mocked<IProjectRepository>;
}

function boundary(overrides: Partial<IWorkspaceBoundary> = {}): jest.Mocked<IWorkspaceBoundary> {
  return {
    getSnapshot: jest.fn().mockResolvedValue({ status: 'ready' }),
    assertReady: jest.fn().mockResolvedValue(undefined),
    validateProjectRoot: jest.fn().mockImplementation(async (value: string) => value),
    allocateManagedProjectRoot: jest.fn().mockImplementation(async (_ownerId: string, projectId: string) => ({ relativeRoot: `projects/${projectId}`, discardIfEmpty: jest.fn(async () => undefined) })),
    ...overrides
  } as unknown as jest.Mocked<IWorkspaceBoundary>;
}

describe('project use cases', () => {
  it('allocates a server-generated managed root for a new file-backed project', async () => {
    const projects = repository();
    const workspace = boundary();
    const createId = jest.fn(() => '33333333-3333-4333-8333-333333333333');
    const useCase = new CreateProjectUseCase(projects, workspace, createId);

    await expect(useCase.execute({ ownerId: project.ownerId, name: 'Website' })).resolves.toEqual(project);
    expect(createId).toHaveBeenCalledTimes(1);
    expect(workspace.allocateManagedProjectRoot).toHaveBeenCalledWith(project.ownerId, '33333333-3333-4333-8333-333333333333');
    expect(projects.create).toHaveBeenCalledWith(expect.objectContaining({
      id: '33333333-3333-4333-8333-333333333333',
      relativeRoot: 'projects/33333333-3333-4333-8333-333333333333',
      relativeRootKey: 'projects/33333333-3333-4333-8333-333333333333',
      storageKind: 'managed'
    }));
  });

  it('creates a planning workspace without checking or creating a workspace folder', async () => {
    const planningProject: Project = { ...project, relativeRoot: null, storageKind: null, objective: 'Plan the launch' };
    const projects = repository({ create: jest.fn().mockResolvedValue(planningProject) });
    const workspace = boundary({ allocateManagedProjectRoot: jest.fn().mockRejectedValue(new Error('workspace unavailable')) });
    const useCase = new CreateProjectUseCase(projects, workspace);

    await expect(useCase.execute({ ownerId: 'owner-1', name: 'Launch plan', workspaceMode: 'planning', objective: '  Plan the launch  ' }))
      .resolves.toMatchObject({ relativeRoot: null, objective: 'Plan the launch' });
    expect(workspace.assertReady).not.toHaveBeenCalled();
    expect(workspace.allocateManagedProjectRoot).not.toHaveBeenCalled();
    expect(projects.listActiveRoots).not.toHaveBeenCalled();
    expect(projects.create).toHaveBeenCalledWith(expect.objectContaining({ relativeRoot: null, relativeRootKey: null, objective: 'Plan the launch' }));
  });

  it('fails closed when managed storage is not configured and rejects unsupported modes', async () => {
    const workspace = boundary();
    const unconfiguredBoundary = boundary();
    delete unconfiguredBoundary.allocateManagedProjectRoot;
    const useCase = new CreateProjectUseCase(repository(), unconfiguredBoundary);

    await expect(useCase.execute({ ownerId: project.ownerId, name: 'Private files' })).rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
    await expect(new CreateProjectUseCase(repository(), workspace).execute({ ownerId: project.ownerId, name: 'Unsupported', workspaceMode: 'other' }))
      .rejects.toMatchObject({ code: 'PROJECT_WORKSPACE_MODE_INVALID' });
  });

  it('keeps reads owner-scoped and maps a missing guessed ID to not found', async () => {
    const projects = repository({ findByIdForOwner: jest.fn().mockResolvedValue(null) });
    const useCase = new GetProjectUseCase(projects);

    await expect(useCase.execute({ ownerId: 'owner-2', projectId: 'project-1' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(projects.findByIdForOwner).toHaveBeenCalledWith('owner-2', 'project-1');
  });

  it('discards a rejected new allocation only through the repository recovery proof', async () => {
    const rejection = new Error('quota rejected');
    const discard = jest.fn(async () => undefined);
    const workspace = boundary({ allocateManagedProjectRoot: jest.fn().mockResolvedValue({ relativeRoot: 'projects/new', discardIfEmpty: discard }) });
    const projects = repository({ create: jest.fn().mockRejectedValue(rejection) });
    await expect(new CreateProjectUseCase(projects, workspace, () => 'new').execute({ ownerId: project.ownerId, name: 'Rejected' })).rejects.toBe(rejection);
    expect(projects.recoverUncreatedRoot).toHaveBeenCalledWith(project.ownerId, 'new', expect.any(Function));
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('retains a new allocation when the recovery database cannot establish its association', async () => {
    const discard = jest.fn(async () => undefined);
    const workspace = boundary({ allocateManagedProjectRoot: jest.fn().mockResolvedValue({ relativeRoot: 'projects/new', discardIfEmpty: discard }) });
    const projects = repository({ create: jest.fn().mockRejectedValue(new Error('commit uncertain')), recoverUncreatedRoot: jest.fn().mockRejectedValue(new Error('primary unavailable')) });
    await expect(new CreateProjectUseCase(projects, workspace).execute({ ownerId: project.ownerId, name: 'Uncertain' })).rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
    expect(discard).not.toHaveBeenCalled();
  });

  it('requires a current version for lifecycle changes and revalidates restore', async () => {
    const projects = repository({ findByIdForOwner: jest.fn().mockResolvedValue({ ...project, status: 'archived' }) });
    const workspace = boundary();
    const useCase = new UpdateProjectStatusUseCase(projects, workspace);

    await expect(useCase.execute({ ownerId: 'owner-1', projectId: 'project-1', status: 'active', expectedVersion: 1 })).resolves.toMatchObject({ status: 'archived' });
    expect(workspace.validateProjectRoot).toHaveBeenCalledWith('apps/website');
    expect(projects.listActiveRoots).toHaveBeenCalledWith('owner-1', 'legacy');
    expect(projects.updateStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', expectedVersion: 1 }));
  });

  it('reactivates rootless planning metadata without workspace readiness or root validation', async () => {
    const planningProject: Project = { ...project, relativeRoot: null, storageKind: null, status: 'archived' };
    const projects = repository({
      findByIdForOwner: jest.fn().mockResolvedValue(planningProject),
      updateStatus: jest.fn().mockResolvedValue({ ...planningProject, status: 'active', version: 2 })
    });
    const workspace = boundary({ assertReady: jest.fn().mockRejectedValue(new Error('workspace unavailable')) });

    await expect(new UpdateProjectStatusUseCase(projects, workspace).execute({ ownerId: 'owner-1', projectId: 'project-1', status: 'active', expectedVersion: 1 }))
      .resolves.toMatchObject({ status: 'active', relativeRoot: null });
    expect(workspace.assertReady).not.toHaveBeenCalled();
    expect(workspace.validateProjectRoot).not.toHaveBeenCalled();
  });

  it('blocks restoring an archived root when another active project now owns the same root', async () => {
    const projects = repository({
      findByIdForOwner: jest.fn().mockResolvedValue({ ...project, status: 'archived' }),
      listActiveRoots: jest.fn().mockResolvedValue(['apps/website'])
    });
    const useCase = new UpdateProjectStatusUseCase(projects, boundary());

    await expect(useCase.execute({ ownerId: 'owner-1', projectId: 'project-1', status: 'active', expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_OVERLAP' });
    expect(projects.updateStatus).not.toHaveBeenCalled();
  });

  it('keeps project metadata available when the workspace identity is unavailable', async () => {
    const projects = repository();
    const useCase = new ListProjectsUseCase(projects);

    await expect(useCase.execute({ ownerId: 'owner-1', includeArchived: true })).resolves.toEqual([project]);
    expect(projects.listByOwner).toHaveBeenCalledWith('owner-1', true);
  });
});
