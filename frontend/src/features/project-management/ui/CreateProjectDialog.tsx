import { useEffect, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector, useAppStore } from '@/app/store/hooks';
import { createProject, projectCreated, type ProjectWorkspaceMode } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError, notifySessionExpiry } from '@/shared/api';
import {
  Alert,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  Icon,
  Input,
  Label
} from '@/shared/ui';
import { hasProjectDraftErrors, validateProjectDraft } from '@/features/project-management/model/project-validation';

interface CreateProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (projectId: string) => void;
}

function messageForError(error: ApiClientError): string {
  if (error.code === 'WORKSPACE_STORAGE_UNAVAILABLE') {
    return 'We could not create this project safely. Try again.';
  }
  if (error.code === 'PROJECT_NAME_INVALID' || error.code === 'PROJECT_NAME_CONFLICT') {
    return error.code === 'PROJECT_NAME_CONFLICT' ? 'Choose a different project name.' : 'Enter a project name.';
  }
  return 'We could not create this project. Try again.';
}

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const appStore = useAppStore();
  const csrfToken = useAppSelector(selectCsrfToken);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<ProjectWorkspaceMode>('file_backed');
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNameError(null);
    setFormError(null);
    setStorageUnavailable(false);
  }, [open]);

  useEffect(() => {
    if (nameError) nameRef.current?.focus();
  }, [nameError]);

  async function submit(): Promise<void> {
    const nextErrors = validateProjectDraft({ name });
    setNameError(nextErrors.name ?? null);
    setFormError(null);
    setStorageUnavailable(false);
    if (hasProjectDraftErrors(nextErrors) || !csrfToken || isCreating) return;

    setIsCreating(true);
    const generation = appStore.getState().project.generation ?? 0;
    const isCurrent = (): boolean => generation === (appStore.getState().project.generation ?? 0);
    try {
      const project = await createProject({ name, workspaceMode }, csrfToken);
      if (!isCurrent()) return;
      dispatch(projectCreated(project, generation));
      onOpenChange(false);
      onCreated(project.id);
      setName('');
      setWorkspaceMode('file_backed');
    } catch (error: unknown) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError) {
        notifySessionExpiry(error.statusCode, error.code, error);
        setStorageUnavailable(error.code === 'WORKSPACE_STORAGE_UNAVAILABLE');
        if (error.code === 'PROJECT_NAME_INVALID' || error.code === 'PROJECT_NAME_CONFLICT') {
          setNameError(messageForError(error));
        } else {
          setFormError(messageForError(error));
        }
      } else {
        setFormError('We could not create this project. Try again.');
      }
    } finally {
      if (isCurrent()) setIsCreating(false);
    }
  }

  const submitLabel = isCreating ? 'Creating project…' : 'Create project';
  const modeDescription = workspaceMode === 'file_backed'
    ? 'The app manages a private folder for files and file-based runs.'
    : 'Files and file-based runs are unavailable. Tasks, memory, and planning assistance remain available where enabled.';

  return (
    <DialogRoot open={open} onOpenChange={(nextOpen) => !isCreating && onOpenChange(nextOpen)}>
      <DialogContent data-testid="project-create-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); nameRef.current?.focus(); }}>
        <div className="create-project-decoration"><span aria-hidden="true"><Icon name="plus" size={24} /></span><DialogClose asChild><Button type="button" variant="ghost" className="dialog-icon-close" aria-label="Close new project dialog" disabled={isCreating}><Icon name="close" size={20} /></Button></DialogClose></div>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>Choose the workspace features for this project.</DialogDescription>
        <form className="project-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="field-group">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              ref={nameRef}
              id="project-name"
              data-testid="project-name-input"
              placeholder="e.g. Website redesign"
              value={name}
              onChange={(event) => { setName(event.target.value); setNameError(null); }}
              aria-required="true"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'project-name-error' : 'project-name-help'}
              disabled={isCreating}
            />
            <p id="project-name-help" className="sr-only">Use a short name you will recognize in the project list.</p>
            {nameError ? <p id="project-name-error" className="field-error" data-testid="project-name-error" role="alert">{nameError}</p> : null}
          </div>
          <div className="field-group">
            <Label htmlFor="project-workspace-mode">Workspace features</Label>
            <select
              id="project-workspace-mode"
              className="field-select"
              data-testid="project-workspace-mode-select"
              value={workspaceMode}
              onChange={(event) => { setWorkspaceMode(event.target.value as ProjectWorkspaceMode); setFormError(null); setStorageUnavailable(false); }}
              aria-describedby="project-workspace-mode-help"
              disabled={isCreating}
            >
              <option value="file_backed">Files and file tools</option>
              <option value="planning">Planning only</option>
            </select>
            <p id="project-workspace-mode-help" className="field-help" data-testid="project-workspace-mode-help">{modeDescription}</p>
          </div>
          {formError ? (
            <Alert tone="error" data-testid={storageUnavailable ? 'workspace-storage-error' : 'project-create-error'} role="alert">
              <p>{formError}</p>
              {storageUnavailable ? <Button type="button" variant="secondary" data-testid="workspace-storage-retry-button" onClick={() => { void submit(); }} disabled={isCreating || !csrfToken}>Try again</Button> : null}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <DialogClose asChild><Button type="button" variant="secondary" data-testid="project-create-cancel" disabled={isCreating}>Cancel</Button></DialogClose>
            <Button type="submit" data-testid="project-create-submit" aria-busy={isCreating} disabled={isCreating || !csrfToken}>{submitLabel}</Button>
          </div>
          <p className="sr-only" data-testid="project-create-status-message" aria-live="polite">{isCreating ? 'Creating project…' : ''}</p>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
