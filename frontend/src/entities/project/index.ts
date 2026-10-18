export { createProject, getProject, listProjects, removeProject, updateProjectStatus } from '@/entities/project/api/project-api';
export { getProjectChatContext, updateProjectChatContext } from '@/entities/project/api/project-chat-context-api';
export type { ProjectChatContext } from '@/entities/project/api/project-chat-context-api';
export { useProjectChatContext } from '@/entities/project/model/use-project-chat-context';
export { loadProject, loadProjects, projectCreated, projectReducer, projectStatusUpdated } from '@/entities/project/model/slice';
export {
  selectProjectById,
  selectProjectDetail,
  selectProjectErrorCode,
  selectProjectListStatus,
  selectProjectState,
  selectProjects
} from '@/entities/project/model/selectors';
export type {
  CreateProjectRequest
} from '@/entities/project/api/project-api';
export type { ProjectCapabilities, ProjectDetailState, ProjectListResponse, ProjectSnapshot, ProjectState, ProjectStatus, ProjectWorkspaceMode } from '@/entities/project/model/types';
export { getProjectOverview } from '@/entities/project/api/project-overview-api';
export { useProjectOverview } from '@/entities/project/model/use-project-overview';
export type { ProjectOverview, HomeTaskSummary } from '@/entities/project/api/project-overview-api';
export { projectColor } from '@/entities/project/lib/presentation';
