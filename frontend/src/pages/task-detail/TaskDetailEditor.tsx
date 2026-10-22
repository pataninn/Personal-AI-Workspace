import { useEffect, useRef, useState } from 'react';

import type { ProjectTask, ProjectTaskDraft } from '@/entities/project-task';
import { TaskMetadataFields } from '@/features/project-tasks/ui/TaskMetadataFields';
import { TaskVersionConflict } from '@/features/project-tasks/ui/TaskVersionConflict';
import { isProjectTaskEditorDraftDirty, rebaseProjectTaskEditorDraft, validateProjectTaskDraft } from '@/features/project-tasks/model/project-task-validation';
import type { ProjectTaskEditorDraft, ProjectTaskFieldErrors, TaskMetadataDraft } from '@/features/project-tasks/model/project-task-validation';
import type { TaskEditorSaveResult } from '@/features/project-tasks/ui/TaskEditorDialog';
import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, Input, Label, Textarea } from '@/shared/ui';

interface TaskDetailEditorProps {
  readonly renderHeader: (actions: React.ReactNode) => React.ReactNode;
  readonly task: ProjectTask;
  readonly saving: boolean;
  readonly resetNonce: number;
  readonly unavailable: boolean;
  readonly onSave: (draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null, baseline: ProjectTask | null) => Promise<TaskEditorSaveResult>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCancelRequest: () => void;
  readonly onTaskUnavailable: () => void;
}

export function TaskDetailEditor({ renderHeader, task, saving, resetNonce, unavailable, onSave, onDirtyChange, onCancelRequest, onTaskUnavailable }: TaskDetailEditorProps): React.JSX.Element {
  const [baseline, setBaseline] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [details, setDetails] = useState(task.details ?? '');
  const [metadata, setMetadata] = useState<TaskMetadataDraft>(() => metadataFor(task));
  const [fieldErrors, setFieldErrors] = useState<ProjectTaskFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<ProjectTask | null | undefined>(undefined);
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIntentKey);
  const previousResetNonce = useRef(resetNonce);
  const draft: ProjectTaskEditorDraft = { title, details, metadata };
  const dirty = isProjectTaskEditorDraftDirty(baseline, draft);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (previousResetNonce.current === resetNonce) return;
    previousResetNonce.current = resetNonce;
    resetTo(baseline);
  }, [resetNonce]);

  useEffect(() => {
    if (!dirty && task.version !== baseline.version) resetTo(task);
  }, [task, task.version, baseline.version, dirty]);

  function resetTo(nextTask: ProjectTask): void {
    setBaseline(nextTask);
    setTitle(nextTask.title);
    setDetails(nextTask.details ?? '');
    setMetadata(metadataFor(nextTask));
    setFieldErrors({});
    setError(null);
    setNotice('');
    setConflict(undefined);
    setIdempotencyKey(createIntentKey());
  }

  function updateDraft(next: ProjectTaskEditorDraft): void {
    setTitle(next.title);
    setDetails(next.details);
    setMetadata(next.metadata);
    setIdempotencyKey(createIntentKey());
    setFieldErrors({});
    setError(null);
    setNotice('');
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateProjectTaskDraft(title, details, metadata);
    setFieldErrors(validation.errors);
    setError(null);
    setNotice('');
    if (Object.keys(validation.errors).length > 0) {
      focusInvalidField(validation.errors);
      return;
    }

    const result = await onSave(validation.draft, idempotencyKey, baseline.version, baseline);
    if (result.status === 'saved') {
      const savedTask = result.task ?? task;
      setBaseline(savedTask);
      setTitle(savedTask.title);
      setDetails(savedTask.details ?? '');
      setMetadata(metadataFor(savedTask));
      setFieldErrors({});
      setError(null);
      setNotice('Task saved.');
      setConflict(undefined);
      setIdempotencyKey(createIntentKey());
      return;
    }
    if (result.status === 'conflict') {
      setConflict(result.latest);
      if (result.latest === null) onTaskUnavailable();
      return;
    }
    setError(result.message);
    setFieldErrors(result.fieldErrors ?? {});
    if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) focusInvalidField(result.fieldErrors);
  }

  function reloadLatest(): void {
    if (!conflict) return;
    resetTo(conflict);
    setReloadPrompt(false);
  }

  function keepDraft(): void {
    if (!conflict) return;
    const rebased = rebaseProjectTaskEditorDraft(baseline, conflict, draft);
    setTitle(rebased.title);
    setDetails(rebased.details);
    setMetadata(rebased.metadata);
    setBaseline(conflict);
    setConflict(undefined);
    setFieldErrors({});
    setError(null);
    setIdempotencyKey(createIntentKey());
    setNotice('Your draft is preserved. A separate Save will use the latest task version.');
  }

  const saveDisabled = saving || unavailable || !dirty || conflict !== undefined || Object.keys(fieldErrors).length > 0;
  const saveLabel = saving ? 'Saving…' : error?.includes('uncertain') ? 'Retry save' : 'Save';

  return <>
    {renderHeader(<>
          <Button type="submit" form="task-detail-form" data-testid="task-detail-save" disabled={saveDisabled} aria-busy={saving || undefined}>{saveLabel}</Button>
          <Button type="button" variant="secondary" data-testid="task-detail-cancel" disabled={!dirty || saving} onClick={onCancelRequest}>Cancel</Button>
    </>)}
    <section className="task-detail-editor" data-testid="task-detail-editor" aria-busy={saving || undefined}>
      {notice ? <p className="project-task-editor-notice" role="status" data-testid="task-save-notice">{notice}</p> : null}
      {error ? <p className="project-task-editor-error" role="alert" data-testid="task-save-error">{error}</p> : null}
      {conflict !== undefined ? <TaskVersionConflict latest={conflict} draft={draft} onReload={() => { if (dirty) setReloadPrompt(true); else reloadLatest(); }} onKeepDraft={keepDraft} /> : null}
      {unavailable ? <p className="task-detail-unavailable-draft" role="alert" data-testid="task-unavailable-draft">This task was deleted. Your unsaved text is still shown.</p> : null}
      <form id="task-detail-form" className="project-task-editor-form" onSubmit={(event) => { void submit(event); }} noValidate>
        <div className="field-group">
          <Label className="field-label" htmlFor="project-task-title">Task title <span aria-hidden="true">*</span></Label>
          <Input ref={titleRef} id="project-task-title" data-testid="project-task-title-input" value={title} onChange={(event) => { updateDraft({ ...draft, title: event.currentTarget.value }); }} required aria-required="true" aria-invalid={fieldErrors.title ? true : undefined} aria-describedby={fieldErrors.title ? 'project-task-title-error' : undefined} disabled={saving || unavailable} />
          {fieldErrors.title ? <p id="project-task-title-error" className="field-error" role="alert">{fieldErrors.title}</p> : null}
        </div>
        <div className="field-group">
          <Label className="field-label" htmlFor="project-task-details">Details (optional)</Label>
          <Textarea id="project-task-details" data-testid="project-task-details-input" value={details} onChange={(event) => { updateDraft({ ...draft, details: event.currentTarget.value }); }} aria-invalid={fieldErrors.details ? true : undefined} aria-describedby={fieldErrors.details ? 'project-task-details-error' : undefined} disabled={saving || unavailable} />
          {fieldErrors.details ? <p id="project-task-details-error" className="field-error" role="alert">{fieldErrors.details}</p> : null}
        </div>
        <TaskMetadataFields checklistMode value={metadata} disabled={saving || unavailable} errors={fieldErrors} onChange={(value) => { updateDraft({ ...draft, metadata: value }); }} />

      </form>
    </section>
    <AlertDialogRoot open={reloadPrompt} onOpenChange={setReloadPrompt}>
      <AlertDialogContent data-testid="task-conflict-reload-confirmation" aria-describedby="task-conflict-reload-description">
        <AlertDialogTitle>Reload latest task?</AlertDialogTitle>
        <AlertDialogDescription id="task-conflict-reload-description">Your draft will be replaced by the latest saved task.</AlertDialogDescription>
        <div className="dialog-actions"><AlertDialogCancel asChild><Button type="button" variant="secondary">Keep my draft</Button></AlertDialogCancel><Button type="button" variant="destructive" onClick={reloadLatest}>Reload latest</Button></div>
      </AlertDialogContent>
    </AlertDialogRoot>
  </>;
}

function metadataFor(task: ProjectTask): TaskMetadataDraft {
  return { importance: task.importance, deadline: task.deadline ?? '', subtasks: task.subtasks };
}

function createIntentKey(): string {
  return globalThis.crypto.randomUUID();
}

function focusInvalidField(errors: ProjectTaskFieldErrors): void {
  const field = errors.title ? 'title' : errors.details ? 'details' : errors.importance ? 'importance' : errors.deadline ? 'deadline' : 'subtask-0';
  document.getElementById(`project-task-${field}`)?.focus();
}
