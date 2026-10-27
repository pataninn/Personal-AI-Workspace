import { useEffect, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector, useAppStore } from '@/app/store/hooks';
import { projectStatusUpdated, updateProjectStatus, type ProjectSnapshot } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError, notifySessionExpiry } from '@/shared/api';
import {
  Alert,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
  Button
} from '@/shared/ui';

interface ArchiveProjectDialogProps {
  readonly project: ProjectSnapshot | null;
  readonly mode?: 'archive' | 'restore';
  readonly onOpenChange: (open: boolean) => void;
  readonly onCompleted: (project: ProjectSnapshot) => void;
  readonly onRetryBoundary?: () => void;
}

export function ArchiveProjectDialog({ project, mode = 'archive', onOpenChange, onCompleted, onRetryBoundary }: ArchiveProjectDialogProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const appStore = useAppStore();
  const csrfToken = useAppSelector(selectCsrfToken);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundaryUnavailable, setBoundaryUnavailable] = useState(false);
  const isRestore = mode === 'restore';

  useEffect(() => {
    if (project) {
      setError(null);
      setBoundaryUnavailable(false);
    }
  }, [project]);

  useEffect(() => {
    if (boundaryUnavailable) {
      retryRef.current?.focus();
    }
  }, [boundaryUnavailable]);

  async function confirm(): Promise<void> {
    if (!project || !csrfToken || isPending) {
      return;
    }
    setIsPending(true);
    const generation = appStore.getState().project.generation ?? 0;
    const isCurrent = (): boolean => generation === (appStore.getState().project.generation ?? 0);
    setError(null);
    try {
      const updated = await updateProjectStatus(project.id, isRestore ? 'active' : 'archived', project.version, csrfToken);
      if (!isCurrent()) return;
      dispatch(projectStatusUpdated(updated, generation));
      onOpenChange(false);
      onCompleted(updated);
    } catch (caught: unknown) {
      if (!isCurrent()) return;
      if (caught instanceof ApiClientError) {
        notifySessionExpiry(caught.statusCode, caught.code, caught);
      }
      const message = caught instanceof ApiClientError && caught.code === 'WORKSPACE_BOUNDARY_UNAVAILABLE'
        ? `The authoritative workspace is unavailable, so this project cannot be ${isRestore ? 'restored' : 'archived'} safely. Check the local workspace setup, then try again.`
        : isRestore ? 'We could not restore this project. Try again.' : 'We could not archive this project. Try again.';
      setError(message);
      setBoundaryUnavailable(caught instanceof ApiClientError && caught.code === 'WORKSPACE_BOUNDARY_UNAVAILABLE');
      if (caught instanceof ApiClientError && caught.code === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
        retryRef.current?.focus();
      } else {
        confirmRef.current?.focus();
      }
    } finally {
      if (isCurrent()) setIsPending(false);
    }
  }

  return (
    <AlertDialogRoot open={project !== null} onOpenChange={(open) => !isPending && onOpenChange(open)}>
      <AlertDialogContent data-testid="project-archive-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}>
        <AlertDialogTitle>{isRestore ? 'Restore project?' : 'Archive project?'}</AlertDialogTitle>
        <AlertDialogDescription>{isRestore ? 'Restoring makes this project available for new work again without changing its immutable root.' : 'Archiving preserves this project’s history but blocks new runs and mutations. The root remains fixed and can only be used again through restore if the boundary is still safe.'}</AlertDialogDescription>
        {error ? (
          <Alert tone="error" data-testid={error.startsWith('The authoritative') ? 'workspace-boundary-error' : isRestore ? 'project-restore-error' : 'project-archive-error'} role="alert">
            <p>{error}</p>
            {boundaryUnavailable ? <Button ref={retryRef} type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={() => { setBoundaryUnavailable(false); onRetryBoundary?.(); retryRef.current?.focus(); }}>Try again</Button> : null}
          </Alert>
        ) : null}
        <div className="dialog-actions">
          <AlertDialogCancel asChild><Button ref={cancelRef} type="button" variant="secondary" data-testid={isRestore ? 'project-restore-cancel' : 'project-archive-cancel'} disabled={isPending}>{isRestore ? 'Keep archived' : 'Keep project'}</Button></AlertDialogCancel>
          <Button ref={confirmRef} type="button" variant={isRestore ? 'primary' : 'destructive'} data-testid={isRestore ? 'project-restore-confirm' : 'project-archive-confirm'} aria-busy={isPending} disabled={isPending || boundaryUnavailable || !csrfToken} onClick={() => { void confirm(); }}>{isPending ? `${isRestore ? 'Restoring' : 'Archiving'}…` : isRestore ? 'Restore project' : 'Archive project'}</Button>
        </div>
        <p className="sr-only" data-testid={isRestore ? 'project-restore-status-message' : 'project-archive-status-message'} aria-live="polite">{isPending ? `${isRestore ? 'Restoring' : 'Archiving'} project…` : ''}</p>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
