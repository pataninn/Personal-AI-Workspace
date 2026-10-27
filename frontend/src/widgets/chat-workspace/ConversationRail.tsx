import { Link } from 'react-router-dom';
import type { ConversationSnapshot } from '@/entities/conversation';
import { NewConversationButton } from '@/features/conversation-management';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@/shared/ui';
import type { ListError, LoadStatus } from './chat-workspace-types';

interface ConversationRailProps {
  readonly projectId: string;
  readonly conversations: readonly ConversationSnapshot[];
  readonly selectedId?: string;
  readonly status: LoadStatus;
  readonly error: ListError | null;
  readonly disabled: boolean;
  readonly archivedDescriptionId: string;
  readonly onRetry: () => void;
  readonly onCreated: (conversation: ConversationSnapshot) => void;
}

export function ConversationRail(props: ConversationRailProps): React.JSX.Element {
  const isLoading = props.status === 'loading' || props.status === 'idle';
  return (
    <Card className="conversation-rail">
      <div className="conversation-rail-header">
        <h2>Conversations</h2>
        <NewConversationButton projectId={props.projectId} disabled={props.disabled} archivedDescriptionId={props.archivedDescriptionId} onCreated={props.onCreated} />
      </div>
      <div data-testid="conversation-list" aria-busy={isLoading}>
        {isLoading ? <div data-testid="conversation-list-loading" aria-busy="true"><div data-testid="conversation-list-status" role="status">Loading conversations...</div><Skeleton className="conversation-skeleton" /><Skeleton className="conversation-skeleton" /></div> : null}
        {props.status === 'error' && props.error ? <div data-testid="conversation-list-error" role="alert"><ErrorState title={props.error.title} detail={props.error.detail} action={<Button type="button" variant="secondary" data-testid="conversation-list-retry" onClick={props.onRetry}>Try again</Button>} /></div> : null}
        {props.status === 'success' ? props.conversations.length === 0 ? <div data-testid="conversation-list-empty"><EmptyState title="No conversations yet" detail="Create a conversation to save messages for this project." /></div> : <nav aria-label="Project conversations" className="conversation-list">{props.conversations.map((conversation) => <Link key={conversation.id} data-testid="conversation-item" aria-current={props.selectedId === conversation.id ? 'page' : undefined} className="conversation-item" to={`/projects/${props.projectId}/conversations/${conversation.id}`}><strong>{conversation.title}</strong><time dateTime={conversation.updatedAt}>{new Date(conversation.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>{props.selectedId === conversation.id ? <span data-testid="conversation-selected" className="sr-only">Selected conversation</span> : null}</Link>)}</nav> : null}
      </div>
    </Card>
  );
}
