import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import type { StorageFileOperationScopeRequest, StorageQuotaTransaction, StorageTrustedFileScopeResolver } from '@/modules/storage-quotas/repositories/storage-quota-repository';

export interface ProjectFileMutationAccess {
  readonly ownerId: string;
  readonly projectId: string;
  readonly rootKey: string;
  readonly scope: WorkspaceProjectScope;
  readonly resolveTrustedScope: StorageTrustedFileScopeResolver;
  recordActivity(): Promise<void>;
}

export interface IProjectFileAccess {
  execute<T>(input: { readonly ownerId: string; readonly projectId: string }, action: (scope: WorkspaceProjectScope) => Promise<T>): Promise<T>;
  authorizeMutation(input: { readonly ownerId: string; readonly projectId: string }): Promise<ProjectFileMutationAccess>;
}

export interface IProjectFileGateway {
  download(scope: WorkspaceProjectScope, relativePath: string): Promise<{ readonly bytes: Buffer; readonly hash: string }>;
  captureForExport(scope: WorkspaceProjectScope, options: { readonly maxFiles: number; readonly maxTotalBytes: number; readonly deadlineAt: number }): Promise<readonly ExportWorkspaceFile[]>;
  write(scope: WorkspaceProjectScope, input: { readonly path: string; readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }>;
  remove(scope: WorkspaceProjectScope, input: { readonly path: string; readonly expectedHash: string }): Promise<void>;
}

export interface ExportWorkspaceFile {
  readonly path: string;
  readonly encoding: 'base64';
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly content: string;
}
