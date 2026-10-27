import { AppError } from '@/shared/errors/app-error';
import type { IWorkspaceExportArtifactStore, IWorkspaceExportRepository } from '@/modules/workspace-exports/repositories/workspace-export-repository';

export interface WorkspaceExportDownload {
  readonly descriptor: { readonly id: string; readonly workspaceId: string; readonly sizeBytes: number; readonly expiresAt: string };
  readonly bytes: Buffer;
}

export class DownloadWorkspaceExportUseCase {
  public constructor(private readonly exports: IWorkspaceExportRepository, private readonly artifacts: IWorkspaceExportArtifactStore) {}

  public async execute(ownerId: string, exportId: string): Promise<WorkspaceExportDownload> {
    const descriptor = await this.exports.getDownload(ownerId, exportId);
    if (!descriptor) throw unavailable();
    try {
      const bytes = await this.artifacts.read(exportId);
      if (bytes.byteLength !== descriptor.sizeBytes) throw unavailable();
      return { descriptor, bytes };
    } catch {
      await this.exports.markUnavailable(exportId).catch(() => undefined);
      throw unavailable();
    }
  }
}

function unavailable(): AppError { return new AppError('WORKSPACE_EXPORT_UNAVAILABLE', 404, 'The workspace export is unavailable.'); }
