import type {
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchResult,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';
import {
  ListWorkspaceFilesUseCase,
  ReadWorkspaceTextUseCase,
  SearchWorkspaceTextUseCase,
  TreeWorkspaceFilesUseCase
} from '@/modules/files/use-cases';
import { AppError } from '@/shared/errors/app-error';

export type WorkspaceInspectionToolName = 'workspace.list' | 'workspace.tree' | 'workspace.readText' | 'workspace.searchText';

export interface WorkspaceInspectionToolCall {
  readonly ownerId: string;
  readonly projectId: string;
  readonly name: WorkspaceInspectionToolName;
  readonly arguments: unknown;
  readonly signal?: AbortSignal;
}

export type WorkspaceInspectionToolResult = WorkspaceListResult | WorkspaceTreeResult | WorkspaceReadResult | WorkspaceSearchResult;

export interface WorkspaceInspectionToolDependencies {
  readonly listWorkspaceFiles: ListWorkspaceFilesUseCase;
  readonly treeWorkspaceFiles: TreeWorkspaceFilesUseCase;
  readonly readWorkspaceText: ReadWorkspaceTextUseCase;
  readonly searchWorkspaceText: SearchWorkspaceTextUseCase;
}

export class WorkspaceInspectionToolAdapter {
  public constructor(private readonly dependencies: WorkspaceInspectionToolDependencies) {}

  public async execute(call: WorkspaceInspectionToolCall): Promise<WorkspaceInspectionToolResult> {
    const args = asArguments(call.arguments);
    if (call.name === 'workspace.list') {
      return this.dependencies.listWorkspaceFiles.execute({ ...call, directory: stringArgument(args, 'directory', '') });
    }
    if (call.name === 'workspace.tree') {
      return this.dependencies.treeWorkspaceFiles.execute({ ...call, directory: stringArgument(args, 'directory', ''), depth: numberArgument(args, 'depth', 2) });
    }
    if (call.name === 'workspace.readText') {
      return this.dependencies.readWorkspaceText.execute({ ...call, path: stringArgument(args, 'path') });
    }
    if (call.name === 'workspace.searchText') {
      return this.dependencies.searchWorkspaceText.execute({
        ...call,
        directory: stringArgument(args, 'directory', ''),
        query: stringArgument(args, 'query'),
        ...(args.maxResults === undefined ? {} : { maxResults: numberArgument(args, 'maxResults') })
      });
    }
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace tool name is invalid.');
  }
}

export { WorkspaceInspectionToolAdapter as WorkspaceGatewayToolAdapter };

function asArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace tool arguments are invalid.');
  }
  return value as Record<string, unknown>;
}

function stringArgument(args: Record<string, unknown>, name: string, defaultValue?: string): string {
  const value = args[name] === undefined ? defaultValue : args[name];
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace tool arguments are invalid.');
  }
  return value;
}

function numberArgument(args: Record<string, unknown>, name: string, defaultValue?: number): number {
  const value = args[name] === undefined ? defaultValue : args[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace tool arguments are invalid.');
  }
  return value;
}
