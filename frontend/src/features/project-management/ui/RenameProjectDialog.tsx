import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, loadProjects, renameProject, type ProjectSnapshot } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError, notifySessionExpiry } from '@/shared/api';
import { Alert, Button, DialogClose, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, Label } from '@/shared/ui';

interface RenameProjectDialogProps {
  readonly project: ProjectSnapshot;
  readonly onClose: () => void;
}

export function RenameProjectDialog({ project, onClose }: RenameProjectDialogProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const csrfToken = useAppSelector(selectCsrfToken);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(): Promise<void> {
    if (busy || !csrfToken) return;
    if (!name.trim() || name.trim().length > 120) { setError('Enter a workspace name between 1 and 120 characters.'); return; }
    setBusy(true); setError(null);
    try {
      await renameProject(project.id, name.trim(), project.version, csrfToken);
      await Promise.all([dispatch(loadProjects()), dispatch(loadProject(project.id))]);
      onClose();
    } catch (failure: unknown) {
      if (failure instanceof ApiClientError) notifySessionExpiry(failure.statusCode, failure.code, failure);
      setError(failure instanceof ApiClientError && failure.code === 'PROJECT_VERSION_CONFLICT'
        ? 'This workspace changed. Close this dialog, refresh the page, and try again.'
        : failure instanceof ApiClientError && failure.code === 'PROJECT_NAME_CONFLICT'
          ? 'A workspace with this name already exists. Choose another name.'
          : failure instanceof Error ? failure.message : 'The workspace could not be renamed. Try again.');
    } finally { setBusy(false); }
  }

  return <DialogRoot open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}>
      <DialogTitle>Rename workspace</DialogTitle>
      <DialogDescription>Choose a name you will recognize in your workspace list.</DialogDescription>
      <form className="project-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="field-group">
          <Label htmlFor="rename-workspace-name">Workspace name</Label>
          <Input ref={inputRef} id="rename-workspace-name" value={name} onChange={(event) => { setName(event.target.value); setError(null); }} maxLength={120} required disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'rename-workspace-error' : undefined} />
        </div>
        {error ? <Alert tone="error" role="alert" id="rename-workspace-error">{error}</Alert> : null}
        <div className="dialog-actions">
          <DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose>
          <Button type="submit" disabled={busy || !csrfToken || !name.trim() || name.trim() === project.name} aria-busy={busy}>{busy ? 'Saving...' : 'Save name'}</Button>
        </div>
      </form>
    </DialogContent>
  </DialogRoot>;
}
