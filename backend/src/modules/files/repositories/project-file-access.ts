import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';

export interface IProjectFileAccess {
  execute<T>(input: { readonly ownerId: string; readonly projectId: string; readonly writable: boolean }, action: (scope: WorkspaceProjectScope) => Promise<T>): Promise<T>;
}

export interface IProjectFileGateway {
  download(scope: WorkspaceProjectScope, relativePath: string): Promise<{ readonly bytes: Buffer; readonly hash: string }>;
  write(scope: WorkspaceProjectScope, input: { readonly path: string; readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }>;
  remove(scope: WorkspaceProjectScope, input: { readonly path: string; readonly expectedHash: string }): Promise<void>;
}
