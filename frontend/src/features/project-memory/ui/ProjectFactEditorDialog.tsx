import { useEffect, useRef, useState } from 'react';

import type { ProjectFact, ProjectFactDraft } from '@/entities/project-fact';
import type { ProjectFactDraftErrors } from '@/features/project-memory/model/project-fact-validation';
import { validateProjectFactDraft } from '@/features/project-memory/model/project-fact-validation';
import { Alert, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, Label, Textarea } from '@/shared/ui';

export type FactEditorSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'conflict'; readonly latest: ProjectFact | null }
  | { readonly status: 'error'; readonly message: string; readonly fieldErrors?: ProjectFactDraftErrors };

interface ProjectFactEditorDialogProps {
  readonly projectName: string;
  readonly fact: ProjectFact | null;
  readonly saving: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (draft: ProjectFactDraft, expectedVersion: number | null) => Promise<FactEditorSaveResult>;
}

/** Usage: Mount from ProjectMemoryManager with controlled open state and a save callback that enforces the current fact version. */
export function ProjectFactEditorDialog({ projectName, fact, saving, open, onOpenChange, onSave }: ProjectFactEditorDialogProps): React.JSX.Element {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [baselineTitle, setBaselineTitle] = useState('');
  const [baselineContent, setBaselineContent] = useState('');
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProjectFactDraftErrors>({});
  const [formError, setFormError] = useState('');
  const [conflictFact, setConflictFact] = useState<ProjectFact | null>(null);
  const [conflictWithoutCurrentFact, setConflictWithoutCurrentFact] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const isEditing = fact !== null;
  const isDirty = title !== baselineTitle || content !== baselineContent;

  useEffect(() => {
    if (open) {
      setTitle(fact?.title ?? '');
      setContent(fact?.content ?? '');
      setBaselineTitle(fact?.title ?? '');
      setBaselineContent(fact?.content ?? '');
      setExpectedVersion(fact?.version ?? null);
      setFieldErrors({});
      setFormError('');
      setConflictFact(null);
      setConflictWithoutCurrentFact(false);
    }
  }, [fact?.id, open]);

  function requestClose(nextOpen: boolean): void {
    if (saving) {
      return;
    }
    if (!nextOpen && isDirty) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  async function submit(): Promise<void> {
    const draft = { title, content };
    const errors = validateProjectFactDraft(draft);
    setFieldErrors(errors);
    setFormError('');
    if (Object.keys(errors).length > 0 || saving) {
      return;
    }
    const result = await onSave(draft, expectedVersion);
    if (result.status === 'saved') {
      onOpenChange(false);
    } else if (result.status === 'conflict') {
      setConflictFact(result.latest);
      setConflictWithoutCurrentFact(result.latest === null);
      setFormError(result.latest ? 'This fact changed while you were editing it. Review the latest value before saving again.' : 'This fact is no longer active, or its current value could not be loaded. Close the editor and reload project memory before continuing.');
    } else {
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.message);
    }
  }

  function reloadLatest(): void {
    if (!conflictFact) {
      return;
    }
    setTitle(conflictFact.title);
    setContent(conflictFact.content);
    setBaselineTitle(conflictFact.title);
    setBaselineContent(conflictFact.content);
    setExpectedVersion(conflictFact.version);
    setConflictFact(null);
    setConflictWithoutCurrentFact(false);
    setFormError('');
  }

  function keepEditing(): void {
    if (!conflictFact) {
      return;
    }
    setExpectedVersion(conflictFact.version);
    setConflictFact(null);
    setConflictWithoutCurrentFact(false);
    setFormError('');
  }

  const sourceLabel = fact?.source.label ?? 'Added by you';
  return (
    <>
      <DialogRoot open={open} onOpenChange={requestClose}>
        <DialogContent data-testid="project-fact-editor-dialog" aria-busy={saving || undefined} onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus(); }}>
          <DialogTitle>{isEditing ? 'Edit fact' : 'Add a fact'}</DialogTitle>
          <DialogDescription>Saving updates this project fact and does not send a request. If included, the saved value is available to future permitted runs. Past messages and provider requests are unchanged.</DialogDescription>
          <form className="project-fact-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="field-group">
              <Label htmlFor="project-fact-title">Fact name</Label>
              <Input ref={titleRef} id="project-fact-title" data-testid="project-fact-title" value={title} maxLength={120} aria-required="true" aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? 'project-fact-title-error' : 'project-fact-title-help'} disabled={saving} onChange={(event) => { setTitle(event.target.value); setFieldErrors((current) => ({ ...current, title: undefined })); setFormError(''); }} />
              <p id="project-fact-title-help" className="field-help">For example: Preferred language.</p>
              {fieldErrors.title ? <p id="project-fact-title-error" className="field-error" role="alert">{fieldErrors.title}</p> : null}
            </div>
            <div className="field-group">
              <Label htmlFor="project-fact-content">What should the assistant know?</Label>
              <Textarea id="project-fact-content" data-testid="project-fact-content" value={content} rows={5} aria-required="true" aria-invalid={Boolean(fieldErrors.content)} aria-describedby={fieldErrors.content ? 'project-fact-content-error' : 'project-fact-content-help'} disabled={saving} onChange={(event) => { setContent(event.target.value); setFieldErrors((current) => ({ ...current, content: undefined })); setFormError(''); }} />
              <p id="project-fact-content-help" className="field-help">For example: This project uses TypeScript.</p>
              {fieldErrors.content ? <p id="project-fact-content-error" className="field-error" role="alert">{fieldErrors.content}</p> : null}
            </div>
            <div className="field-group">
              <Label htmlFor="project-fact-source">Source</Label>
              <output id="project-fact-source" className="project-fact-source-readonly">{sourceLabel}</output>
              <p className="field-help">Source attribution is recorded by the app and cannot be changed here.</p>
            </div>
            {conflictFact ? <ConflictDetails fact={conflictFact} onReloadLatest={reloadLatest} onKeepEditing={keepEditing} /> : null}
            {conflictWithoutCurrentFact ? <Alert tone="warning" data-testid="project-fact-missing-conflict" role="alert">
              <p>{formError}</p>
              <Button type="button" variant="secondary" data-testid="project-fact-missing-conflict-close" onClick={() => requestClose(false)}>Close editor and return to project memory</Button>
            </Alert> : null}
            {formError && !conflictFact && !conflictWithoutCurrentFact ? <Alert tone="error" data-testid="project-fact-form-error" role="alert">{formError}</Alert> : null}
            {formError && conflictFact ? <p className="field-error" role="alert">{formError}</p> : null}
            {saving ? <p className="form-status" role="status" aria-live="polite">Saving fact…</p> : null}
            <div className="dialog-actions">
              <Button type="button" variant="secondary" data-testid="project-fact-editor-cancel" disabled={saving} onClick={() => requestClose(false)}>Cancel</Button>
              <Button type="submit" data-testid="project-fact-save" aria-busy={saving} disabled={saving || isEditing && expectedVersion === null || conflictFact !== null || conflictWithoutCurrentFact}>{saving ? 'Saving…' : isEditing ? 'Save changes' : 'Save fact'}</Button>
            </div>
          </form>
        </DialogContent>
      </DialogRoot>
      <AlertDialogRoot open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent data-testid="project-fact-discard-dialog">
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>Your changes to this fact have not been saved.</AlertDialogDescription>
          <div className="dialog-actions">
            <Button type="button" variant="secondary" data-testid="project-fact-discard-keep-editing" onClick={() => setDiscardOpen(false)}>Keep editing</Button>
            <Button type="button" variant="destructive" data-testid="project-fact-discard-confirm" onClick={() => { setDiscardOpen(false); onOpenChange(false); }}>Discard changes</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </>
  );
}

function ConflictDetails({ fact, onReloadLatest, onKeepEditing }: { readonly fact: ProjectFact; readonly onReloadLatest: () => void; readonly onKeepEditing: () => void }): React.JSX.Element {
  return (
    <Alert tone="warning" data-testid="project-fact-version-conflict">
      <p>The latest saved value is shown here. Choose how to continue.</p>
      <dl><dt>Latest fact name</dt><dd>{fact.title}</dd><dt>Latest value</dt><dd className="memory-fact-value">{fact.content}</dd></dl>
      <div className="dialog-actions">
        <Button type="button" variant="secondary" data-testid="project-fact-conflict-reload" onClick={onReloadLatest}>Reload latest</Button>
        <Button type="button" data-testid="project-fact-conflict-keep-editing" onClick={onKeepEditing}>Keep editing</Button>
      </div>
    </Alert>
  );
}
