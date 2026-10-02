import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { ProjectFactNotFoundError } from '@/modules/memory/domain/project-fact-errors';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import { validateContextFactIds, validateContextPaths } from '@/modules/ai-runs/domain/ai-run-validation';
import type { IProjectChatContextRepository, ProjectChatContext } from '@/modules/ai-runs/repositories/project-chat-context-repository';

export class ProjectChatContextUseCases {
  public constructor(
    private readonly projects: IProjectRepository,
    private readonly contexts: IProjectChatContextRepository,
    private readonly facts: IProjectFactRepository,
    private readonly workspace: IWorkspaceGateway
  ) {}

  public async get(ownerId: string, projectId: string): Promise<ProjectChatContext> {
    if (!await this.projects.findByIdForOwner(ownerId, projectId)) throw new ProjectNotFoundError();
    const context = await this.contexts.get(ownerId, projectId);
    const facts = await this.facts.findActiveByIds(ownerId, projectId, context.factIds);
    return { ...context, factIds: facts.map((fact) => fact.id) };
  }

  public async update(ownerId: string, projectId: string, changes: Partial<ProjectChatContext>): Promise<ProjectChatContext> {
    const project = await this.projects.findByIdForOwner(ownerId, projectId);
    if (!project || project.status === 'archived') throw new ProjectNotFoundError();
    if (changes.factIds !== undefined) {
      const ids = validateContextFactIds(changes.factIds);
      if ((await this.facts.findActiveByIds(ownerId, projectId, ids)).length !== ids.length) throw new ProjectFactNotFoundError();
    }
    if (changes.relativePaths !== undefined) {
      for (const path of validateContextPaths(changes.relativePaths)) {
        await this.workspace.readText({ projectId, relativeRoot: project.relativeRoot }, { path });
      }
    }
    return this.contexts.update(ownerId, projectId, changes);
  }
}
