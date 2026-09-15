import path from 'node:path';

import {
  WorkspaceDomainError,
  WorkspaceIoError,
  WorkspacePathNotFoundError,
  WorkspacePathForbiddenError,
  WorkspaceReparsePointError
} from '@/modules/files/domain/workspace-errors';
import { isProtectedSegment, WorkspaceRelativePath, relativePathSegments } from '@/modules/files/domain/workspace-path';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { WorkspaceOperationContext } from '@/infrastructure/workspace/workspace-operation';
import {
  isWorkspaceReparsePoint,
  type WorkspaceGatewayFileSystem,
  type WorkspaceGatewayStats
} from '@/infrastructure/workspace/workspace-gateway-fs';

export interface WorkspaceScopePaths {
  readonly canonicalRoot: string;
  readonly canonicalProjectRoot: string;
}

export async function resolveWorkspaceScope(
  boundary: IWorkspaceBoundary,
  fileSystem: WorkspaceGatewayFileSystem,
  containerRoot: string,
  scope: WorkspaceProjectScope,
  context: WorkspaceOperationContext
): Promise<WorkspaceScopePaths> {
  const relativeRoot = await context.run(() => boundary.validateProjectRoot(scope.relativeRoot));
  const canonicalRoot = await safeRealpath(fileSystem, containerRoot, context);
  const projectPath = path.posix.join(containerRoot, relativeRoot);
  const canonicalProjectRoot = await safeRealpath(fileSystem, projectPath, context);
  if (!isContained(canonicalRoot, canonicalProjectRoot) || canonicalRoot === canonicalProjectRoot) {
    throw new WorkspacePathForbiddenError();
  }
  WorkspaceRelativePath.parse(path.posix.relative(canonicalRoot, canonicalProjectRoot));
  return { canonicalRoot, canonicalProjectRoot };
}

export async function resolveWorkspaceEntry(
  fileSystem: WorkspaceGatewayFileSystem,
  scopePaths: WorkspaceScopePaths,
  relativePath: string,
  context: WorkspaceOperationContext,
  maxPathLength = 2048
): Promise<{ readonly path: string; readonly stats: WorkspaceGatewayStats }> {
  const parsed = WorkspaceRelativePath.parse(relativePath, { allowEmpty: true, maxLength: maxPathLength });
  let currentPath = scopePaths.canonicalProjectRoot;
  for (const segment of relativePathSegments(parsed.value)) {
    currentPath = path.posix.join(currentPath, segment);
    const stats = await safeLstat(fileSystem, currentPath, context);
    assertInspectableComponent(stats);
  }
  const canonicalPath = await safeRealpath(fileSystem, currentPath, context);
  if (!isContained(scopePaths.canonicalProjectRoot, canonicalPath, true)) {
    throw new WorkspacePathForbiddenError();
  }
  const canonicalRelativePath = path.posix.relative(scopePaths.canonicalProjectRoot, canonicalPath);
  const validatedCanonicalPath = WorkspaceRelativePath.parse(canonicalRelativePath, {
    allowEmpty: true,
    maxLength: maxPathLength
  });
  return { path: validatedCanonicalPath.value, stats: await safeLstat(fileSystem, canonicalPath, context) };
}

export function isContained(root: string, target: string, allowRoot = false): boolean {
  const relative = path.posix.relative(root.toLocaleLowerCase('en-US'), target.toLocaleLowerCase('en-US'));
  return (allowRoot && relative.length === 0)
    || (relative.length > 0 && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

export async function safeLstat(
  fileSystem: WorkspaceGatewayFileSystem,
  filePath: string,
  context: WorkspaceOperationContext
): Promise<WorkspaceGatewayStats> {
  try {
    return await context.run(() => fileSystem.lstat(filePath));
  } catch (error: unknown) {
    throw mapWorkspaceFileSystemError(error);
  }
}

export async function safeRealpath(
  fileSystem: WorkspaceGatewayFileSystem,
  filePath: string,
  context: WorkspaceOperationContext
): Promise<string> {
  try {
    return await context.run(() => fileSystem.realpath(filePath));
  } catch (error: unknown) {
    throw mapWorkspaceFileSystemError(error);
  }
}

export function assertInspectableComponent(stats: WorkspaceGatewayStats): void {
  if (isWorkspaceReparsePoint(stats)) {
    throw new WorkspaceReparsePointError();
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new WorkspaceIoError();
  }
}

export function assertDirectory(stats: WorkspaceGatewayStats): void {
  assertInspectableComponent(stats);
  if (!stats.isDirectory()) {
    throw new WorkspacePathNotFoundError();
  }
}

export function assertSafeDirectoryPath(relativePath: string): void {
  const segments = relativePathSegments(relativePath);
  if (segments.some(isProtectedSegment)) {
    throw new WorkspacePathForbiddenError();
  }
}

export function mapWorkspaceFileSystemError(error: unknown): WorkspaceDomainError {
  if (error instanceof WorkspaceDomainError) {
    return error;
  }
  if (isFileSystemCode(error, 'ENOENT') || isFileSystemCode(error, 'ENOTDIR')) {
    return new WorkspacePathNotFoundError();
  }
  return new WorkspaceIoError();
}

function isFileSystemCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as { code?: unknown }).code === code;
}
