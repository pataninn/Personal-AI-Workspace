import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { CreateConversationDialog } from '@/features/conversation-management';
import { AiRunEntry } from '@/features/ai-run';
import { RunTaskSuggestions } from '@/features/project-tasks';
import { MessageComposer } from '@/features/message-persistence';
import { getConversation, listConversations } from '@/entities/conversation';
import type { ConversationHistoryResponse, ConversationSnapshot } from '@/entities/conversation';
import type { MessageSnapshot } from '@/entities/message';
import type { ProjectSnapshot } from '@/entities/project';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Card, EmptyState, ErrorState, Skeleton } from '@/shared/ui';

interface ChatWorkspaceProps {
  readonly project: ProjectSnapshot;
}

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';
type OlderHistoryStatus = 'idle' | 'loading' | 'error';

interface ListError {
  readonly kind: 'project-not-found' | 'retryable' | 'conversation-not-found';
  readonly title: string;
  readonly detail: string;
}

interface HistoryError extends ListError {
  readonly kind: 'project-not-found' | 'retryable' | 'conversation-not-found';
}

const ARCHIVED_DESCRIPTION_ID = 'project-archived-message';

export function ChatWorkspace({ project }: ChatWorkspaceProps): React.JSX.Element {
  const { projectId = '', conversationId } = useParams();
  const navigate = useNavigate();
  const [listStatus, setListStatus] = useState<LoadStatus>('idle');
  const [listAttempt, setListAttempt] = useState(0);
  const [listError, setListError] = useState<ListError | null>(null);
  const [conversations, setConversations] = useState<readonly ConversationSnapshot[]>([]);
  const [historyStatus, setHistoryStatus] = useState<LoadStatus>('idle');
  const [historyError, setHistoryError] = useState<HistoryError | null>(null);
  const [history, setHistory] = useState<ConversationHistoryResponse | null>(null);
  const [olderHistoryStatus, setOlderHistoryStatus] = useState<OlderHistoryStatus>('idle');
  const [olderHistoryError, setOlderHistoryError] = useState<HistoryError | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createAnnouncement, setCreateAnnouncement] = useState('');
  const isArchived = project.status === 'archived';

  useEffect(() => {
    let cancelled = false;
    setListStatus('loading');
    setListError(null);
    void listConversations(projectId)
      .then((result) => {
        if (!cancelled) {
          setConversations(result.conversations);
          setListStatus('success');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(listErrorDetails(error));
          setListStatus('error');
        }
      });
    return () => { cancelled = true; };
  }, [listAttempt, projectId]);

  useEffect(() => {
    if (listStatus === 'success' && !conversationId && conversations[0]) {
      navigate(`/projects/${projectId}/conversations/${conversations[0].id}`, { replace: true });
    }
  }, [conversations, conversationId, listStatus, navigate, projectId]);

  useEffect(() => {
    if (!conversationId) {
      setHistory(null);
      setHistoryStatus('idle');
      setHistoryError(null);
      setOlderHistoryStatus('idle');
      setOlderHistoryError(null);
      return;
    }
    let cancelled = false;
    setHistoryStatus('loading');
    setHistoryError(null);
    setOlderHistoryStatus('idle');
    setOlderHistoryError(null);
    void getConversation(projectId, conversationId)
      .then((result) => {
        if (!cancelled) {
          setHistory(result);
          setHistoryStatus('success');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHistory(null);
          setHistoryError(historyErrorDetails(error));
          setHistoryStatus('error');
        }
      });
    return () => { cancelled = true; };
  }, [conversationId, projectId]);

  function retryList(): void {
    setListAttempt((value) => value + 1);
  }

  function retryHistory(): void {
    if (!conversationId) {
      return;
    }
    setHistoryStatus('idle');
    setHistoryError(null);
    void getConversation(projectId, conversationId)
      .then((result) => {
        setHistory(result);
        setHistoryStatus('success');
        setOlderHistoryStatus('idle');
        setOlderHistoryError(null);
      })
      .catch((error: unknown) => {
        setHistoryError(historyErrorDetails(error));
        setHistoryStatus('error');
      });
  }

  function loadOlderHistory(): void {
    const beforeSequence = history?.nextBeforeSequence;
    if (!conversationId || beforeSequence === null || beforeSequence === undefined || olderHistoryStatus === 'loading') {
      return;
    }
    setOlderHistoryStatus('loading');
    setOlderHistoryError(null);
    void getConversation(projectId, conversationId, beforeSequence)
      .then((result) => {
        setHistory((current) => current ? mergeHistoryPages(current, result) : result);
        setOlderHistoryStatus('idle');
      })
      .catch((error: unknown) => {
        setOlderHistoryError(historyErrorDetails(error));
        setOlderHistoryStatus('error');
      });
  }

  function handleCreated(conversation: ConversationSnapshot): void {
    setCreateAnnouncement('Conversation created.');
    setConversations((current) => [conversation, ...current.filter((candidate) => candidate.id !== conversation.id)]);
    navigate(`/projects/${projectId}/conversations/${conversation.id}`);
  }

  function handleSaved(message: MessageSnapshot): void {
    setHistory((current) => current ? {
      ...current,
      messages: mergeMessages(current.messages, [message])
    } : current);
    setConversations((current) => current.map((candidate) => candidate.id === conversationId ? { ...candidate, lastActivityAt: message.createdAt, updatedAt: message.createdAt } : candidate));
  }

  function handleRunConversationReconciled(result: ConversationHistoryResponse): void {
    setHistory((current) => current ? mergeReconciledHistory(current, result) : result);
    const lastMessage = result.messages.at(-1);
    if (lastMessage) {
      setConversations((current) => current.map((candidate) => candidate.id === conversationId ? { ...candidate, lastActivityAt: lastMessage.createdAt, updatedAt: lastMessage.createdAt } : candidate));
    }
  }

  return (
    <section className="conversation-workspace" data-testid="conversation-workspace">
      <div className="conversation-project-context" data-testid="conversation-project-context">
        <p className="supporting-copy">Saved messages for this project. The composer only persists text; it does not start an AI run.</p>
        {isArchived ? <Alert id={ARCHIVED_DESCRIPTION_ID} tone="warning" data-testid="project-archived-message">This project is archived. Existing messages are read-only.</Alert> : null}
        <p data-testid="conversation-create-success-announcement" className="form-status" role="status" aria-live="polite">{createAnnouncement}</p>
      </div>
      <div className="conversation-layout">
        <ConversationRail
          projectId={projectId}
          conversations={conversations}
          selectedId={conversationId}
          status={listStatus}
          error={listError}
          disabled={isArchived}
          archivedDescriptionId={ARCHIVED_DESCRIPTION_ID}
          createOpen={createOpen}
          onCreateOpenChange={setCreateOpen}
          onRetry={retryList}
          onCreated={handleCreated}
        />
        <ConversationPane
          projectId={projectId}
          conversationId={conversationId}
          history={history}
          status={historyStatus}
          error={historyError}
          olderStatus={olderHistoryStatus}
          olderError={olderHistoryError}
          disabled={isArchived}
          archivedDescriptionId={ARCHIVED_DESCRIPTION_ID}
          onRetry={retryHistory}
          onLoadOlder={loadOlderHistory}
          onSaved={handleSaved}
          onRunConversationReconciled={handleRunConversationReconciled}
        />
      </div>
    </section>
  );
}

interface ConversationRailProps {
  readonly projectId: string;
  readonly conversations: readonly ConversationSnapshot[];
  readonly selectedId?: string;
  readonly status: LoadStatus;
  readonly error: ListError | null;
  readonly disabled: boolean;
  readonly archivedDescriptionId: string;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
  readonly onCreated: (conversation: ConversationSnapshot) => void;
}

function ConversationRail(props: ConversationRailProps): React.JSX.Element {
  const isLoading = props.status === 'loading' || props.status === 'idle';
  return (
    <Card className="conversation-rail">
      <div className="conversation-rail-header">
        <h2>Conversations</h2>
        <Button type="button" data-testid="conversation-create-trigger" aria-describedby={props.disabled ? props.archivedDescriptionId : undefined} disabled={props.disabled} onClick={() => props.onCreateOpenChange(true)}>New conversation</Button>
      </div>
      <div data-testid="conversation-list" aria-busy={isLoading}>
        {isLoading ? <div data-testid="conversation-list-loading" aria-busy="true"><div data-testid="conversation-list-status" role="status">Loading conversations...</div><Skeleton className="conversation-skeleton" /><Skeleton className="conversation-skeleton" /></div> : null}
        {props.status === 'error' && props.error ? <div data-testid="conversation-list-error" role="alert"><ErrorState title={props.error.title} detail={props.error.detail} action={<Button type="button" variant="secondary" data-testid="conversation-list-retry" onClick={props.onRetry}>Try again</Button>} /></div> : null}
        {props.status === 'success' ? props.conversations.length === 0 ? <div data-testid="conversation-list-empty"><EmptyState title="No conversations yet" detail="Create a conversation to save messages for this project." /></div> : <nav aria-label="Project conversations" className="conversation-list">{props.conversations.map((conversation) => <Link key={conversation.id} data-testid="conversation-item" aria-current={props.selectedId === conversation.id ? 'page' : undefined} className="conversation-item" to={`/projects/${props.projectId}/conversations/${conversation.id}`}>{conversation.title}{props.selectedId === conversation.id ? <span data-testid="conversation-selected" className="sr-only">Selected conversation</span> : null}</Link>)}</nav> : null}
      </div>
      <CreateConversationDialog projectId={props.projectId} open={props.createOpen} disabled={props.disabled} archivedDescriptionId={props.archivedDescriptionId} onOpenChange={props.onCreateOpenChange} onCreated={props.onCreated} />
    </Card>
  );
}

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
  readonly onSaved: (message: MessageSnapshot) => void;
  readonly onRunConversationReconciled: (history: ConversationHistoryResponse) => void;
}

function ConversationPane(props: ConversationPaneProps): React.JSX.Element {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (props.status === 'success' && props.history) {
      titleRef.current?.focus();
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
      <div data-testid="conversation-history" aria-busy={isOlderLoading}>
        {messages.length === 0 ? <div data-testid="conversation-history-empty"><EmptyState title="No messages yet" detail="Add a message below to start this conversation." /></div> : <ol className="message-history">{messages.map((message) => <li key={message.id} data-testid="message-item" className={`message-item message-${message.role}`}><span data-testid="message-role" className="message-role">{message.role === 'user' ? 'You' : 'Assistant'}</span><p data-testid="message-content" className="message-content">{message.content}</p><time data-testid="message-created-at" dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time></li>)}</ol>}
        {props.history.nextBeforeSequence !== null ? <div className="history-pagination"><Button type="button" variant="secondary" data-testid="conversation-history-load-older" aria-busy={isOlderLoading} disabled={isOlderLoading} onClick={props.onLoadOlder}>Load older messages</Button>{isOlderLoading ? <p data-testid="conversation-history-load-older-status" role="status">Loading older messages...</p> : null}{props.olderError ? <div data-testid="conversation-history-load-older-error" role="alert"><p>{props.olderError.detail}</p><Button type="button" variant="secondary" data-testid="conversation-history-load-older-retry" onClick={props.onLoadOlder}>Try again</Button></div> : null}</div> : null}
      </div>
      <MessageComposer
        projectId={props.projectId}
        conversationId={conversation.id}
        disabled={props.disabled}
        archivedDescriptionId={props.archivedDescriptionId}
        inputLabel="Request for the assistant"
        inputHelp="Ctrl+Enter or Cmd+Enter saves the message. Saving a message does not start an AI run."
        renderAdditionalActions={(request) => (
          <AiRunEntry
            projectId={props.projectId}
            conversationId={conversation.id}
            request={request}
            recentMessageCount={messages.length}
            disabled={props.disabled}
            archivedDescriptionId={props.archivedDescriptionId}
            onConversationReconciled={props.onRunConversationReconciled}
          />
        )}
        onSaved={props.onSaved}
      />
      <RunTaskSuggestions projectId={props.projectId} conversationId={conversation.id} archivedProject={props.disabled} />
    </Card>
  );
}

function listErrorDetails(error: unknown): ListError {
  if (error instanceof ApiClientError && error.code === 'PROJECT_NOT_FOUND') {
    return { kind: 'project-not-found', title: 'Project not found', detail: 'This project is no longer available.' };
  }
  return { kind: 'retryable', title: 'Conversations could not be loaded', detail: 'Try again to reload conversations.' };
}

function historyErrorDetails(error: unknown): HistoryError {
  if (error instanceof ApiClientError && error.code === 'PROJECT_NOT_FOUND') {
    return { kind: 'project-not-found', title: 'Project not found', detail: 'This project is no longer available.' };
  }
  if (error instanceof ApiClientError && error.statusCode === 404) {
    return { kind: 'conversation-not-found', title: 'Conversation not found', detail: 'We could not find that conversation in this project.' };
  }
  return { kind: 'retryable', title: 'Conversation history unavailable', detail: 'This conversation could not be loaded. Try again.' };
}

function mergeHistoryPages(current: ConversationHistoryResponse, older: ConversationHistoryResponse): ConversationHistoryResponse {
  return { ...current, messages: mergeMessages(current.messages, older.messages), nextBeforeSequence: older.nextBeforeSequence };
}

function mergeReconciledHistory(current: ConversationHistoryResponse, authoritative: ConversationHistoryResponse): ConversationHistoryResponse {
  return {
    ...authoritative,
    messages: mergeMessages(current.messages, authoritative.messages),
    nextBeforeSequence: authoritative.nextBeforeSequence ?? current.nextBeforeSequence
  };
}

function mergeMessages(current: readonly MessageSnapshot[], incoming: readonly MessageSnapshot[]): readonly MessageSnapshot[] {
  const byId = new Map<string, MessageSnapshot>();
  for (const message of [...current, ...incoming]) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
