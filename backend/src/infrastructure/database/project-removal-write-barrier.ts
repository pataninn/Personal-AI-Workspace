import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

export interface ProjectWriteState {
  readonly status: 'active' | 'archived';
  readonly relativeRoot: string | null;
  readonly removalPending: boolean;
}

/**
 * Serializes project-scoped writers with removal. Lock the project first, then
 * read the durable job in a separate statement so a writer that waited for a
 * removal transaction receives a fresh READ COMMITTED snapshot.
 */
export async function lockProjectWriteState(
  transaction: StorageQuotaTransaction,
  ownerId: string,
  projectId: string
): Promise<ProjectWriteState | null> {
  const projects = await transaction.query(
    'SELECT "status", "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE',
    [ownerId, projectId]
  ) as readonly { readonly status: ProjectWriteState['status']; readonly relative_root: string | null }[];
  const project = projects[0];
  if (!project) return null;

  const jobs = await transaction.query(
    'SELECT "project_id" FROM "project_removal_jobs" WHERE "owner_id" = $1 AND "project_id" = $2 LIMIT 1',
    [ownerId, projectId]
  ) as readonly { readonly project_id: string }[];
  return { status: project.status, relativeRoot: project.relative_root, removalPending: jobs.length > 0 };
}
