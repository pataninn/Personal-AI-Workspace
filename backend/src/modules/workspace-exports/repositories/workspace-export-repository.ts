import type {
  WorkspaceExportBuilderIdentity,
  WorkspaceExportDescriptor,
  WorkspaceExportSnapshot
} from '@/modules/workspace-exports/domain/workspace-export';

export type WorkspaceExportState = 'building' | 'ready' | 'failed' | 'unavailable' | 'expired';

export interface WorkspaceExportRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly state: WorkspaceExportState;
  readonly requestFingerprint: string;
  readonly demoCleanupGeneration: string | null;
  readonly builder: WorkspaceExportBuilderIdentity | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly sizeBytes: number | null;
}

export type BeginWorkspaceExportResult =
  | { readonly kind: 'started'; readonly record: WorkspaceExportRecord }
  | { readonly kind: 'replay'; readonly descriptor: WorkspaceExportDescriptor }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'expired_key' };

export interface IWorkspaceExportRepository {
  begin(input: {
    readonly ownerId: string;
    readonly workspaceId: string;
    readonly keyDigest: string;
    readonly requestFingerprint: string;
    readonly builder: WorkspaceExportBuilderIdentity;
  }): Promise<BeginWorkspaceExportResult>;
  captureSnapshot(ownerId: string, workspaceId: string): Promise<WorkspaceExportSnapshot>;
  publish(id: string, ownerId: string, workspaceId: string, generation: string | null, sizeBytes: number, deadlineAt: number): Promise<WorkspaceExportDescriptor | null>;
  markFailed(id: string): Promise<void>;
  getDownload(ownerId: string, id: string): Promise<WorkspaceExportDescriptor | null>;
  markUnavailable(id: string): Promise<void>;
  listForStartup(): Promise<readonly WorkspaceExportRecord[]>;
  markFailedIfBuilderMatches(id: string, builder: WorkspaceExportBuilderIdentity): Promise<boolean>;
  markExpired(id: string): Promise<boolean>;
  deleteOldTombstones(before: Date): Promise<void>;
  listByIds(ids: readonly string[]): Promise<readonly WorkspaceExportRecord[]>;
  deleteTerminal(ids: readonly string[]): Promise<void>;
}

export interface IWorkspaceExportArtifactStore {
  write(id: string, bytes: Buffer): Promise<void>;
  read(id: string): Promise<Buffer>;
  exists(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  listPartIds(): Promise<readonly string[]>;
}

export interface IWorkspaceExportCleanup {
  waitForTerminalAndRemove(ids: readonly string[], waitMs?: number): Promise<void>;
}
