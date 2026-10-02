import { ProjectFactAttribution, type ProjectFact } from '@/entities/project-fact';
import { Alert, Button, Card } from '@/shared/ui';

interface MemoryFactItemProps {
  readonly includedInChat?: boolean;
  readonly contextDisabled?: boolean;
  readonly onContextToggle?: (fact: ProjectFact, included: boolean) => void;
  readonly fact: ProjectFact;
  readonly archived: boolean;
  readonly busy: boolean;
  readonly archivedDescriptionId: string;
  readonly actionError: string | null;
  readonly onEdit: (fact: ProjectFact) => void;
  readonly onVerify: (fact: ProjectFact) => void;
  readonly onDelete: (fact: ProjectFact) => void;
}

/** Usage: Render one fact inside ProjectMemoryManager and delegate edit, review, and delete actions to that owner. */
export function MemoryFactItem({ fact, archived, busy, archivedDescriptionId, actionError, onEdit, onVerify, onDelete, includedInChat = false, contextDisabled = false, onContextToggle }: MemoryFactItemProps): React.JSX.Element {
  return (
    <li className="memory-fact-list-item">
      <Card className="memory-fact-card" data-testid="project-memory-fact">
        <div className="memory-fact-heading">
          <h2>{fact.title}</h2>
          <p className="memory-fact-value">{fact.content}</p>
        </div>
        <ProjectFactAttribution fact={fact} />
        {onContextToggle ? <label className="context-checkbox-row"><input type="checkbox" checked={includedInChat} disabled={archived || contextDisabled} aria-label={`Use ${fact.title} in all chats`} onChange={(event) => onContextToggle(fact, event.target.checked)} />Use in every chat in this project</label> : null}
        {actionError ? <Alert tone="error" className="memory-fact-action-error" role="alert">{actionError}</Alert> : null}
        <div className="memory-fact-actions" aria-label={`Actions for ${fact.title}`}>
          <Button type="button" variant="secondary" data-testid={`project-fact-edit-${fact.id}`} disabled={archived || busy} aria-describedby={archived ? archivedDescriptionId : undefined} onClick={() => onEdit(fact)}>Edit</Button>
          {fact.verificationStatus === 'needs_review' ? <Button type="button" variant="secondary" data-testid={`project-fact-review-${fact.id}`} disabled={archived || busy} aria-describedby={archived ? archivedDescriptionId : undefined} aria-busy={busy} onClick={() => onVerify(fact)}>{busy ? 'Saving review…' : 'Mark as reviewed'}</Button> : null}
          <Button type="button" variant="destructive" data-testid={`project-fact-delete-${fact.id}`} disabled={archived || busy} aria-describedby={archived ? archivedDescriptionId : undefined} onClick={() => onDelete(fact)}>Delete</Button>
        </div>
      </Card>
    </li>
  );
}
