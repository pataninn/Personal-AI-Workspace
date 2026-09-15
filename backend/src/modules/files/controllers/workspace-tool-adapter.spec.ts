import type {
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchResult,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';
import { WorkspaceInspectionToolAdapter } from '@/modules/files/controllers/workspace-tool-adapter';
import type { WorkspaceInspectionToolDependencies } from '@/modules/files/controllers/workspace-tool-adapter';
import { AppError } from '@/shared/errors/app-error';

const emptyList: WorkspaceListResult = { directory: '', entries: [], truncated: false };

describe('WorkspaceInspectionToolAdapter', () => {
  it('maps tool calls to project-scoped use cases without accepting a host path', async () => {
    const listExecute = jest.fn().mockResolvedValue(emptyList);
    const dependencies = {
      listWorkspaceFiles: { execute: listExecute },
      treeWorkspaceFiles: { execute: jest.fn() },
      readWorkspaceText: { execute: jest.fn() },
      searchWorkspaceText: { execute: jest.fn() }
    } as unknown as WorkspaceInspectionToolDependencies;
    const adapter = new WorkspaceInspectionToolAdapter(dependencies);

    await adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.list', arguments: { directory: 'src' } });
    expect(listExecute).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-1', projectId: 'project-1', directory: 'src' }));
    expect(listExecute.mock.calls[0]?.[0]).not.toHaveProperty('hostPath');
  });

  it('routes every inspection tool with bounded project-relative arguments', async () => {
    const tree: WorkspaceTreeResult = { directory: 'src', depth: 2, entries: [], truncated: false };
    const read: WorkspaceReadResult = { path: 'src/main.ts', content: '', encoding: 'utf-8', sizeBytes: 0, lineCount: 1, truncated: false };
    const search: WorkspaceSearchResult = { directory: 'src', query: 'needle', matches: [], filesScanned: 0, truncated: false };
    const dependencies = {
      listWorkspaceFiles: { execute: jest.fn().mockResolvedValue(emptyList) },
      treeWorkspaceFiles: { execute: jest.fn().mockResolvedValue(tree) },
      readWorkspaceText: { execute: jest.fn().mockResolvedValue(read) },
      searchWorkspaceText: { execute: jest.fn().mockResolvedValue(search) }
    } as unknown as WorkspaceInspectionToolDependencies;
    const adapter = new WorkspaceInspectionToolAdapter(dependencies);

    await adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.tree', arguments: { directory: 'src', depth: 2 } });
    await adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.readText', arguments: { path: 'src/main.ts' } });
    await adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.searchText', arguments: { directory: 'src', query: 'needle', maxResults: 5 } });

    expect(dependencies.treeWorkspaceFiles.execute).toHaveBeenCalledWith(expect.objectContaining({ directory: 'src', depth: 2 }));
    expect(dependencies.readWorkspaceText.execute).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/main.ts' }));
    expect(dependencies.searchWorkspaceText.execute).toHaveBeenCalledWith(expect.objectContaining({ directory: 'src', query: 'needle', maxResults: 5 }));
  });

  it('rejects non-object and untyped tool arguments at the adapter boundary', async () => {
    const dependencies = {
      listWorkspaceFiles: { execute: jest.fn() },
      treeWorkspaceFiles: { execute: jest.fn() },
      readWorkspaceText: { execute: jest.fn() },
      searchWorkspaceText: { execute: jest.fn() }
    } as unknown as WorkspaceInspectionToolDependencies;
    const adapter = new WorkspaceInspectionToolAdapter(dependencies);

    await expect(adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.list', arguments: null })).rejects.toBeInstanceOf(AppError);
    await expect(adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.tree', arguments: { depth: '2' } })).rejects.toBeInstanceOf(AppError);
    await expect(adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.searchText', arguments: { query: 'needle', maxResults: 1.5 } })).rejects.toBeInstanceOf(AppError);
    await expect(adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.list', arguments: { directory: null } })).rejects.toBeInstanceOf(AppError);
    await expect(adapter.execute({ ownerId: 'owner-1', projectId: 'project-1', name: 'workspace.unknown' as 'workspace.list', arguments: {} })).rejects.toBeInstanceOf(AppError);
  });
});
