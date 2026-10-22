import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { NewConversationButton } from '@/features/conversation-management';
import { getConversation, listConversations } from '@/entities/conversation';
import type { ConversationHistoryResponse, ConversationSnapshot } from '@/entities/conversation';
import type { MessageSnapshot } from '@/entities/message';
import type { ProjectSnapshot } from '@/entities/project';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Card, Icon } from '@/shared/ui';

import { ConversationPane } from './ConversationPane';
import { ConversationRail } from './ConversationRail';
import type { HistoryError, ListError, LoadStatus, OlderHistoryStatus } from './chat-workspace-types';

interface ChatWorkspaceProps {
  readonly project: ProjectSnapshot;
}

const ARCHIVED_DESCRIPTION_ID = 'project-archived-message';

export function ChatWorkspace({ project }: ChatWorkspaceProps): React.JSX.Element {
  const { projectId = '', conversationId } = useParams();
  const currentHistoryKey = `${projectId}:${conversationId ?? ''}`;
  const historyKeyRef = useRef(currentHistoryKey);
  historyKeyRef.current = currentHistoryKey;
  const navigate = useNavigate();
  const [listStatus, setListStatus] = useState<LoadStatus>('idle');
  const [listProjectId, setListProjectId] = useState('');
  const [listAttempt, setListAttempt] = useState(0);
  const [listError, setListError] = useState<ListError | null>(null);
  const [conversations, setConversations] = useState<readonly ConversationSnapshot[]>([]);
  const [historyStatus, setHistoryStatus] = useState<LoadStatus>('idle');
  const [historyError, setHistoryError] = useState<HistoryError | null>(null);
  const [history, setHistory] = useState<ConversationHistoryResponse | null>(null);
  const [olderHistoryStatus, setOlderHistoryStatus] = useState<OlderHistoryStatus>('idle');
  const [olderHistoryError, setOlderHistoryError] = useState<HistoryError | null>(null);
  const [createAnnouncement, setCreateAnnouncement] = useState('');
  const isArchived = project.status === 'archived';

  useEffect(() => {
    let cancelled = false;
    setListStatus('loading');
    setListError(null);
    void listConversations(projectId)
      .then((result) => {
        if (!cancelled) {
          setConversations(sortConversations(result.conversations));
          setListProjectId(projectId);
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
    if (listStatus === 'success' && listProjectId === projectId && !conversationId && conversations[0]) {
      navigate(`/projects/${projectId}/conversations/${conversations[0].id}`, { replace: true });
    }
  }, [conversations, conversationId, listProjectId, listStatus, navigate, projectId]);

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
    const requestKey = currentHistoryKey;
    void getConversation(projectId, conversationId)
      .then((result) => {
        if (historyKeyRef.current !== requestKey) return;
        setHistory(result);
        setHistoryStatus('success');
        setOlderHistoryStatus('idle');
        setOlderHistoryError(null);
      })
      .catch((error: unknown) => {
        if (historyKeyRef.current !== requestKey) return;
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
    const requestKey = currentHistoryKey;
    void getConversation(projectId, conversationId, beforeSequence)
      .then((result) => {
        if (historyKeyRef.current !== requestKey) return;
        setHistory((current) => current ? mergeHistoryPages(current, result) : result);
        setOlderHistoryStatus('idle');
      })
      .catch((error: unknown) => {
        if (historyKeyRef.current !== requestKey) return;
        setOlderHistoryError(historyErrorDetails(error));
        setOlderHistoryStatus('error');
      });
  }

  function handleCreated(conversation: ConversationSnapshot): void {
    setCreateAnnouncement('');
    setConversations((current) => [conversation, ...current.filter((candidate) => candidate.id !== conversation.id)]);
    navigate(`/projects/${projectId}/conversations/${conversation.id}`);
  }

  function handleRunConversationReconciled(result: ConversationHistoryResponse): void {
    if (historyKeyRef.current !== `${projectId}:${result.conversation.id}`) return;
    setHistory((current) => current ? mergeReconciledHistory(current, result) : result);
    const lastMessage = result.messages.at(-1);
    if (lastMessage) {
      setConversations((current) => sortConversations(current.map((candidate) => candidate.id === conversationId ? { ...candidate, title: result.conversation.title, lastActivityAt: lastMessage.createdAt, updatedAt: lastMessage.createdAt } : candidate)));
    }
    window.dispatchEvent(new Event('project-files-changed'));
  }

  if (listStatus === 'success' && listProjectId === projectId && conversations.length === 0) {
    return (
      <section className="conversation-workspace" data-testid="conversation-workspace">
        {isArchived ? <Alert id={ARCHIVED_DESCRIPTION_ID} tone="warning" data-testid="project-archived-message">This project is archived. Existing messages are read-only.</Alert> : null}
        <Card className="conversation-welcome" data-testid="conversation-list-empty">
          <span className="conversation-welcome-icon"><Icon name="chat" size={24} /></span>
          <h2>Get started</h2>
          <p>Start a conversation to ask a question, plan your next task or work on your project.</p>
          <NewConversationButton projectId={projectId} disabled={isArchived} archivedDescriptionId={ARCHIVED_DESCRIPTION_ID} onCreated={handleCreated} />
        </Card>
      </section>
    );
  }

  return (
    <section className="conversation-workspace" data-testid="conversation-workspace">
      {isArchived || createAnnouncement ? <div className="conversation-project-context" data-testid="conversation-project-context">
        {isArchived ? <Alert id={ARCHIVED_DESCRIPTION_ID} tone="warning" data-testid="project-archived-message">This project is archived. Existing messages are read-only.</Alert> : null}
        <p data-testid="conversation-create-success-announcement" className="form-status" role="status" aria-live="polite">{createAnnouncement}</p>
      </div> : null}
      <div className="conversation-layout">
        <ConversationRail
          projectId={projectId}
          conversations={listProjectId === projectId ? conversations : []}
          selectedId={conversationId}
          status={listStatus === 'success' && listProjectId !== projectId ? 'loading' : listStatus}
          error={listError}
          disabled={isArchived}
          archivedDescriptionId={ARCHIVED_DESCRIPTION_ID}
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
          onRunConversationReconciled={handleRunConversationReconciled}
        />
      </div>
    </section>
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

function sortConversations(conversations: readonly ConversationSnapshot[]): readonly ConversationSnapshot[] {
  return [...conversations].sort((left, right) => Date.parse(right.lastActivityAt ?? right.updatedAt) - Date.parse(left.lastActivityAt ?? left.updatedAt));
}
