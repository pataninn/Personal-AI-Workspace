import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import { requireProjectFileScope } from '@/modules/projects/domain/project-file-root';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type {
  WorkspaceListOptions,
  WorkspaceListResult,
  WorkspaceReadOptions,
  WorkspaceReadResult,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceTreeOptions,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';

interface WorkspaceInspectionInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export type ListWorkspaceFilesInput = WorkspaceInspectionInput & WorkspaceListOptions;
export type TreeWorkspaceFilesInput = WorkspaceInspectionInput & WorkspaceTreeOptions;
export type ReadWorkspaceTextInput = WorkspaceInspectionInput & WorkspaceReadOptions;
export type SearchWorkspaceTextInput = WorkspaceInspectionInput & WorkspaceSearchOptions;

export class ListWorkspaceFilesUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceGateway: IWorkspaceGateway
  ) {}

  public async execute(input: ListWorkspaceFilesInput): Promise<WorkspaceListResult> {
    const project = await findProject(this.projectRepository, input.ownerId, input.projectId);
    return this.workspaceGateway.list(requireProjectFileScope(project), input);
  }
}

export class TreeWorkspaceFilesUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceGateway: IWorkspaceGateway
  ) {}

  public async execute(input: TreeWorkspaceFilesInput): Promise<WorkspaceTreeResult> {
    const project = await findProject(this.projectRepository, input.ownerId, input.projectId);
    return this.workspaceGateway.tree(requireProjectFileScope(project), input);
  }
}

export class ReadWorkspaceTextUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceGateway: IWorkspaceGateway
  ) {}

  public async execute(input: ReadWorkspaceTextInput): Promise<WorkspaceReadResult> {
    const project = await findProject(this.projectRepository, input.ownerId, input.projectId);
    return this.workspaceGateway.readText(requireProjectFileScope(project), input);
  }
}

export class SearchWorkspaceTextUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceGateway: IWorkspaceGateway
  ) {}

  public async execute(input: SearchWorkspaceTextInput): Promise<WorkspaceSearchResult> {
    const project = await findProject(this.projectRepository, input.ownerId, input.projectId);
    return this.workspaceGateway.searchText(requireProjectFileScope(project), input);
  }
}

async function findProject(
  projectRepository: IProjectRepository,
  ownerId: string,
  projectId: string
) {
  const project = await projectRepository.findByIdForOwner(ownerId, projectId);
  if (!project) {
    throw new ProjectNotFoundError();
  }
  return project;
}
