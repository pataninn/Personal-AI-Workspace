import type { ProjectSnapshot } from '@/entities/project';
import { Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, Label } from '@/shared/ui';

interface TaskMoveDialogProps {
  readonly open: boolean;
  readonly currentLocation: string;
  readonly currentWorkspaceId: string | null;
  readonly projects: readonly ProjectSnapshot[];
  readonly projectListStatus: 'idle' | 'loading' | 'success' | 'error';
  readonly selectedWorkspaceId: string;
  readonly saving: boolean;
  readonly error: string | null;
  readonly retryable: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  readonly onWorkspaceChange: (workspaceId: string) => void;
  readonly onRetryWorkspaces: () => void;
  readonly onSubmit: () => void;
}

/** Keeps Inbox and active planning-only workspaces available as task destinations. */
export function TaskMoveDialog({
  open, currentLocation, currentWorkspaceId, projects, projectListStatus, selectedWorkspaceId, saving, error, retryable,
  onOpenChange, onCloseAutoFocus, onWorkspaceChange, onRetryWorkspaces, onSubmit
}: TaskMoveDialogProps): React.JSX.Element {
  const destinations = projects.filter((project) => project.status === 'active');
  const selectedName = destinations.find((project) => project.id === selectedWorkspaceId)?.name ?? 'Inbox';
  const canSubmit = !saving && projectListStatus === 'success' && selectedWorkspaceId !== (currentWorkspaceId ?? '');

  return <DialogRoot open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] w-full max-w-lg overflow-y-auto" data-testid="task-move-dialog" aria-describedby="task-move-description" onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle>Move task</DialogTitle>
      <DialogDescription id="task-move-description">Move this task from {currentLocation} to Inbox or an active workspace.</DialogDescription>
      <div className="field-group">
        <Label className="field-label" htmlFor="task-move-destination">Destination</Label>
        <select id="task-move-destination" data-testid="task-move-destination" className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] p-2 text-[var(--color-text)]" value={selectedWorkspaceId} disabled={saving} onChange={(event) => { onWorkspaceChange(event.currentTarget.value); }}>
          <option value="" disabled={currentWorkspaceId === null}>Inbox{currentWorkspaceId === null ? ' (current)' : ''}</option>
          {destinations.map((project) => <option key={project.id} value={project.id} disabled={project.id === currentWorkspaceId}>{project.name}{!project.capabilities.fileAccess ? ' (planning only)' : ''}{project.id === currentWorkspaceId ? ' (current)' : ''}</option>)}
        </select>
      </div>
      {projectListStatus === 'loading' ? <p role="status">Loading active workspaces…</p> : null}
      {projectListStatus === 'error' ? <p className="field-error" role="alert">Active workspaces could not be loaded. Retry before moving the task.</p> : null}
      {error ? <p className="project-task-editor-error" role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <Button type="button" variant="secondary" data-testid="task-move-cancel" disabled={saving} onClick={() => { onOpenChange(false); }}>Cancel</Button>
        {projectListStatus === 'error' ? <Button type="button" variant="secondary" data-testid="task-move-retry-workspaces" disabled={saving} onClick={onRetryWorkspaces}>Retry workspaces</Button> : null}
        <Button type="button" data-testid="task-move-submit" disabled={!canSubmit} aria-busy={saving || undefined} onClick={onSubmit}>
          {saving ? 'Moving…' : retryable ? `Retry move to ${selectedName}` : `Move to ${selectedName}`}
        </Button>
      </div>
    </DialogContent>
  </DialogRoot>;
}
