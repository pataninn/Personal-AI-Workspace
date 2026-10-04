import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProjects, removeProject } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button } from '@/shared/ui';
import { ApiClientError } from '@/shared/api';

interface RemoveProjectDialogProps {
  readonly project: ProjectSnapshot | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemoved: () => void;
}

/** Permanently remove app records while retaining the user's project folder. */
export function RemoveProjectDialog({ project, onOpenChange, onRemoved }: RemoveProjectDialogProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const csrfToken = useAppSelector(selectCsrfToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);

  async function confirm(): Promise<void> {
    if (!project || !csrfToken || busy) return;
    setBusy(true); setError(null);
    try {
      await removeProject(project.id, project.version, csrfToken);
      await dispatch(loadProjects());
      onRemoved();
    } catch (failure: unknown) {
      if (failure instanceof ApiClientError && failure.code === 'PROJECT_REMOVAL_CLEANUP_PENDING') {
        setCleanupPending(true);
        await dispatch(loadProjects());
        onRemoved();
        return;
      }
      setError(failure instanceof Error ? failure.message : 'The project could not be removed. Try again.');
    } finally { setBusy(false); }
  }

  return <AlertDialogRoot open={project !== null || cleanupPending} onOpenChange={(open) => { if (!busy) { setError(null); setCleanupPending(false); onOpenChange(open); } }}>
    <AlertDialogContent data-testid="project-remove-dialog" aria-describedby="project-remove-description" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <AlertDialogTitle>{cleanupPending ? 'Project removed' : `Remove ${project?.name}?`}</AlertDialogTitle>
      <AlertDialogDescription id="project-remove-description">{cleanupPending ? 'The project was removed and its folder was kept. Some recovery backups could not be deleted yet. Restart the app to retry cleanup.' : "This permanently deletes the project's chats, tasks, saved context, memory, activity, file history and recovery backups. The project folder and its files stay on your computer. This cannot be undone."}</AlertDialogDescription>
      {error ? <p role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <AlertDialogCancel asChild><Button type="button" variant="secondary" data-testid="project-remove-cancel" disabled={busy}>{cleanupPending ? 'Close' : 'Keep project'}</Button></AlertDialogCancel>
        {!cleanupPending ? <Button type="button" variant="destructive" data-testid="project-remove-confirm" disabled={busy || !csrfToken} aria-busy={busy} onClick={() => { void confirm(); }}>{busy ? 'Removing...' : 'Remove project'}</Button> : null}
      </div>
    </AlertDialogContent>
  </AlertDialogRoot>;
}
