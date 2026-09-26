import { useRef, useState } from 'react';

import type { ProjectTask, ProjectTaskDraft, ProjectTaskSuggestion } from '@/entities/project-task';
import { validateProjectTaskDraft } from '@/features/project-tasks/model/project-task-validation';
import type { ProjectTaskFieldErrors } from '@/features/project-tasks/model/project-task-validation';
import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, Label, Textarea } from '@/shared/ui';

export type TaskEditorTarget =
  | { readonly kind: 'task'; readonly task: ProjectTask | null }
  | { readonly kind: 'suggestion'; readonly suggestion: ProjectTaskSuggestion };

export type TaskEditorSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'conflict'; readonly latest: ProjectTask | null }
  | { readonly status: 'error'; readonly message: string; readonly fieldErrors?: ProjectTaskFieldErrors };

interface TaskEditorDialogProps {
  readonly target: TaskEditorTarget | null;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null) => Promise<TaskEditorSaveResult>;
}

/** Usage: Open from the project task manager to add, edit, or review one explicitly accepted task draft. */
export function TaskEditorDialog({ target, saving, onOpenChange, onSave }: TaskEditorDialogProps): React.JSX.Element {
  const sourceText = target?.kind === 'suggestion' ? target.suggestion.source.label : null;
  const initialTitle = target?.kind === 'task' ? target.task?.title ?? '' : target?.suggestion.title ?? '';
  const initialDetails = target?.kind === 'task' ? target.task?.details ?? '' : target?.suggestion.details ?? '';
  const initialVersion = target?.kind === 'task' ? target.task?.version ?? null : target?.suggestion.version ?? null;
  const [title, setTitle] = useState(initialTitle);
  const [details, setDetails] = useState(initialDetails);
  const [expectedVersion, setExpectedVersion] = useState(initialVersion);
  const [fieldErrors, setFieldErrors] = useState<ProjectTaskFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ProjectTask | null | undefined>(undefined);
  const [saveNotice, setSaveNotice] = useState('');
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIntentKey);
  const titleRef = useRef<HTMLInputElement>(null);
  const originalTitle = target?.kind === 'task' ? target.task?.title ?? '' : target?.suggestion.title ?? '';
  const originalDetails = target?.kind === 'task' ? target.task?.details ?? '' : target?.suggestion.details ?? '';
  const dirty = title !== originalTitle || details !== originalDetails;
  const open = target !== null;
  const titleId = 'project-task-title';
  const detailsId = 'project-task-details';

  function changeTitle(value: string): void {
    setTitle(value);
    setIdempotencyKey(createIntentKey());
    setFieldErrors((current) => withoutField(current, 'title'));
    setError(null);
  }

  function changeDetails(value: string): void {
    setDetails(value);
    setIdempotencyKey(createIntentKey());
    setFieldErrors((current) => withoutField(current, 'details'));
    setError(null);
  }

  function requestClose(nextOpen: boolean): void {
    if (!nextOpen && dirty && !saving) {
      setDiscardPrompt(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateProjectTaskDraft(title, details);
    setFieldErrors(validation.errors);
    setError(null);
    setSaveNotice('');
    if (Object.keys(validation.errors).length > 0) {
      titleRef.current?.focus();
      return;
    }
    const result = await onSave(validation.draft, idempotencyKey, expectedVersion);
    if (result.status === 'saved') {
      onOpenChange(false);
      return;
    }
    if (result.status === 'conflict') {
      setConflict(result.latest);
      return;
    }
    setError(result.message);
    setFieldErrors(result.fieldErrors ?? {});
  }

  function reloadLatest(): void {
    if (!conflict) {
      return;
    }
    setTitle(conflict.title);
    setDetails(conflict.details ?? '');
    setExpectedVersion(conflict.version);
    setConflict(undefined);
    setFieldErrors({});
    setError(null);
    setSaveNotice('The latest task version is loaded. Review it and save your changes.');
  }

  function keepDraft(): void {
    if (!conflict) {
      return;
    }
    setExpectedVersion(conflict.version);
    setConflict(undefined);
    setSaveNotice('Your draft is preserved. Saving will use the latest task version.');
  }

  function discardChanges(): void {
    setDiscardPrompt(false);
    onOpenChange(false);
  }

  const heading = editorTitle(target);
  const saveLabel = target?.kind === 'suggestion' ? 'Add to project' : target?.task ? 'Save changes' : 'Add task';
  const busyLabel = target?.kind === 'suggestion' ? 'Adding task…' : target?.task ? 'Saving…' : 'Adding task…';

  return (
    <>
      <DialogRoot open={open} onOpenChange={requestClose}>
        <DialogContent
          data-testid="project-task-editor-dialog"
          aria-describedby="project-task-editor-description"
          onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus(); }}
        >
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription id="project-task-editor-description">
            {target?.kind === 'suggestion' ? 'Review this assistant suggestion. It will stay separate until you add it to the project.' : 'Tasks are reminders for you. They do not run automatically.'}
          </DialogDescription>
          {sourceText ? <p className="project-task-editor-source">{sourceText}</p> : null}
          {conflict !== undefined ? <TaskVersionConflict latest={conflict} onReload={reloadLatest} onKeepDraft={keepDraft} /> : null}
          {saveNotice ? <p className="project-task-editor-notice" role="status">{saveNotice}</p> : null}
          {error ? <p className="project-task-editor-error" role="alert">{error}</p> : null}
          <form className="project-task-editor-form" onSubmit={(event) => { void submit(event); }} noValidate>
            <div className="field-group">
              <Label className="field-label" htmlFor={titleId}>Task title</Label>
              <Input
                ref={titleRef}
                id={titleId}
                data-testid="project-task-title-input"
                value={title}
                onChange={(event) => { changeTitle(event.currentTarget.value); }}
                aria-required="true"
                aria-invalid={fieldErrors.title ? true : undefined}
                aria-describedby={fieldErrors.title ? 'project-task-title-error' : undefined}
                disabled={saving}
              />
              {fieldErrors.title ? <p id="project-task-title-error" className="field-error" role="alert">{fieldErrors.title}</p> : null}
            </div>
            <div className="field-group">
              <Label className="field-label" htmlFor={detailsId}>Details (optional)</Label>
              <Textarea
                id={detailsId}
                data-testid="project-task-details-input"
                value={details}
                onChange={(event) => { changeDetails(event.currentTarget.value); }}
                aria-invalid={fieldErrors.details ? true : undefined}
                aria-describedby={fieldErrors.details ? 'project-task-details-error' : undefined}
                disabled={saving}
              />
              {fieldErrors.details ? <p id="project-task-details-error" className="field-error" role="alert">{fieldErrors.details}</p> : null}
            </div>
            <div className="dialog-actions">
              <Button type="button" variant="secondary" data-testid="project-task-editor-cancel" disabled={saving} onClick={() => { requestClose(false); }}>Cancel</Button>
              <Button type="submit" data-testid="project-task-editor-save" disabled={saving || conflict === null} aria-busy={saving || undefined}>{saving ? busyLabel : saveLabel}</Button>
            </div>
          </form>
        </DialogContent>
      </DialogRoot>
      <AlertDialogRoot open={discardPrompt} onOpenChange={setDiscardPrompt}>
        <AlertDialogContent data-testid="project-task-discard-dialog" aria-describedby="project-task-discard-description">
          <AlertDialogTitle>Discard task changes?</AlertDialogTitle>
          <AlertDialogDescription id="project-task-discard-description">Your unsaved task draft will be lost.</AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogCancel asChild><Button type="button" variant="secondary" data-testid="project-task-discard-keep-editing">Keep editing</Button></AlertDialogCancel>
            <Button type="button" variant="destructive" data-testid="project-task-discard-confirm" onClick={discardChanges}>Discard changes</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </>
  );
}

function TaskVersionConflict({ latest, onReload, onKeepDraft }: {
  readonly latest: ProjectTask | null;
  readonly onReload: () => void;
  readonly onKeepDraft: () => void;
}): React.JSX.Element {
  if (!latest) {
    return <section className="project-task-version-conflict" data-testid="project-task-version-conflict" role="alert"><p>This task is no longer available to edit. Your draft remains here so you can copy it.</p></section>;
  }
  return (
    <section className="project-task-version-conflict" data-testid="project-task-version-conflict" role="alert">
      <h3>This task changed elsewhere.</h3>
      <p>Reload the latest version or keep your draft open. Review the current task before saving over it.</p>
      <dl><dt>Latest title</dt><dd>{latest.title}</dd>{latest.details ? <><dt>Latest details</dt><dd>{latest.details}</dd></> : null}</dl>
      <div className="project-task-conflict-actions">
        <Button type="button" variant="secondary" data-testid="project-task-conflict-reload" onClick={onReload}>Reload latest</Button>
        <Button type="button" variant="secondary" data-testid="project-task-conflict-keep-editing" onClick={onKeepDraft}>Keep editing my draft</Button>
      </div>
    </section>
  );
}

function editorTitle(target: TaskEditorTarget | null): string {
  if (target?.kind === 'suggestion') {
    return 'Review suggested task';
  }
  return target?.task ? 'Edit task' : 'Add task';
}

function createIntentKey(): string {
  return globalThis.crypto.randomUUID();
}

function withoutField(values: ProjectTaskFieldErrors, field: 'title' | 'details'): ProjectTaskFieldErrors {
  const next = { ...values };
  delete next[field];
  return next;
}
