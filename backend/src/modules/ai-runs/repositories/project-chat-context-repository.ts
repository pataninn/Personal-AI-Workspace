export interface ProjectChatContext {
  readonly relativePaths: readonly string[];
  readonly factIds: readonly string[];
  readonly includeProjectConversations: boolean;
  readonly excludedPaths?: readonly string[];
  readonly availablePaths?: readonly string[];
  readonly fileSelectionLimited?: boolean;
}

export const DEFAULT_PROJECT_CHAT_CONTEXT: ProjectChatContext = {
  relativePaths: [], factIds: [], includeProjectConversations: true, excludedPaths: []
};

export interface IProjectChatContextRepository {
  get(ownerId: string, projectId: string): Promise<ProjectChatContext>;
  update(ownerId: string, projectId: string, changes: Partial<ProjectChatContext>): Promise<ProjectChatContext>;
}
