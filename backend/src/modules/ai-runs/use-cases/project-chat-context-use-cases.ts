import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { ProjectFactNotFoundError } from '@/modules/memory/domain/project-fact-errors';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import { validateContextFactIds, validateContextPaths } from '@/modules/ai-runs/domain/ai-run-validation';
import type { IProjectChatContextRepository, ProjectChatContext } from '@/modules/ai-runs/repositories/project-chat-context-repository';
import { discoverProjectContextFiles } from '@/modules/ai-runs/use-cases/discover-project-context-files';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';

export class ProjectChatContextUseCases {
  public constructor(
    private readonly projects: IProjectRepository,
    private readonly contexts: IProjectChatContextRepository,
    private readonly facts: IProjectFactRepository,
    private readonly workspace: IWorkspaceGateway
  ) {}

  public async get(ownerId: string, projectId: string): Promise<ProjectChatContext> {
    const project = await this.projects.findByIdForOwner(ownerId, projectId);
    if (!project) throw new ProjectNotFoundError();
    const context = await this.contexts.get(ownerId, projectId);
    const facts = await this.facts.findActiveByIds(ownerId, projectId, context.factIds);
    const inventory = await discoverProjectContextFiles(this.workspace, { projectId, relativeRoot: project.relativeRoot }, context.relativePaths);
    const excludedPaths = context.excludedPaths ?? [];
    const eligible = inventory.paths.filter((path) => !excludedPaths.includes(path));
    return { ...context, factIds: facts.map((fact) => fact.id), excludedPaths, availablePaths: inventory.paths,
      relativePaths: eligible.slice(0, 100), fileSelectionLimited: inventory.limited || eligible.length > 100 };
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
    const excludedPaths = changes.excludedPaths === undefined
      ? await this.exclusionsForLegacySelection(ownerId, projectId, changes.relativePaths)
      : validateExclusions(changes.excludedPaths);
    await this.contexts.update(ownerId, projectId, { ...changes, ...(excludedPaths === undefined ? {} : { excludedPaths }) });
    return this.get(ownerId, projectId);
  }

  private async exclusionsForLegacySelection(ownerId: string, projectId: string, selected: readonly string[] | undefined): Promise<readonly string[] | undefined> {
    if (selected === undefined) return undefined;
    const current = await this.get(ownerId, projectId);
    return [...new Set([...(current.excludedPaths ?? []), ...(current.availablePaths ?? []).filter((path) => !selected.includes(path))])]
      .filter((path) => !selected.includes(path));
  }
}

function validateExclusions(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new AiRunValidationError([{ field: 'excludedPaths', message: 'Exclude at most 1000 relative paths.' }]);
  return [...new Set(value.map((path) => WorkspaceRelativePath.parse(path).value))];
}
