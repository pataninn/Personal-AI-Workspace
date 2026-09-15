import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { CreateProjectUseCase } from '@/modules/projects/use-cases/create-project';
import { GetProjectUseCase } from '@/modules/projects/use-cases/get-project';
import { ListProjectsUseCase } from '@/modules/projects/use-cases/list-projects';
import { UpdateProjectStatusUseCase } from '@/modules/projects/use-cases/update-project-status';

const project: Project = {
  id: 'project-1',
  ownerId: 'owner-1',
  name: 'Website',
  slug: 'website',
  relativeRoot: 'apps/website',
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
    updateStatus: jest.fn().mockResolvedValue({ ...project, status: 'archived', version: 2 }),
    ...overrides
  } as unknown as jest.Mocked<IProjectRepository>;
}

function boundary(overrides: Partial<IWorkspaceBoundary> = {}): jest.Mocked<IWorkspaceBoundary> {
  return {
    getSnapshot: jest.fn().mockResolvedValue({ status: 'ready' }),
    assertReady: jest.fn().mockResolvedValue(undefined),
    validateProjectRoot: jest.fn().mockImplementation(async (value: string) => value),
    ...overrides
  } as unknown as jest.Mocked<IWorkspaceBoundary>;
}

describe('project use cases', () => {
  it('creates only after boundary validation and active-root overlap checks', async () => {
    const projects = repository();
    const workspace = boundary();
    const useCase = new CreateProjectUseCase(projects, workspace);

    await expect(useCase.execute({ ownerId: 'owner-1', name: 'Website', relativeRoot: 'apps/website' })).resolves.toEqual(project);
    expect(workspace.assertReady).toHaveBeenCalledTimes(1);
    expect(workspace.validateProjectRoot).toHaveBeenCalledWith('apps/website');
    expect(projects.create).toHaveBeenCalledWith(expect.objectContaining({ relativeRoot: 'apps/website' }));
  });

  it('blocks a parent or child active root before persistence', async () => {
    const projects = repository({ listActiveRoots: jest.fn().mockResolvedValue(['apps']) });
    const useCase = new CreateProjectUseCase(projects, boundary());

    await expect(useCase.execute({ ownerId: 'owner-1', name: 'Website', relativeRoot: 'apps/site' })).rejects.toMatchObject({ code: 'PROJECT_ROOT_OVERLAP' });
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('keeps reads owner-scoped and maps a missing guessed ID to not found', async () => {
    const projects = repository({ findByIdForOwner: jest.fn().mockResolvedValue(null) });
    const useCase = new GetProjectUseCase(projects, boundary());

    await expect(useCase.execute({ ownerId: 'owner-2', projectId: 'project-1' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(projects.findByIdForOwner).toHaveBeenCalledWith('owner-2', 'project-1');
  });

  it('requires a current version for lifecycle changes and revalidates restore', async () => {
    const projects = repository({ findByIdForOwner: jest.fn().mockResolvedValue({ ...project, status: 'archived' }) });
    const workspace = boundary();
    const useCase = new UpdateProjectStatusUseCase(projects, workspace);

    await expect(useCase.execute({ ownerId: 'owner-1', projectId: 'project-1', status: 'active', expectedVersion: 1 })).resolves.toMatchObject({ status: 'archived' });
    expect(workspace.validateProjectRoot).toHaveBeenCalledWith('apps/website');
    expect(projects.updateStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', expectedVersion: 1 }));
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

  it('fails project list closed when the workspace identity is unavailable', async () => {
    const projects = repository();
    const workspace = boundary({ assertReady: jest.fn().mockRejectedValue(new Error('identity mismatch')) });
    const useCase = new ListProjectsUseCase(projects, workspace);

    await expect(useCase.execute({ ownerId: 'owner-1', includeArchived: true })).rejects.toThrow('identity');
    expect(projects.listByOwner).not.toHaveBeenCalled();
  });
});
