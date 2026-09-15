import type {
  WorkspaceListOptions,
  WorkspaceListResult,
  WorkspaceProjectScope,
  WorkspaceReadOptions,
  WorkspaceReadResult,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceTreeOptions,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';

export interface IWorkspaceGateway {
  list(scope: WorkspaceProjectScope, options: WorkspaceListOptions): Promise<WorkspaceListResult>;
  tree(scope: WorkspaceProjectScope, options: WorkspaceTreeOptions): Promise<WorkspaceTreeResult>;
  readText(scope: WorkspaceProjectScope, options: WorkspaceReadOptions): Promise<WorkspaceReadResult>;
  searchText(scope: WorkspaceProjectScope, options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult>;
}
