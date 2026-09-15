export { createWorkspaceRouter, type WorkspaceRouterDependencies } from '@/modules/files/controllers/workspace-router';
export {
  WorkspaceGatewayToolAdapter,
  WorkspaceInspectionToolAdapter,
  type WorkspaceInspectionToolCall,
  type WorkspaceInspectionToolDependencies,
  type WorkspaceInspectionToolName,
  type WorkspaceInspectionToolResult
} from '@/modules/files/controllers/workspace-tool-adapter';
export {
  ListWorkspaceFilesUseCase,
  ReadWorkspaceTextUseCase,
  SearchWorkspaceTextUseCase,
  TreeWorkspaceFilesUseCase
} from '@/modules/files/use-cases';
export type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
export type {
  WorkspaceEntry,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTreeNode,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';
