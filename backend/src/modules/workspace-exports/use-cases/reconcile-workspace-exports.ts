import { AppError } from '@/shared/errors/app-error';
import type {
  IWorkspaceExportArtifactStore,
  IWorkspaceExportCleanup,
  IWorkspaceExportRepository,
  WorkspaceExportRecord
} from '@/modules/workspace-exports/repositories/workspace-export-repository';
import type { WorkspaceExportBuilderLiveness, WorkspaceExportBuilderProbe } from '@/modules/workspace-exports/repositories/workspace-export-builder-probe';

/** Reconciles only artifacts whose writers are safely terminal or proven gone. */
export class ReconcileWorkspaceExports implements IWorkspaceExportCleanup {
  public constructor(
    private readonly exports: IWorkspaceExportRepository,
    private readonly artifacts: IWorkspaceExportArtifactStore,
    private readonly probe: WorkspaceExportBuilderProbe,
    private readonly supportsLocalArtifactRuntime: () => boolean = () => process.platform === 'linux'
  ) {}

  public async reconcileStartup(): Promise<void> {
    if (!this.supportsLocalArtifactRuntime()) return;
    const records = await this.exports.listForStartup();
    for (const record of records) await this.reconcileRecord(record);
    const remaining = await this.exports.listForStartup();
    const building = new Set(remaining.filter((record) => record.state === 'building').map((record) => record.id));
    for (const id of await this.artifacts.listPartIds()) if (!building.has(id)) await this.artifacts.remove(id).catch(() => undefined);
    await this.exports.deleteOldTombstones(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }

  public async waitForTerminalAndRemove(ids: readonly string[], waitMs = 65_000): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const records = await this.exports.listByIds(ids);
      const active = records.filter((record) => record.state === 'building');
      if (active.length === 0) break;
      for (const record of active) await this.reconcileBuilder(record, false);
      if (Date.now() >= deadline) throw cleanupPending();
      await delay(100);
    }
    for (const id of ids) await this.artifacts.remove(id);
    await this.exports.deleteTerminal(ids);
  }

  private async reconcileRecord(record: WorkspaceExportRecord): Promise<void> {
    if (record.state === 'building') {
      await this.reconcileBuilder(record);
      return;
    }
    if (record.state === 'ready') {
      if (await this.exports.markExpired(record.id)) {
        await this.artifacts.remove(record.id).catch(() => undefined);
        return;
      }
      if (await this.artifacts.exists(record.id).catch(() => true)) return;
      await this.exports.markUnavailable(record.id);
    }
    await this.artifacts.remove(record.id).catch(() => undefined);
  }

  private async reconcileBuilder(record: WorkspaceExportRecord, removeAfterTerminal = true): Promise<void> {
    if (!record.builder) return;
    const status = await this.probe(record.builder).catch((): WorkspaceExportBuilderLiveness => 'unknown');
    if (status !== 'absent' && status !== 'reused') return;
    const failed = await this.exports.markFailedIfBuilderMatches(record.id, record.builder);
    if (failed && removeAfterTerminal) await this.artifacts.remove(record.id).catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanupPending(): AppError {
  return new AppError('EXPORT_CLEANUP_PENDING', 503, 'Workspace export cleanup is still in progress.');
}
