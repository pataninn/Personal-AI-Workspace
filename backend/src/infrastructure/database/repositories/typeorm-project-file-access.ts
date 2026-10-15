import type { DataSource } from 'typeorm';
import type { IProjectFileAccess } from '@/modules/files/repositories/project-file-access';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import { ProjectNotFoundError, ProjectRootNotAttachedError } from '@/modules/projects/domain/project-errors';
import { AppError } from '@/shared/errors/app-error';

/** Serialize manual writes with project deletion and record recent file activity. */
export class TypeOrmProjectFileAccess implements IProjectFileAccess {
  public constructor(private readonly dataSource: DataSource) {}

  public execute<T>(input: { readonly ownerId: string; readonly projectId: string; readonly writable: boolean }, action: (scope: WorkspaceProjectScope) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const rows: { id: string; relative_root: string | null; status: string }[] = await manager.query('SELECT id, relative_root, status FROM projects WHERE owner_id=$1 AND id=$2 FOR UPDATE', [input.ownerId, input.projectId]);
      const project = rows[0];
      if (!project) throw new ProjectNotFoundError();
      if (project.relative_root === null) throw new ProjectRootNotAttachedError();
      if (input.writable) {
        if (project.status === 'archived') throw new AppError('PROJECT_READ_ONLY', 409, 'This project is read-only.');
        const busy: { id: string }[] = await manager.query("SELECT id FROM ai_runs WHERE owner_id=$1 AND project_id=$2 AND (status IN ('pending_approval','staging','ready','queued','running','waiting_approval','cancel_requested','review_required') OR cleanup='unknown') LIMIT 1", [input.ownerId, input.projectId]);
        if (busy.length) throw new AppError('PROJECT_FILES_BUSY', 409, 'Finish or cancel the current assistant run before changing files.');
        const changes: { id: string }[] = await manager.query("SELECT id FROM ai_run_change_sets WHERE owner_id=$1 AND project_id=$2 AND status IN ('awaiting_approval','applying','needs_manual_review') LIMIT 1", [input.ownerId, input.projectId]);
        const commands: { id: string }[] = await manager.query("SELECT id FROM sandbox_commands WHERE owner_id=$1 AND project_id=$2 AND status IN ('awaiting_approval','running','cancel_requested','review_required') LIMIT 1", [input.ownerId, input.projectId]);
        if (changes.length || commands.length) throw new AppError('PROJECT_FILES_BUSY', 409, 'Resolve pending file changes or commands before changing files.');
      }
      const result = await action({ projectId: project.id, relativeRoot: project.relative_root });
      if (input.writable) await manager.query('UPDATE projects SET updated_at=now() WHERE owner_id=$1 AND id=$2', [input.ownerId, input.projectId]);
      return result;
    });
  }
}
