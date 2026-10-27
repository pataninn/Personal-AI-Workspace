import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import {
  ListWorkspaceFilesUseCase,
  ReadWorkspaceTextUseCase,
  SearchWorkspaceTextUseCase,
  TreeWorkspaceFilesUseCase
} from '@/modules/files/use-cases';

const PROJECT: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-1',
  name: 'Workspace',
  slug: 'workspace',
  relativeRoot: 'apps/workspace',
  storageKind: 'legacy',
  objective: null,
  status: 'active',
  version: 1,
  createdAt: new Date('2026-09-12T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z')
};

const projectRepository: jest.Mocked<IProjectRepository> = {
  listByOwner: jest.fn(),
  findByIdForOwner: jest.fn(),
  listActiveRoots: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn()
};

const workspaceGateway: jest.Mocked<IWorkspaceGateway> = {
  list: jest.fn().mockResolvedValue({ directory: '', entries: [], truncated: false }),
  tree: jest.fn().mockResolvedValue({ directory: '', depth: 1, entries: [], truncated: false }),
  readText: jest.fn().mockResolvedValue({ path: 'main.ts', content: '', encoding: 'utf-8', sizeBytes: 0, lineCount: 1, truncated: false }),
  searchText: jest.fn().mockResolvedValue({ directory: '', query: 'x', matches: [], filesScanned: 0, truncated: false })
};

describe('workspace inspection use cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectRepository.findByIdForOwner.mockResolvedValue(PROJECT);
  });

  it('authorizes the owner before delegating list/tree/read/search operations', async () => {
    await new ListWorkspaceFilesUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '' });
    await new TreeWorkspaceFilesUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '', depth: 1 });
    await new ReadWorkspaceTextUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, path: 'main.ts' });
    await new SearchWorkspaceTextUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '', query: 'x' });

    expect(projectRepository.findByIdForOwner).toHaveBeenCalledTimes(4);
    const scope = { ownerId: PROJECT.ownerId, projectId: PROJECT.id, storageKind: PROJECT.storageKind, relativeRoot: PROJECT.relativeRoot };
    expect(workspaceGateway.list).toHaveBeenCalledWith(scope, expect.objectContaining({ directory: '' }));
    expect(workspaceGateway.readText).toHaveBeenCalledWith(scope, expect.objectContaining({ path: 'main.ts' }));
  });

  it('hides guessed or cross-owner project identifiers', async () => {
    projectRepository.findByIdForOwner.mockResolvedValue(null);
    const useCase = new ReadWorkspaceTextUseCase(projectRepository, workspaceGateway);

    await expect(useCase.execute({ ownerId: 'owner-2', projectId: PROJECT.id, path: 'main.ts' })).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(workspaceGateway.readText).not.toHaveBeenCalled();
  });

  it('blocks every file operation for a planning project before calling the workspace gateway', async () => {
    projectRepository.findByIdForOwner.mockResolvedValue({ ...PROJECT, relativeRoot: null });
    await expect(new ListWorkspaceFilesUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '' })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    await expect(new TreeWorkspaceFilesUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '', depth: 1 })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    await expect(new ReadWorkspaceTextUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, path: 'main.ts' })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    await expect(new SearchWorkspaceTextUseCase(projectRepository, workspaceGateway).execute({ ownerId: 'owner-1', projectId: PROJECT.id, directory: '', query: 'x' })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    expect(workspaceGateway.list).not.toHaveBeenCalled();
    expect(workspaceGateway.tree).not.toHaveBeenCalled();
    expect(workspaceGateway.readText).not.toHaveBeenCalled();
    expect(workspaceGateway.searchText).not.toHaveBeenCalled();
  });
});
