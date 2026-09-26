import { Button, Skeleton } from '@/shared/ui';
import type { ProjectTaskSuggestion } from '@/entities/project-task';
import { TaskSuggestionCard } from '@/features/project-tasks/ui/TaskSuggestionCard';

interface ProjectTaskSuggestionsProps {
  readonly projectId: string;
  readonly suggestions: readonly ProjectTaskSuggestion[];
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly pendingKeys: readonly string[];
  readonly archivedProject: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly onReview: (suggestion: ProjectTaskSuggestion) => void;
  readonly onDismiss: (suggestion: ProjectTaskSuggestion) => void;
  readonly onRetry: () => void;
}

/** Usage: Render pending proposals in a section outside the persisted task ordered list. */
export function ProjectTaskSuggestions({ projectId, suggestions, status, pendingKeys, archivedProject, errors, onReview, onDismiss, onRetry }: ProjectTaskSuggestionsProps): React.JSX.Element | null {
  if (status === 'idle' || status === 'loading') {
    return <section className="project-task-suggestions" data-testid="project-task-suggestions-loading" aria-busy="true" aria-labelledby="project-task-suggestions-title"><h2 id="project-task-suggestions-title">Assistant suggestions — not added</h2><p role="status">Loading suggestions…</p><Skeleton className="project-task-suggestion-skeleton" /></section>;
  }
  if (status === 'error') {
    return <section className="project-task-suggestions" data-testid="project-task-suggestions-error" aria-labelledby="project-task-suggestions-error-title"><h2 id="project-task-suggestions-error-title">Assistant suggestions could not be loaded</h2><p>Pending suggestions remain separate from project tasks. Try again.</p><Button type="button" variant="secondary" data-testid="project-task-suggestions-retry" onClick={onRetry}>Try again</Button></section>;
  }
  if (suggestions.length === 0) {
    return null;
  }
  return (
    <section className="project-task-suggestions" data-testid="project-task-suggestions" aria-labelledby="project-task-suggestions-title">
      <h2 id="project-task-suggestions-title">Assistant suggestions — not added</h2>
      <ul className="project-task-suggestion-list">
        {suggestions.map((suggestion) => <TaskSuggestionCard key={suggestion.id} projectId={projectId} suggestion={suggestion} pending={pendingKeys.includes(`suggestion:${suggestion.id}`)} archivedProject={archivedProject} error={errors[suggestion.id] ?? null} onReview={onReview} onDismiss={onDismiss} />)}
      </ul>
    </section>
  );
}
