import { useEffect, useRef, useState } from 'react';

import { useAppDispatch } from '@/app/store/hooks';
import { projectCreated, createProject } from '@/entities/project';
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
  Input,
  Label
} from '@/shared/ui';
import { useAppSelector } from '@/app/store/hooks';
import { hasProjectDraftErrors, validateProjectDraft, type ProjectDraftErrors } from '@/features/project-management/model/project-validation';

interface CreateProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetryBoundary: () => void;
  readonly onCreated: (projectId: string) => void;
}

function messageForError(error: ApiClientError): { field?: keyof ProjectDraftErrors; message: string } {
  if (error.code === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return { message: 'The authoritative workspace is unavailable, so a project cannot be created safely. Check the local workspace setup, then try again.' };
  }
  if (error.code === 'PROJECT_ROOT_OVERLAP') {
    return { field: 'relativeRoot', message: 'This folder is already used by another active project. Choose a different relative root.' };
  }
  if (error.code === 'PROJECT_ROOT_PROTECTED' || error.code === 'PROJECT_ROOT_REPARSE_POINT') {
    return { field: 'relativeRoot', message: 'This folder cannot be used as a project root. Choose a normal child folder inside the workspace.' };
  }
  if (error.code === 'PROJECT_ROOT_NOT_FOUND') {
    return { field: 'relativeRoot', message: 'Choose an existing folder inside the workspace.' };
  }
  if (error.code === 'PROJECT_ROOT_INVALID') {
    return { field: 'relativeRoot', message: 'Use a relative folder beneath the configured workspace.' };
  }
  if (error.code === 'PROJECT_NAME_INVALID' || error.code === 'PROJECT_NAME_CONFLICT') {
    return { field: 'name', message: error.code === 'PROJECT_NAME_CONFLICT' ? 'Choose a different project name.' : 'Enter a project name.' };
  }
  return { message: 'We could not create this project. Check the highlighted fields and try again.' };
}

export function CreateProjectDialog({ open, onOpenChange, onRetryBoundary, onCreated }: CreateProjectDialogProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const csrfToken = useAppSelector(selectCsrfToken);
  const nameRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [relativeRoot, setRelativeRoot] = useState('');
  const [errors, setErrors] = useState<ProjectDraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [boundaryUnavailable, setBoundaryUnavailable] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setErrors({});
    setFormError(null);
    setBoundaryUnavailable(false);
  }, [open]);

  useEffect(() => {
    if (errors.name) {
      nameRef.current?.focus();
    } else if (errors.relativeRoot) {
      rootRef.current?.focus();
    }
  }, [errors]);

  async function submit(): Promise<void> {
    const nextErrors = validateProjectDraft({ name, relativeRoot });
    setErrors(nextErrors);
    setFormError(null);
    if (hasProjectDraftErrors(nextErrors) || !csrfToken || isCreating) {
      return;
    }
    setIsCreating(true);
    try {
      const project = await createProject({ name, relativeRoot }, csrfToken);
      dispatch(projectCreated(project));
      onOpenChange(false);
      onCreated(project.id);
      setName('');
      setRelativeRoot('');
    } catch (error: unknown) {
      if (error instanceof ApiClientError) {
        notifySessionExpiry(error.statusCode, error.code, error);
        const mapped = messageForError(error);
        setBoundaryUnavailable(error.code === 'WORKSPACE_BOUNDARY_UNAVAILABLE');
        if (mapped.field) {
          setErrors({ [mapped.field]: mapped.message });
        } else {
          setFormError(mapped.message);
        }
      } else {
        setFormError('We could not create this project. Check the highlighted fields and try again.');
      }
    } finally {
      setIsCreating(false);
    }
  }

  const submitLabel = isCreating ? 'Creating project…' : 'Create project';
  return (
    <DialogRoot open={open} onOpenChange={(nextOpen) => !isCreating && onOpenChange(nextOpen)}>
      <DialogContent data-testid="project-create-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); nameRef.current?.focus(); }}>
        <DialogTitle>Create project</DialogTitle>
        <DialogDescription>Give this workspace area a name. The project root must be a relative folder inside the configured local workspace.</DialogDescription>
        <form className="project-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="field-group">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              ref={nameRef}
              id="project-name"
              data-testid="project-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-required="true"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'project-name-error' : 'project-name-help'}
              disabled={isCreating}
            />
            <p id="project-name-help" className="field-help">Use a short name you will recognize in the project list.</p>
            {errors.name ? <p id="project-name-error" className="field-error" data-testid="project-name-error" role="alert">{errors.name}</p> : null}
          </div>
          <div className="field-group">
            <Label htmlFor="project-relative-root">Relative project root</Label>
            <Input
              ref={rootRef}
              id="project-relative-root"
              data-testid="project-relative-root-input"
              value={relativeRoot}
              onChange={(event) => setRelativeRoot(event.target.value)}
              aria-required="true"
              aria-invalid={Boolean(errors.relativeRoot)}
              aria-describedby={errors.relativeRoot ? 'project-relative-root-error' : 'project-root-help'}
              disabled={isCreating}
            />
            <p id="project-root-help" className="field-help" data-testid="project-root-help">Examples: apps/website or notes/research. The server validates containment and keeps this root fixed after creation. Do not enter a C:\\ path, /workspace path, leading slash, .., or a protected folder.</p>
            {errors.relativeRoot ? <p id="project-relative-root-error" className="field-error" data-testid="project-relative-root-error" role="alert">{errors.relativeRoot}</p> : null}
          </div>
          <Alert tone="info">The server checks this folder when you create the project. An active project root cannot be changed later. Archive this project and create a new one to use a different root.</Alert>
          {formError ? (
            <Alert tone="error" data-testid={formError.startsWith('The authoritative') ? 'workspace-boundary-error' : 'project-create-error'}>
              <p>{formError}</p>
              {formError.startsWith('The authoritative') ? <Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={() => { setBoundaryUnavailable(false); onRetryBoundary(); }}>Try again</Button> : null}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <DialogClose asChild><Button type="button" variant="secondary" data-testid="project-create-cancel" disabled={isCreating}>Cancel</Button></DialogClose>
            <Button type="submit" data-testid="project-create-submit" aria-busy={isCreating} disabled={isCreating || boundaryUnavailable || !csrfToken}>{submitLabel}</Button>
          </div>
          <p className="sr-only" data-testid="project-create-status-message" aria-live="polite">{isCreating ? 'Creating project…' : ''}</p>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
