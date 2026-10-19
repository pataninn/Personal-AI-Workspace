import type { DataSource } from 'typeorm';
import type { IProjectFileAccess } from '@/modules/files/repositories/project-file-access';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import { ProjectNotFoundError, ProjectRootNotAttachedError } from '@/modules/projects/domain/project-errors';
import { AppError } from '@/shared/errors/app-error';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { StorageTrustedFileScope } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageFileOperationScopeRequest, StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type { IStorageRootMappingRepository, StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

interface ProjectFileRow {
  readonly id: string;
  readonly relative_root_key: string | null;
  readonly status: string;
}

interface ProjectFileAuthorization {
  readonly rootKey: string;
  readonly scope: WorkspaceProjectScope;
}

/** Resolves file access in short database transactions; filesystem callbacks run after commit. */
export class TypeOrmProjectFileAccess implements IProjectFileAccess {
  public constructor(private readonly dataSource: DataSource, private readonly roots: IStorageRootMappingRepository) {}

  public async execute<T>(input: { readonly ownerId: string; readonly projectId: string }, action: (scope: WorkspaceProjectScope) => Promise<T>): Promise<T> {
    const authorized = await this.resolveProject(input);
    return action(authorized.scope);
  }

  public async authorizeMutation(input: { readonly ownerId: string; readonly projectId: string }): Promise<{
    readonly ownerId: string;
    readonly projectId: string;
    readonly rootKey: string;
    readonly scope: WorkspaceProjectScope;
    readonly resolveTrustedScope: (transaction: StorageQuotaTransaction, request: StorageFileOperationScopeRequest) => Promise<StorageTrustedFileScope>;
    recordActivity(): Promise<void>;
  }> {
    const authorized = await this.resolveProject(input);
    await this.assertWritable(this.dataSource, input.ownerId, input.projectId);
    return {
      ...input,
      ...authorized,
      resolveTrustedScope: async (transaction, request) => {
        assertScopeRequest(request, input, authorized.rootKey);
        const trusted = await this.roots.resolveTrustedScope(transaction, request);
        assertTrustedScope(trusted, input, authorized.rootKey, authorized.scope);
        await this.assertWritable(transaction, input.ownerId, input.projectId);
        return trusted;
      },
      recordActivity: async () => {
        await this.dataSource.query('UPDATE projects SET updated_at=now() WHERE owner_id=$1 AND id=$2', [input.ownerId, input.projectId]);
      }
    };
  }

  private async resolveProject(input: { readonly ownerId: string; readonly projectId: string }): Promise<ProjectFileAuthorization> {
    return this.dataSource.transaction(async (manager) => {
      await assertActivePrincipal(manager, input.ownerId);
      const rows: ProjectFileRow[] = await manager.query(
        'SELECT id, relative_root_key, status FROM projects WHERE owner_id=$1 AND id=$2',
        [input.ownerId, input.projectId]
      );
      const project = rows[0];
      if (!project) throw new ProjectNotFoundError();
      if (!project.relative_root_key) throw new ProjectRootNotAttachedError();
      const trusted = await this.roots.resolveTrustedScope(manager, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        rootKeys: [project.relative_root_key]
      });
      return { rootKey: project.relative_root_key, scope: toProjectScope(trusted, input, project.relative_root_key) };
    });
  }

  private async assertWritable(
    transaction: StorageQuotaTransaction | DataSource,
    ownerId: string,
    projectId: string
  ): Promise<void> {
    const projects = await transaction.query(
      'SELECT status FROM projects WHERE owner_id=$1 AND id=$2', [ownerId, projectId]
    ) as { readonly status: string }[];
    const project = projects[0];
    if (!project) throw new ProjectNotFoundError();
    if (project.status === 'archived') throw new AppError('PROJECT_READ_ONLY', 409, 'This project is read-only.');
    const removalJobs = await transaction.query(
      'SELECT project_id FROM project_removal_jobs WHERE owner_id=$1 AND project_id=$2 LIMIT 1', [ownerId, projectId]
    ) as { readonly project_id: string }[];
    if (removalJobs.length > 0) throw new AppError('PROJECT_FILES_BUSY', 409, 'This project is being removed.');
    const busy = await transaction.query(
      "SELECT id FROM ai_runs WHERE owner_id=$1 AND project_id=$2 AND (status IN ('pending_approval','staging','ready','queued','running','waiting_approval','cancel_requested','review_required') OR cleanup='unknown') LIMIT 1",
      [ownerId, projectId]
    ) as { readonly id: string }[];
    const changes = await transaction.query(
      "SELECT id FROM ai_run_change_sets WHERE owner_id=$1 AND project_id=$2 AND status IN ('awaiting_approval','applying','needs_manual_review') LIMIT 1",
      [ownerId, projectId]
    ) as { readonly id: string }[];
    const commands = await transaction.query(
      "SELECT id FROM sandbox_commands WHERE owner_id=$1 AND project_id=$2 AND status IN ('awaiting_approval','running','cancel_requested','review_required') LIMIT 1",
      [ownerId, projectId]
    ) as { readonly id: string }[];
    if (busy.length || changes.length || commands.length) {
      throw new AppError('PROJECT_FILES_BUSY', 409, 'Resolve pending project operations before changing files.');
    }
  }
}

async function assertActivePrincipal(transaction: StorageQuotaTransaction | DataSource, ownerId: string): Promise<void> {
  const principals = await transaction.query(
    'SELECT id FROM users WHERE id=$1 AND is_active=true AND (expires_at IS NULL OR expires_at > now()) FOR SHARE', [ownerId]
  ) as { readonly id: string }[];
  if (!principals[0]) throw new UnauthenticatedError();
}

function assertScopeRequest(request: StorageFileOperationScopeRequest, input: { readonly ownerId: string; readonly projectId: string }, rootKey: string): void {
  if (request.ownerId !== input.ownerId || request.projectId !== input.projectId || request.rootKeys.length !== 1 || request.rootKeys[0] !== rootKey) {
    throw new AppError('STORAGE_ACCOUNTING_UNAVAILABLE', 503, 'The trusted storage scope is unavailable.');
  }
}

function assertTrustedScope(
  trusted: StorageTrustedFileScope,
  input: { readonly ownerId: string; readonly projectId: string },
  rootKey: string,
  expectedScope: WorkspaceProjectScope
): void {
  const root = trusted.roots.find((item) => item.rootKey === rootKey);
  if (trusted.ownerId !== input.ownerId || trusted.projectId !== input.projectId || trusted.roots.length !== 1 || !root
    || root.ownerId !== expectedScope.ownerId || root.projectId !== expectedScope.projectId || root.locatorProjectId !== expectedScope.projectId
    || root.storageKind !== expectedScope.storageKind || root.relativeRoot !== expectedScope.relativeRoot) {
    throw new AppError('STORAGE_ACCOUNTING_UNAVAILABLE', 503, 'The trusted storage scope is unavailable.');
  }
}

function toProjectScope(
  trusted: StorageTrustedFileScope,
  input: { readonly ownerId: string; readonly projectId: string },
  rootKey: string
): WorkspaceProjectScope {
  const root = trusted.roots.find((item) => item.rootKey === rootKey);
  if (!root || root.ownerId !== input.ownerId || root.projectId !== input.projectId) throw new ProjectRootNotAttachedError();
  return { ownerId: root.ownerId, projectId: input.projectId, storageKind: root.storageKind, relativeRoot: root.relativeRoot };
}
