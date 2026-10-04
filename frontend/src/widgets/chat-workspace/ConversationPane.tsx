import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { ChatComposer } from '@/features/ai-run';
import { Button, Card, EmptyState, ErrorState, MarkdownContent, Skeleton } from '@/shared/ui';
import { useChatScroll } from './use-chat-scroll';
import type { HistoryError, LoadStatus, OlderHistoryStatus } from './chat-workspace-types';

interface ConversationPaneProps {
  readonly projectId: string;
  readonly conversationId?: string;
  readonly history: ConversationHistoryResponse | null;
  readonly status: LoadStatus;
  readonly error: HistoryError | null;
  readonly olderStatus: OlderHistoryStatus;
  readonly olderError: HistoryError | null;
  readonly disabled: boolean;
  readonly archivedDescriptionId: string;
  readonly onRetry: () => void;
  readonly onLoadOlder: () => void;
  readonly onRunConversationReconciled: (history: ConversationHistoryResponse) => void;
}

export function ConversationPane(props: ConversationPaneProps): React.JSX.Element {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [timelineTarget, setTimelineTarget] = useState<HTMLDivElement | null>(null);
  const scroll = useChatScroll({ conversationId: props.conversationId, ready: props.status === 'success', firstSequence: props.history?.messages[0]?.sequence, lastSequence: props.history?.messages.at(-1)?.sequence, olderLoading: props.olderStatus === 'loading' });

  useEffect(() => {
    if (props.status === 'success' && props.history) {
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [props.conversationId, props.status]);

  if (!props.conversationId) {
    return <Card className="conversation-pane"><EmptyState title="Choose a conversation" detail="Select a conversation or create one to review saved messages." /></Card>;
  }
  if (props.status === 'loading' || props.status === 'idle') {
    return <Card className="conversation-pane" data-testid="conversation-history" aria-busy="true"><div data-testid="conversation-history-loading" aria-busy="true"><div data-testid="conversation-history-status" role="status">Loading conversation history...</div><Skeleton className="conversation-history-skeleton" /></div></Card>;
  }
  if (props.status === 'error') {
    const isRetryable = props.error?.kind === 'retryable';
    const isConversationNotFound = props.error?.kind === 'conversation-not-found';
    const errorTestId = isConversationNotFound ? 'conversation-not-found' : props.error?.kind === 'project-not-found' ? 'project-not-found' : 'conversation-history-retryable';
    const action = isRetryable ? <><Button type="button" variant="secondary" data-testid="conversation-history-retry" onClick={props.onRetry}>Try again</Button><Link className="button button-secondary" data-testid="conversation-back-to-project" to={`/projects/${props.projectId}/conversations`}>Back to project conversations</Link></> : <Link className="button button-secondary" data-testid="conversation-back-to-project" to={`/projects/${props.projectId}/conversations`}>Back to project conversations</Link>;
    return <Card className="conversation-pane" data-testid="conversation-history-error" role="alert"><div data-testid={errorTestId}><ErrorState title={props.error?.title ?? 'Conversation history unavailable'} detail={props.error?.detail ?? 'This conversation could not be loaded. Try again.'} action={action} /></div></Card>;
  }
  if (!props.history) {
    return <Card className="conversation-pane"><div data-testid="conversation-not-found"><EmptyState title="Conversation not found" detail="Back to project conversations to choose an available conversation." /></div></Card>;
  }
  const { conversation, messages } = props.history;
  const isOlderLoading = props.olderStatus === 'loading';
  return (
    <Card className="conversation-pane">
      <h2 ref={titleRef} className="conversation-title" tabIndex={-1}>{conversation.title}</h2>
      <div ref={scroll.viewportRef} className="chat-history-viewport" onScroll={scroll.onScroll} data-testid="conversation-history" aria-busy={isOlderLoading}>
        {props.history.nextBeforeSequence !== null ? <div className="history-pagination"><Button type="button" variant="secondary" data-testid="conversation-history-load-older" aria-busy={isOlderLoading} disabled={isOlderLoading} onClick={() => { scroll.beforeLoadOlder(); props.onLoadOlder(); }}>Load older messages</Button>{isOlderLoading ? <p data-testid="conversation-history-load-older-status" role="status">Loading older messages...</p> : null}{props.olderError ? <div data-testid="conversation-history-load-older-error" role="alert"><p>{props.olderError.detail}</p><Button type="button" variant="secondary" data-testid="conversation-history-load-older-retry" onClick={() => { scroll.beforeLoadOlder(); props.onLoadOlder(); }}>Try again</Button></div> : null}</div> : null}
        {messages.length === 0 ? <div data-testid="conversation-history-empty"><EmptyState title="No messages yet" detail="Add a message below to start this conversation." /></div> : <ol className="message-history">{messages.map((message) => <li key={message.id} data-testid="message-item" className={`message-item message-${message.role}`}><span data-testid="message-role" className="message-role">{message.role === 'user' ? 'You' : 'Assistant'}</span><div data-testid="message-content" className="message-content">{message.role === 'assistant' ? <MarkdownContent content={message.content} /> : message.content}</div><time data-testid="message-created-at" dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time></li>)}</ol>}
        <div ref={setTimelineTarget} />
      </div>
      {scroll.showLatest ? <Button type="button" variant="secondary" data-testid="chat-jump-latest" onClick={scroll.jumpToLatest}>Jump to latest</Button> : null}
      <ChatComposer
        projectId={props.projectId}
        conversationId={conversation.id}
        disabled={props.disabled}
        archivedDescriptionId={props.archivedDescriptionId}
        timelineTarget={timelineTarget}
        onConversationReconciled={props.onRunConversationReconciled}
      />
    </Card>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
