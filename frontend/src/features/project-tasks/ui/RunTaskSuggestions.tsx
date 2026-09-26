import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ProjectTaskStatusLabel } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskDraft, ProjectTaskSuggestion } from '@/entities/project-task';
import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { useConversationTaskSuggestions } from '@/features/project-tasks/model/use-conversation-task-suggestions';
import { useProjectTaskActions } from '@/features/project-tasks/model/use-project-task-actions';
import { TaskConfirmationDialog } from '@/features/project-tasks/ui/TaskConfirmationDialog';
import { TaskEditorDialog } from '@/features/project-tasks/ui/TaskEditorDialog';
import type { TaskEditorSaveResult } from '@/features/project-tasks/ui/TaskEditorDialog';
import { TaskSuggestionCard } from '@/features/project-tasks/ui/TaskSuggestionCard';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';
import { ApiClientError } from '@/shared/api';

interface RunTaskSuggestionsProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly archivedProject: boolean;
}

/** Usage: Mount below a conversation composer to load server-owned task suggestions and explicit decisions for that conversation. */
export function RunTaskSuggestions({ projectId, conversationId, archivedProject }: RunTaskSuggestionsProps): React.JSX.Element | null {
  const csrfToken = useAppSelector(selectCsrfToken);
  const { suggestions, acceptedTasks, status, reload, resolveSuggestion } = useConversationTaskSuggestions(projectId, conversationId);
  const actions = useProjectTaskActions(projectId, csrfToken);
  const [editorSuggestion, setEditorSuggestion] = useState<ProjectTaskSuggestion | null>(null);
  const [dismissTarget, setDismissTarget] = useState<ProjectTaskSuggestion | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [announcement, setAnnouncement] = useState('');

  function openEditor(suggestion: ProjectTaskSuggestion): void {
    setEditorSuggestion(suggestion);
  }

  async function acceptSuggestion(draft: ProjectTaskDraft): Promise<TaskEditorSaveResult> {
    if (!editorSuggestion || archivedProject) {
      return { status: 'error', message: 'This project is read-only.' };
    }
    try {
      const decision = await actions.decideSuggestion(editorSuggestion, 'accepted', draft);
      resolveSuggestion(decision.taskSuggestion, decision.task);
      setErrors((current) => withoutKey(current, editorSuggestion.id));
      setAnnouncement('Task added to this project');
      return { status: 'saved' };
    } catch (error: unknown) {
      if (isSuggestionConflict(error)) {
        void reload();
        return { status: 'error', message: 'This suggestion changed or was already resolved. The conversation suggestions have been refreshed.' };
      }
      return { status: 'error', message: 'Could not add this suggestion. Try again.' };
    }
  }

  async function dismissSuggestion(): Promise<void> {
    if (!dismissTarget || archivedProject) {
      return;
    }
    try {
      const decision = await actions.decideSuggestion(dismissTarget, 'dismissed');
      resolveSuggestion(decision.taskSuggestion, null);
      setErrors((current) => withoutKey(current, dismissTarget.id));
      setAnnouncement('Suggestion dismissed');
      setDismissTarget(null);
    } catch (error: unknown) {
      if (isSuggestionConflict(error)) {
        void reload();
      }
      setErrors((current) => ({ ...current, [dismissTarget.id]: 'Could not dismiss this suggestion. Try again.' }));
      setDismissTarget(null);
    }
  }

  if (status === 'success' && suggestions.length === 0) {
    return null;
  }

  return (
    <section className="conversation-task-suggestions" data-testid="conversation-task-suggestions" aria-labelledby="conversation-task-suggestions-title" aria-busy={status === 'loading' || undefined}>
      <h2 id="conversation-task-suggestions-title">Assistant task suggestions</h2>
      <p>Suggestions stay separate until you choose to add them to the project.</p>
      <p className="project-tasks-announcement" role="status" aria-live="polite">{announcement}</p>
      {archivedProject ? <Alert tone="warning" data-testid="conversation-task-suggestions-archived">This project is archived. Suggestions are available to review, but you cannot accept or dismiss them.</Alert> : null}
      {status === 'idle' || status === 'loading' ? <div className="conversation-task-suggestion-loading" data-testid="conversation-task-suggestion-loading"><p role="status">Loading assistant suggestions…</p><Skeleton className="project-task-suggestion-skeleton" /></div> : null}
      {status === 'error' ? <Alert tone="error" data-testid="conversation-task-suggestions-error" role="alert">Assistant suggestions could not be loaded. <Button type="button" variant="secondary" data-testid="conversation-task-suggestions-retry" onClick={() => { void reload(); }}>Try again</Button></Alert> : null}
      {status === 'success' ? <ul className="project-task-suggestion-list">
        {suggestions.map((suggestion) => suggestion.status === 'pending'
          ? <li key={suggestion.id}>
              <TaskSuggestionCard
                projectId={projectId}
                suggestion={suggestion}
                pending={actions.pendingKeys.includes(`suggestion:${suggestion.id}`)}
                pendingLabel={dismissTarget?.id === suggestion.id ? 'Dismissing…' : 'Adding task…'}
                archivedProject={archivedProject}
                error={errors[suggestion.id] ?? null}
                onReview={openEditor}
                onDismiss={setDismissTarget}
              />
            </li>
          : <li key={suggestion.id}><ResolvedSuggestion suggestion={suggestion} acceptedTask={acceptedTasks[suggestion.id] ?? null} projectId={projectId} /></li>)}
      </ul> : null}
      {editorSuggestion ? <TaskEditorDialog key={editorSuggestion.id} target={{ kind: 'suggestion', suggestion: editorSuggestion }} saving={actions.pendingKeys.includes(`suggestion:${editorSuggestion.id}`)} onOpenChange={(open) => { if (!open) { setEditorSuggestion(null); } }} onSave={(draft) => acceptSuggestion(draft)} /> : null}
      <TaskConfirmationDialog
        open={dismissTarget !== null}
        title="Dismiss this suggestion?"
        description={`“${dismissTarget?.title ?? ''}” will leave the pending suggestions list. Its conversation history will remain available.`}
        confirmLabel="Dismiss suggestion"
        pending={dismissTarget ? actions.pendingKeys.includes(`suggestion:${dismissTarget.id}`) : false}
        testId="conversation-task-suggestion-dismiss-confirmation"
        onOpenChange={(open) => { if (!open) { setDismissTarget(null); } }}
        onConfirm={() => { void dismissSuggestion(); }}
      />
    </section>
  );
}

function ResolvedSuggestion({ suggestion, acceptedTask, projectId }: {
  readonly suggestion: ProjectTaskSuggestion;
  readonly acceptedTask: ProjectTask | null;
  readonly projectId: string;
}): React.JSX.Element {
  if (suggestion.status === 'accepted') {
    return (
      <Card className="conversation-task-suggestion-resolved" data-testid={`conversation-task-suggestion-${suggestion.id}-accepted`}>
        <p className="project-task-suggestion-badge">Accepted by you</p>
        {acceptedTask ? <><h3>{acceptedTask.title}</h3>{acceptedTask.details ? <p className="project-task-details">{acceptedTask.details}</p> : null}<ProjectTaskStatusLabel status={acceptedTask.status} /><p className="project-task-source">{acceptedTask.source.label}</p></> : <p>Original suggestion: {suggestion.title}</p>}
        <Link className="project-task-conversation-link" data-testid={`conversation-task-suggestion-view-tasks-${suggestion.id}`} to={`/projects/${encodeURIComponent(projectId)}/tasks`}>View project tasks</Link>
      </Card>
    );
  }
  return <Card className="conversation-task-suggestion-resolved" data-testid={`conversation-task-suggestion-${suggestion.id}-dismissed`}><p className="project-task-suggestion-badge">Dismissed by you</p><p>Original suggestion: {suggestion.title}</p></Card>;
}

function isSuggestionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && (error.code === 'PROJECT_TASK_SUGGESTION_RESOLVED' || error.code === 'PROJECT_TASK_VERSION_CONFLICT');
}

function withoutKey(values: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  const next = { ...values };
  delete next[key];
  return next;
}
