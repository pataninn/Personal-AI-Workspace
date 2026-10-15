import { useEffect, useState } from 'react';

import { useProjectFacts } from '@/entities/project-fact';
import type { ProjectFact, ProjectFactDraft } from '@/entities/project-fact';
import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import { useProjectChatContext } from '@/entities/project';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Skeleton } from '@/shared/ui';
import { useProjectMemoryActions } from '@/features/project-memory/model/use-project-memory-actions';
import type { FactEditorSaveResult } from '@/features/project-memory/ui/ProjectFactEditorDialog';
import { ProjectFactDeleteDialog } from '@/features/project-memory/ui/ProjectFactDeleteDialog';
import { ProjectFactEditorDialog } from '@/features/project-memory/ui/ProjectFactEditorDialog';
import { MemoryFactItem } from '@/features/project-memory/ui/MemoryFactItem';

interface ProjectMemoryManagerProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly archived: boolean;
  readonly fileAccess: boolean;
}

interface EditorState {
  readonly fact: ProjectFact | null;
}

/** Usage: Render on a project memory page; this component coordinates fact loading and versioned create, review, edit, and delete actions. */
export function ProjectMemoryManager({ projectId, projectName, archived, fileAccess }: ProjectMemoryManagerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const chatContext = useProjectChatContext(projectId, csrfToken, fileAccess);
  const { facts, status, reload, upsertFact, removeFact } = useProjectFacts(projectId);
  const actions = useProjectMemoryActions(projectId, csrfToken);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteFact, setDeleteFact] = useState<ProjectFact | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [factActionError, setFactActionError] = useState<Readonly<Record<string, string>>>({});
  const [announcement, setAnnouncement] = useState('');
  const [pendingFactIds, setPendingFactIds] = useState<readonly string[] | null>(null);
  const archivedDescriptionId = `project-memory-archived-${projectId}`;

  useEffect(() => {
    setEditor(null);
    setDeleteFact(null);
    setDeleteError(null);
    setDeleteConflict(false);
    setFactActionError({});
    setAnnouncement('');
    setPendingFactIds(null);
  }, [projectId]);

  function openAddDialog(): void {
    setEditor({ fact: null });
  }

  function openEditDialog(fact: ProjectFact): void {
    setEditor({ fact });
  }

  async function saveFact(draft: ProjectFactDraft, expectedVersion: number | null): Promise<FactEditorSaveResult> {
    if (archived) {
      return { status: 'error', message: 'This project is archived. Its memory is read-only.' };
    }
    try {
      const saved = editor?.fact
        ? await actions.update(editor.fact.id, draft, expectedVersion ?? editor.fact.version)
        : await actions.create(draft);
      upsertFact(saved);
      setAnnouncement('Fact saved');
      void reload();
      return { status: 'saved' };
    } catch (error: unknown) {
      if (editor?.fact && isVersionConflict(error)) {
        const latestFacts = await reload();
        const latest = latestFacts?.find((fact) => fact.id === editor.fact?.id) ?? null;
        return { status: 'conflict', latest };
      }
      return mapSaveError(error);
    }
  }

  async function markReviewed(fact: ProjectFact): Promise<void> {
    setFactActionError((current) => withoutKey(current, fact.id));
    try {
      const updated = await actions.verify(fact.id, fact.version);
      upsertFact(updated);
      setAnnouncement('Fact marked as reviewed');
    } catch (error: unknown) {
      if (isVersionConflict(error)) {
        await reload();
        setFactActionError((current) => ({ ...current, [fact.id]: 'This fact changed. Review its latest value before marking it as reviewed.' }));
      } else {
        setFactActionError((current) => ({ ...current, [fact.id]: 'The review status could not be saved. Try again.' }));
      }
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteFact || archived) {
      return;
    }
    setDeleteError(null);
    try {
      await actions.remove(deleteFact.id, deleteFact.version);
      removeFact(deleteFact.id);
      setDeleteFact(null);
      setDeleteConflict(false);
      setAnnouncement('Fact deleted');
    } catch (error: unknown) {
      if (isVersionConflict(error)) {
        const latestFacts = await reload();
        const latest = latestFacts?.find((fact) => fact.id === deleteFact.id);
        if (latest) {
          setDeleteFact(latest);
          setDeleteConflict(true);
          setDeleteError(null);
        } else {
          setDeleteFact(null);
          setDeleteConflict(false);
          setDeleteError(null);
          setAnnouncement('This fact is no longer active in project memory. The list has been refreshed.');
        }
      } else {
        setDeleteError('The fact could not be deleted. Try again.');
      }
    }
  }

  function openDeleteDialog(fact: ProjectFact): void {
    setDeleteFact(fact);
    setDeleteError(null);
    setDeleteConflict(false);
  }

  function closeDeleteDialog(open: boolean): void {
    if (!open && actions.pendingAction !== 'delete') {
      setDeleteFact(null);
      setDeleteError(null);
      setDeleteConflict(false);
    }
  }

  const busy = actions.pendingAction !== null;
  async function toggleChatFact(fact: ProjectFact, included: boolean): Promise<void> {
    const existing = (chatContext.context?.factIds ?? []).filter((id) => facts.some((item) => item.id === id));
    const factIds = included ? [...new Set([...existing, fact.id])] : existing.filter((id) => id !== fact.id);
    setAnnouncement('');
    setPendingFactIds(factIds);
    if (await chatContext.save({ factIds })) setAnnouncement('Memory selection applied to every chat in this project.');
    setPendingFactIds(null);
  }
  return (
    <section className="project-memory-manager" data-testid="project-memory-manager">
      {fileAccess ? <p className="supporting-copy">Tick facts to include them automatically in every chat in this project.</p> : <p className="supporting-copy">Chat context selection is unavailable in planning workspaces. Saved facts remain available to review and edit.</p>}
      {fileAccess && chatContext.error ? <Alert tone="error"><p>{chatContext.error}</p><Button type="button" onClick={chatContext.reload}>Reload context</Button></Alert> : null}
      {archived ? <Alert id={archivedDescriptionId} tone="warning" data-testid="project-memory-archived-message">This project is archived. Its memory is available to review, but you cannot change it or use it for new runs.</Alert> : null}
      <p className="form-status" data-testid="project-memory-announcement" role="status" aria-live="polite">{announcement}</p>
      <div className="project-memory-toolbar">
        {fileAccess ? <p className="supporting-copy">Your selection applies to all conversations in this project.</p> : null}
        <Button type="button" data-testid="project-memory-add" disabled={archived || busy || !csrfToken} aria-describedby={archived ? archivedDescriptionId : undefined} onClick={openAddDialog}>Add a fact</Button>
      </div>
      <div className="project-memory-list" data-testid="project-memory-list" aria-busy={status === 'loading' || undefined}>
        {status === 'idle' || status === 'loading' ? <MemoryLoading /> : null}
        {status === 'error' ? <section className="error-state project-memory-error" data-testid="project-memory-error" role="alert" aria-labelledby="project-memory-error-title"><h2 id="project-memory-error-title">Project memory could not be loaded</h2><p>We could not load saved facts. Try again.</p><Button type="button" variant="secondary" data-testid="project-memory-retry" onClick={() => { void reload(); }}>Try again</Button></section> : null}
        {status === 'success' && facts.length === 0 ? <section className="empty-state project-memory-empty" data-testid="project-memory-empty" aria-labelledby="project-memory-empty-title"><h2 id="project-memory-empty-title">No saved facts yet</h2><p>{fileAccess ? 'Add a fact when there is something useful for this project that you want the assistant to remember.' : 'Add a fact to keep useful project information together.'}</p><Button type="button" data-testid="project-memory-empty-add" disabled={archived || busy || !csrfToken} aria-describedby={archived ? archivedDescriptionId : undefined} onClick={openAddDialog}>Add a fact</Button></section> : null}
        {status === 'success' && facts.length > 0 ? <ul className="memory-fact-list">{facts.map((fact) => <MemoryFactItem key={fact.id} fact={fact} archived={archived} busy={busy} archivedDescriptionId={archivedDescriptionId} actionError={factActionError[fact.id] ?? null} onEdit={openEditDialog} onVerify={(selected) => { void markReviewed(selected); }} onDelete={openDeleteDialog} includedInChat={fileAccess ? (pendingFactIds ?? chatContext.context?.factIds)?.includes(fact.id) : undefined} contextDisabled={chatContext.loading || chatContext.saving || !chatContext.context || !csrfToken || (!chatContext.context.factIds.includes(fact.id) && chatContext.context.factIds.length >= 25)} onContextToggle={fileAccess ? (selected, included) => { void toggleChatFact(selected, included); } : undefined} />)}</ul> : null}
      </div>
      <ProjectFactEditorDialog
        key={editor?.fact?.id ?? 'new-project-fact'}
        projectName={projectName}
        fact={editor?.fact ?? null}
        saving={actions.pendingAction === 'save'}
        open={editor !== null}
        onOpenChange={(open) => { if (!open) setEditor(null); }}
        onSave={saveFact}
      />
      <ProjectFactDeleteDialog
        fact={deleteFact}
        deleting={actions.pendingAction === 'delete'}
        error={deleteError}
        conflict={deleteConflict}
        onOpenChange={closeDeleteDialog}
        onDelete={() => { void confirmDelete(); }}
      />
    </section>
  );
}

function MemoryLoading(): React.JSX.Element {
  return <div className="memory-fact-loading" data-testid="project-memory-loading" aria-busy="true"><p role="status">Loading project memory…</p><Skeleton className="memory-fact-skeleton" /><Skeleton className="memory-fact-skeleton" /></div>;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && error.code.includes('VERSION_CONFLICT');
}

function mapSaveError(error: unknown): FactEditorSaveResult {
  if (error instanceof ApiClientError) {
    const fields = Object.fromEntries(error.details
      .filter((detail) => detail.field === 'title' || detail.field === 'content')
      .map((detail) => [detail.field, detail.message]));
    if (Object.keys(fields).length > 0) {
      return { status: 'error', message: 'Check the highlighted fields and try again.', fieldErrors: fields };
    }
    if (error.statusCode === 409) {
      return { status: 'error', message: 'A fact with this name already exists in this project.' };
    }
  }
  return { status: 'error', message: 'The fact could not be saved. Check the fields and try again.' };
}

function withoutKey(values: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  const next = { ...values };
  delete next[key];
  return next;
}
