export { flattenWorkspaceFiles, getWorkspaceTree, normalizeWorkspaceSearch, normalizeWorkspaceTree, searchWorkspaceFiles } from '@/entities/workspace/api/workspace-api';
export type { WorkspaceFileCandidate, WorkspaceFileSearchMatch, WorkspaceFileSearchResponse, WorkspaceTreeNode, WorkspaceTreeResponse } from '@/entities/workspace/model/types';
export { readProjectFile, saveProjectFile, deleteProjectFile, downloadProjectFile, uploadProjectFile } from '@/entities/workspace/api/project-file-api';
export type { ProjectTextFile } from '@/entities/workspace/api/project-file-api';
