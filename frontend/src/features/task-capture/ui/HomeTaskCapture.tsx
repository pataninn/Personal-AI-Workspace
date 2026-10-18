import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { createGlobalTask, type GlobalTaskCreateDraft } from '@/entities/project-task';
import type { ProjectSnapshot } from '@/entities/project';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Input, Label } from '@/shared/ui';

interface HomeTaskCaptureProps {
  readonly isOpen: boolean;
  readonly csrfToken: string | null;
  readonly workspaces: readonly ProjectSnapshot[];
  readonly workspaceStatus: 'loading' | 'success' | 'error';
  readonly onCreated?: () => void;
  readonly onClose: () => void;
}

interface CaptureIntent {
  readonly draft: GlobalTaskCreateDraft;
  readonly idempotencyKey: string;
}

/** Capture one task from Home, leaving its workspace optional. */
export function HomeTaskCapture({ isOpen, csrfToken, workspaces, workspaceStatus, onCreated, onClose }: HomeTaskCaptureProps): React.JSX.Element {
  const titleRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<CaptureIntent | null>(null);
  const [title, setTitle] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);

  useEffect(() => { if (isOpen) titleRef.current?.focus(); }, [isOpen]);

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (saving || !csrfToken) return;
    const normalizedTitle = title.trim();
    if (!normalizedTitle || Array.from(normalizedTitle).length > 120) {
      setTitleError('Enter a task title of 1 to 120 characters.');
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setSavedTaskId(null);
    const intent = intentRef.current ?? {
      draft: { title: normalizedTitle, details: null, workspaceId: workspaceId || null },
      idempotencyKey: globalThis.crypto.randomUUID()
    };
    intentRef.current = intent;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await createGlobalTask(intent.draft, csrfToken, intent.idempotencyKey);
      intentRef.current = null;
      setTitle('');
      setWorkspaceId('');
      setSavedTaskId(result.item.task.id);
      onCreated?.();
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode >= 400 && error.statusCode < 500) intentRef.current = null;
      setSaveError('The task could not be added. Check the title and workspace, then try again.');
    } finally {
      setSaving(false);
    }
  }

  function resetFeedback(): void {
    intentRef.current = null;
    setTitleError(null);
    setSaveError(null);
    setSavedTaskId(null);
  }

  const unresolved = saveError !== null && intentRef.current !== null;
  const disabled = saving || unresolved || !csrfToken;
  const availableWorkspaces = workspaces.filter((workspace) => workspace.status === 'active' && workspace.workspaceMode !== 'file_backed');

  return <form id="home-task-capture-form" className={`${isOpen ? 'mt-4 grid' : 'hidden'} min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end`} data-testid="home-task-capture-form" aria-busy={saving || undefined} hidden={!isOpen} onSubmit={(event) => { void submit(event); }} noValidate>
    <div className="field-group min-w-0 sm:col-span-2">
      <Label htmlFor="home-task-title">Task title</Label>
      <Input ref={titleRef} id="home-task-title" data-testid="home-task-title" value={title} maxLength={120} disabled={disabled}
        aria-required="true" aria-invalid={Boolean(titleError)} aria-describedby={titleError ? 'home-task-title-error' : 'home-task-title-help'}
        onChange={(event) => { setTitle(event.currentTarget.value); resetFeedback(); }} />
      {titleError ? <p id="home-task-title-error" className="field-error" role="alert">{titleError}</p> : <p id="home-task-title-help" className="supporting-copy">Add a title, then organize it any time.</p>}
    </div>
    <div className="field-group min-w-0">
      <Label htmlFor="home-task-workspace">Workspace (optional)</Label>
      <select id="home-task-workspace" className="input min-h-11 w-full" data-testid="home-task-workspace" value={workspaceId} disabled={disabled}
        onChange={(event) => { setWorkspaceId(event.currentTarget.value); resetFeedback(); }}>
        <option value="">Unassigned</option>
        {availableWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
      {workspaceStatus === 'loading' ? <p className="supporting-copy" role="status">Loading workspace choices…</p> : null}
      {workspaceStatus === 'error' ? <p className="supporting-copy">Workspace choices are unavailable. You can still add this task as Unassigned.</p> : null}
    </div>
    <div className="flex flex-wrap gap-2 sm:justify-end">
      <Button type="button" variant="secondary" data-testid="home-task-capture-cancel" disabled={saving} onClick={onClose}>Cancel</Button>
      <Button type="submit" data-testid="home-task-capture-submit" disabled={disabled} aria-busy={saving || undefined}>{saving ? 'Adding…' : 'Add task'}</Button>
    </div>
    {saveError ? <Alert className="sm:col-span-2" tone="error" role="alert" data-testid="home-task-capture-error"><p>{saveError}</p>{unresolved ? <Button type="button" variant="secondary" data-testid="home-task-capture-retry" onClick={() => { void submit(); }}>Retry add</Button> : null}</Alert> : null}
    <p className="sr-only" role="status" aria-live="polite">{saving ? 'Adding task…' : savedTaskId ? 'Task added.' : ''}</p>
    {savedTaskId ? <p className="supporting-copy sm:col-span-2" data-testid="home-task-capture-success"><strong>Task added.</strong> <Link data-testid="home-task-capture-view-task" to={`/tasks/${encodeURIComponent(savedTaskId)}`}>View task</Link></p> : null}
    {!csrfToken ? <p className="supporting-copy sm:col-span-2" role="status">Your session is unavailable. Sign in again before adding a task.</p> : null}
  </form>;
}
