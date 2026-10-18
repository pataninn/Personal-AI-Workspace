import { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';

function fixture(): {
  readonly useCases: ProjectChatContextUseCases;
  readonly projects: jest.Mocked<IProjectRepository>;
  readonly facts: jest.Mocked<IProjectFactRepository>;
  readonly contexts: { readonly get: jest.Mock; readonly update: jest.Mock };
  readonly workspace: jest.Mocked<IWorkspaceGateway>;
} {
  const projects: jest.Mocked<IProjectRepository> = { findByIdForOwner: jest.fn().mockResolvedValue({ id: 'project', ownerId: 'owner', status: 'active', relativeRoot: 'project', storageKind: 'legacy' }),
    listByOwner: jest.fn(), listActiveRoots: jest.fn(), create: jest.fn(), updateStatus: jest.fn() };
  const facts: jest.Mocked<IProjectFactRepository> = { findActiveByIds: jest.fn().mockResolvedValue([]), listActiveByProject: jest.fn(),
    findActiveById: jest.fn(), create: jest.fn(), update: jest.fn(), verify: jest.fn(), softDelete: jest.fn() };
  const contexts = { get: jest.fn().mockResolvedValue({ relativePaths: ['README.md'], factIds: [], includeProjectConversations: true }), update: jest.fn().mockResolvedValue({ relativePaths: ['app.ts'], factIds: [], includeProjectConversations: true }) };
  const workspace: jest.Mocked<IWorkspaceGateway> = { readText: jest.fn(), list: jest.fn(), tree: jest.fn().mockResolvedValue({ directory: '', depth: 6, entries: [], truncated: false }), searchText: jest.fn() };
  return { useCases: new ProjectChatContextUseCases(projects, contexts, facts, workspace), projects, contexts, facts, workspace };
}

describe('ProjectChatContextUseCases', () => {
  it('rejects a context lookup outside the owner project before reading its preferences', async () => {
    const { useCases, projects, contexts } = fixture();
    projects.findByIdForOwner.mockResolvedValue(null);
    await expect(useCases.get('other-owner', 'project')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(contexts.get).not.toHaveBeenCalled();
  });
  it('blocks context mutations for an archived project', async () => {
    const { useCases, projects, contexts } = fixture();
    projects.findByIdForOwner.mockResolvedValue({ status: 'archived' } as Awaited<ReturnType<IProjectRepository['findByIdForOwner']>>);
    await expect(useCases.update('owner', 'project', { relativePaths: [] })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(contexts.update).not.toHaveBeenCalled();
  });
  it('rejects facts which do not belong to the current owner and project', async () => {
    const { useCases, contexts, facts } = fixture();
    const factId = '55555555-5555-4555-8555-555555555555';
    await expect(useCases.update('owner', 'project', { factIds: [factId] })).rejects.toMatchObject({ code: 'PROJECT_FACT_NOT_FOUND' });
    expect(facts.findActiveByIds).toHaveBeenCalledWith('owner', 'project', [factId]);
    expect(contexts.update).not.toHaveBeenCalled();
  });
  it('checks selected files through the workspace boundary and saves the derived exclusions', async () => {
    const { useCases, workspace, contexts } = fixture();
    await useCases.update('owner', 'project', { relativePaths: ['app.ts'] });
    expect(workspace.readText).toHaveBeenCalledWith({ ownerId: 'owner', projectId: 'project', storageKind: 'legacy', relativeRoot: 'project' }, { path: 'app.ts' });
    expect(contexts.update).toHaveBeenCalledWith('owner', 'project', { relativePaths: ['app.ts'], excludedPaths: [] });
  });
  it('does not persist files which fail boundary validation', async () => {
    const { useCases, workspace, contexts } = fixture();
    workspace.readText.mockRejectedValue(new Error('Protected path'));
    await expect(useCases.update('owner', 'project', { relativePaths: ['.env'] })).rejects.toThrow('Protected path');
    expect(contexts.update).not.toHaveBeenCalled();
  });

  it('rejects project context reads and updates when a planning project has no file root', async () => {
    const { useCases, projects, workspace, contexts } = fixture();
    projects.findByIdForOwner.mockResolvedValue({ status: 'active', relativeRoot: null } as Awaited<ReturnType<IProjectRepository['findByIdForOwner']>>);
    await expect(useCases.get('owner', 'project')).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    await expect(useCases.update('owner', 'project', { relativePaths: ['README.md'] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    expect(workspace.list).not.toHaveBeenCalled();
    expect(workspace.readText).not.toHaveBeenCalled();
    expect(contexts.get).not.toHaveBeenCalled();
    expect(contexts.update).not.toHaveBeenCalled();
  });
});
