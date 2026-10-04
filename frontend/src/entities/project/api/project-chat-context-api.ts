import { getJson, patchJson } from '@/shared/api';

export interface ProjectChatContext {
  readonly relativePaths: readonly string[];
  readonly factIds: readonly string[];
  readonly includeProjectConversations: boolean;
  readonly excludedPaths?: readonly string[];
  readonly availablePaths?: readonly string[];
  readonly fileSelectionLimited?: boolean;
}

function contextPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/chat-context`;
}

export function getProjectChatContext(projectId: string): Promise<ProjectChatContext> {
  return getJson<ProjectChatContext>(contextPath(projectId));
}

export function updateProjectChatContext(projectId: string, changes: Partial<ProjectChatContext>, csrfToken: string): Promise<ProjectChatContext> {
  return patchJson<ProjectChatContext>(contextPath(projectId), changes, { 'X-CSRF-Token': csrfToken });
}
