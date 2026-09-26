import { Link } from 'react-router-dom';

import type { ProjectTaskSuggestion } from '@/entities/project-task';
import { Button, Card } from '@/shared/ui';

interface TaskSuggestionCardProps {
  readonly projectId: string;
  readonly suggestion: ProjectTaskSuggestion;
  readonly pending: boolean;
  readonly pendingLabel?: string;
  readonly archivedProject: boolean;
  readonly error: string | null;
  readonly onReview: (suggestion: ProjectTaskSuggestion) => void;
  readonly onDismiss: (suggestion: ProjectTaskSuggestion) => void;
}

/** Usage: Keep an unaccepted assistant proposal separate from persisted project tasks. */
export function TaskSuggestionCard({ projectId, suggestion, pending, pendingLabel = 'Adding task…', archivedProject, error, onReview, onDismiss }: TaskSuggestionCardProps): React.JSX.Element {
  const disabledReason = archivedProject ? 'This project is archived. Suggestions are read-only.' : 'A suggestion update is in progress.';
  return (
    <li className="project-task-suggestion-item" data-testid={`project-task-suggestion-${suggestion.id}`} aria-busy={pending || undefined}>
      <Card className="project-task-suggestion-card">
        <div className="project-task-suggestion-heading">
          <span className="project-task-suggestion-badge">Suggestion · not added</span>
          <span>{suggestion.source.label}</span>
        </div>
        <h3>{suggestion.title}</h3>
        {suggestion.details ? <p className="project-task-details">{suggestion.details}</p> : null}
        <Link className="project-task-conversation-link" data-testid={`project-task-suggestion-conversation-${suggestion.id}`} to={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(suggestion.conversationId)}`}>
          View originating conversation
        </Link>
        {error ? <p className="project-task-row-error" role="alert">{error}</p> : null}
        {archivedProject || pending ? <span className="project-task-action-help" id={`suggestion-${suggestion.id}-disabled-help`}>{disabledReason}</span> : null}
        <div className="project-task-suggestion-actions">
          <Button type="button" data-testid={`project-task-suggestion-review-${suggestion.id}`} disabled={archivedProject || pending} aria-describedby={archivedProject || pending ? `suggestion-${suggestion.id}-disabled-help` : undefined} aria-busy={pending || undefined} onClick={() => { onReview(suggestion); }}>{pending ? pendingLabel : 'Review & add'}</Button>
          <Button type="button" variant="secondary" data-testid={`project-task-suggestion-dismiss-${suggestion.id}`} disabled={archivedProject || pending} aria-describedby={archivedProject || pending ? `suggestion-${suggestion.id}-disabled-help` : undefined} onClick={() => { onDismiss(suggestion); }}>Dismiss suggestion</Button>
        </div>
      </Card>
    </li>
  );
}
