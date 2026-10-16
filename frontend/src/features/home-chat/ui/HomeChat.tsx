import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { HomeConversationScope } from '@/entities/home-conversation';
import { Alert, Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, Icon, Label, MarkdownContent, Skeleton, Spinner, Textarea } from '@/shared/ui';

import { useHomeChat } from '../model/use-home-chat';

interface HomeChatProps {
  readonly scope: HomeConversationScope;
  readonly scopeLabel: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  current_message: 'Current message',
  bounded_home_history: 'Recent messages in this conversation',
  task_metadata: 'Task metadata',
  workspace_metadata: 'Workspace metadata'
};

export function HomeChat({ scope, scopeLabel, disabled = false, disabledReason }: HomeChatProps): React.JSX.Element {
  const chat = useHomeChat({ scope, disabled });
  const [historyOpen, setHistoryOpen] = useState(false);
  const archivedId = 'home-chat-archived-description';
  const isWorkspace = scope.kind === 'workspace';
  const currentTitle = chat.isNewConversation ? 'New conversation' : chat.selectedConversation?.title ?? 'Assistant conversation';
  const composerDisabled = disabled || chat.busy || chat.runtimeUnavailable || Boolean(chat.pendingDisclosure) || chat.createNeedsRetry || chat.sendStatus === 'uncertain';
  const currentTurnDecision = chat.activeTurn
    ? [...chat.events].reverse().find((event) => event.type === 'consent.decided' && event.turnId === chat.activeTurn?.id)
    : undefined;
  const currentTurnDecisionIsPrivate = currentTurnDecision?.payload.decision === 'deny';
  const currentDisclosurePhase = currentTurnDecisionIsPrivate
    ? chat.events.find((event) => event.type === 'consent.requested' && event.entityId === currentTurnDecision.entityId)?.payload.phase
    : undefined;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void chat.send();
  }

  return <section className={`home-chat ${isWorkspace ? 'home-chat-workspace' : 'home-chat-home'}`} data-testid={isWorkspace ? 'planning-chat' : 'home-chat'}>
    <header className="home-chat-header">
      <div>
        <p className="product-label">{scopeLabel}</p>
        <h2>{isWorkspace ? 'Planning chat' : 'Ask the Home assistant'}</h2>
        <p className="home-chat-current-title" title={currentTitle}>{currentTitle}</p>
      </div>
      <Button type="button" variant="secondary" data-testid="home-chat-new" disabled={disabled || chat.busy || chat.navigationLocked} onClick={chat.startNewConversation}>
        <Icon name="plus" size={16} />New conversation
      </Button>
    </header>

    {disabled && disabledReason ? <Alert id={archivedId} tone="warning" data-testid="planning-chat-read-only">{disabledReason}</Alert> : null}
    {isWorkspace ? <p className="home-chat-scope-note">Planning chat for this workspace. Files and shell tools are unavailable.</p> : null}
    {chat.runtimeUnavailable ? <Alert tone="error" data-testid="home-chat-runtime-unavailable" role="alert">The configured planning runtime is unavailable. Check its configuration or wait for it to reconnect, then reload Home chat to retry.</Alert> : null}
    {chat.reconnecting ? <p className="home-chat-reconnect" role="status" aria-live="polite"><Spinner label="Reconnecting" /> Reconnecting…</p> : null}

    <div className="home-chat-layout">
      <aside className="home-chat-history" aria-label="Saved conversations">
        <HistoryList chat={chat} disabled={disabled} testIdPrefix="home-chat-history-desktop" />
      </aside>
      <details className="home-chat-history-mobile" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary data-testid="home-chat-history-summary">History{chat.conversations.length ? ` (${chat.conversations.length})` : ''}</summary>
        <HistoryList chat={chat} disabled={disabled} testIdPrefix="home-chat-history-mobile" />
      </details>

      <div className="home-chat-main">
        {chat.historyStatus === 'loading' ? <div className="home-chat-loading" aria-busy="true" data-testid="home-chat-loading"><p role="status">Loading conversation…</p><Skeleton className="home-chat-skeleton" /><Skeleton className="home-chat-skeleton short" /></div> : null}
        {chat.historyStatus === 'error' ? <Alert tone="error" role="alert" data-testid="home-chat-history-error">
          <span>{chat.historyError ?? 'Conversation history could not be loaded.'}</span>
          <Button type="button" variant="secondary" data-testid="home-chat-refresh-history" onClick={chat.refreshConversation}>Refresh history</Button>
        </Alert> : null}
        {chat.historyStatus === 'success' ? <>
          {chat.hasEarlierMessages ? <div className="home-chat-earlier"><Button type="button" variant="ghost" data-testid="home-chat-load-earlier" disabled={chat.busy} onClick={() => { void chat.loadEarlierMessages(); }}>Load earlier messages</Button></div> : null}
          {chat.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length === 0 ? <div className="home-chat-empty" data-testid="home-chat-empty"><strong>{isWorkspace ? 'Start planning for this workspace.' : 'Start with a question or a task you want to plan.'}</strong>{!isWorkspace ? <p>Your saved messages will appear here.</p> : null}</div> : null}
          <ol className="home-chat-messages" aria-label="Conversation messages" data-testid="home-chat-messages">
            {chat.messages.filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => {
              const status = message.role === 'user' ? chat.loadStatus(message.turnId) : null;
              return <li className={`home-chat-message home-chat-message-${message.role}`} key={message.id} data-message-id={message.id}>
                <span className="home-chat-message-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
                <div className="home-chat-message-body">{message.role === 'assistant' ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}</div>
                {status ? <span className={`home-chat-turn-status home-chat-turn-status-${statusClass(status)}`} data-turn-id={message.turnId}>{status}</span> : null}
              </li>;
            })}
          </ol>
        </> : null}
        {chat.historyStatus === 'idle' && (!chat.selectedConversationId && (chat.isNewConversation || chat.listStatus === 'success')) ? <div className="home-chat-empty" data-testid="home-chat-empty"><strong>{isWorkspace ? 'Start planning for this workspace.' : 'Start with a question or a task you want to plan.'}</strong>{!isWorkspace ? <p>Your saved messages will appear here.</p> : null}</div> : null}

        {currentTurnDecisionIsPrivate && currentDisclosurePhase === 'initial' ? <Alert tone="info" live="polite" data-testid="home-chat-kept-private">Kept private. Your message remains in this conversation and in the composer.</Alert> : null}
        {currentTurnDecisionIsPrivate && currentDisclosurePhase === 'tool_result' ? <Alert tone="info" live="polite" data-testid="home-chat-kept-private">Kept private.</Alert> : null}

        {chat.sendStatus === 'creating' ? <p className="home-chat-live-status" role="status" aria-live="polite">Saving conversation…</p> : null}
        {chat.sendStatus === 'submitting' || chat.sendStatus === 'retrying' ? <p className="home-chat-live-status" role="status" aria-live="polite">Sending your message…</p> : null}
        {chat.sendStatus === 'reconciling' ? <p className="home-chat-live-status" role="status" aria-live="polite">Checking whether your message was saved…</p> : null}
        {chat.activeTurn?.status === 'running' ? <p className="home-chat-live-status" role="status" aria-live="polite">Assistant is responding…</p> : null}
        {chat.activeTurn?.status === 'cancel_requested' ? <p className="home-chat-live-status" role="status" aria-live="polite">Stopping…</p> : null}
        {chat.activeTurn?.status === 'unknown' ? <Alert tone="warning" data-testid="home-chat-unknown-status">
          <span>This response stopped before its result was confirmed. Refresh its status before starting a fresh request.</span>
          <Button type="button" variant="secondary" data-testid="home-chat-check-turn-status" disabled={chat.statusCheckPending} onClick={() => { void chat.checkTurnStatus(); }}>Check status</Button>
        </Alert> : null}
        {chat.activeTurn?.status === 'cancel_requested' || (chat.activeTurn?.status === 'running' && chat.cancelNeedsCheck) ? <div className="home-chat-stop-row">
          <Button type="button" variant="secondary" data-testid="home-chat-check-turn-status" disabled={chat.statusCheckPending} onClick={() => { void chat.checkTurnStatus(); }}>Check status</Button>
        </div> : null}
        {chat.sendError ? <Alert tone="error" role="alert" data-testid="home-chat-send-error">
          <span>{chat.sendError}</span>
          {chat.createNeedsRetry ? <Button type="button" variant="secondary" data-testid="home-chat-retry-create" disabled={chat.busy || disabled} onClick={() => { void chat.retryCreate(); }}>Retry conversation creation</Button> : null}
          {chat.sendStatus === 'uncertain' && chat.submitCanRetry ? <>
            <Button type="button" variant="secondary" data-testid="home-chat-check-submission" disabled={chat.busy || disabled} onClick={() => { void chat.checkSubmission(); }}>Check status</Button>
            <Button type="button" variant="secondary" data-testid="home-chat-retry-send" disabled={chat.busy || disabled} onClick={() => { void chat.retrySameSubmission(); }}>Retry same send</Button>
          </> : null}
          {chat.sendStatus === 'uncertain' && !chat.submitCanRetry ? <Button type="button" variant="secondary" data-testid="home-chat-refresh-submission" disabled={chat.busy} onClick={() => { void chat.checkSubmission(); }}>Refresh status</Button> : null}
        </Alert> : null}

        {chat.activeTurn?.status === 'running' ? <div className="home-chat-stop-row"><Button type="button" variant="secondary" data-testid="home-chat-stop" disabled={disabled || chat.cancelPending} onClick={() => { void chat.cancel(); }}>{chat.cancelPending ? 'Stopping…' : 'Stop response'}</Button></div> : null}

        <form className="home-chat-composer" onSubmit={handleSubmit}>
          <Label htmlFor={isWorkspace ? 'planning-chat-message' : 'home-chat-message'}>Message the assistant</Label>
          <Textarea
            id={isWorkspace ? 'planning-chat-message' : 'home-chat-message'}
            data-testid="home-chat-input"
            rows={4}
            maxLength={20000}
            placeholder={isWorkspace ? 'Start planning for this workspace…' : 'Ask a question or plan your next step…'}
            value={chat.draft}
            onChange={(event) => { chat.setDraft(event.target.value); if (chat.sendError) chat.clearSendError(); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void chat.send(); } }}
            disabled={composerDisabled}
            aria-describedby={`${isWorkspace && disabled ? archivedId : ''} home-chat-help`.trim()}
          />
          <div className="home-chat-composer-footer">
            <p id="home-chat-help" className="field-help">Ctrl+Enter or Cmd+Enter to send.</p>
            <span className="home-chat-character-count" aria-live="off">{chat.draft.length.toLocaleString()} / 20,000</span>
            <Button type="submit" data-testid="home-chat-send" disabled={!chat.canSend} aria-busy={chat.sendStatus === 'submitting'}>Send</Button>
          </div>
        </form>
      </div>
    </div>

    {chat.pendingDisclosure && !disabled ? <ConsentDialog scopeLabel={scopeLabel} pending={chat.pendingDisclosure} busy={chat.decisionPending} onDecision={(decision) => { void chat.decide(decision); }} /> : null}
  </section>;
}

interface HistoryListProps {
  readonly chat: ReturnType<typeof useHomeChat>;
  readonly disabled: boolean;
  readonly testIdPrefix: string;
}

function HistoryList({ chat, disabled, testIdPrefix }: HistoryListProps): React.JSX.Element {
  return <div className="home-chat-history-content">
    <div className="home-chat-history-heading"><h3>Saved conversations</h3><Button type="button" variant="ghost" data-testid={`${testIdPrefix}-new`} aria-label="New conversation" disabled={disabled || chat.busy || chat.navigationLocked} onClick={chat.startNewConversation}>New</Button></div>
    {chat.listStatus === 'loading' ? <div aria-busy="true"><p role="status">Loading history…</p><Skeleton className="home-chat-history-skeleton" /></div> : null}
    {chat.listStatus === 'error' ? <div className="home-chat-history-error" role="alert"><p>{chat.listError}</p><Button type="button" variant="secondary" data-testid={`${testIdPrefix}-retry`} onClick={chat.retryConversationList}>Retry history</Button></div> : null}
    {chat.listStatus === 'success' && chat.conversations.length === 0 ? <p className="home-chat-history-empty">No saved conversations yet.</p> : null}
    {chat.conversations.length ? <ul className="home-chat-history-list">
      {chat.conversations.map((conversation) => <li key={conversation.id}>
        <Link data-testid={`${testIdPrefix}-link-${conversation.id}`} to={`?conversation=${encodeURIComponent(conversation.id)}`} className="home-chat-history-item" aria-current={chat.selectedConversationId === conversation.id ? 'page' : undefined} aria-disabled={disabled || chat.busy || chat.navigationLocked || undefined} tabIndex={disabled || chat.busy || chat.navigationLocked ? -1 : undefined} onClick={(event) => { if (disabled || chat.busy || chat.navigationLocked) event.preventDefault(); }}>
          <strong>{conversation.title}</strong><time dateTime={conversation.updatedAt}>{new Date(conversation.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
        </Link>
      </li>)}
    </ul> : null}
    {chat.hasMoreConversations ? <Button className="home-chat-more-history" type="button" variant="ghost" data-testid={`${testIdPrefix}-more`} disabled={chat.busy} onClick={() => { void chat.loadMoreConversations(); }}>{chat.listStatus === 'loading' ? 'Loading…' : 'More history'}</Button> : null}
  </div>;
}

interface ConsentDialogProps {
  readonly scopeLabel: string;
  readonly pending: NonNullable<ReturnType<typeof useHomeChat>['pendingDisclosure']>;
  readonly busy: boolean;
  readonly onDecision: (decision: 'allow' | 'deny') => void;
}

function ConsentDialog({ scopeLabel, pending, busy, onDecision }: ConsentDialogProps): React.JSX.Element {
  const { disclosure } = pending;
  return <DialogRoot open onOpenChange={() => { /* A pending consent decision stays open until the server confirms it. */ }}>
    <DialogContent className="home-chat-consent" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
      <DialogTitle>{disclosure.phase === 'initial' ? 'Allow this turn?' : 'Share this result?'}</DialogTitle>
      <DialogDescription>
        Your message is saved in this conversation. The provider will receive only the information listed here if you allow.
      </DialogDescription>
      <dl className="home-chat-disclosure">
        <div><dt>Provider</dt><dd>{disclosure.provider.name}</dd></div>
        <div><dt>Model</dt><dd>{disclosure.provider.model}</dd></div>
        <div><dt>Scope</dt><dd>{scopeLabel}</dd></div>
        <div><dt>Items</dt><dd>{disclosure.itemCount}</dd></div>
        <div><dt>Categories</dt><dd><ul>{disclosure.categories.map((category) => <li key={category}>{CATEGORY_LABELS[category] ?? category}</li>)}</ul></dd></div>
        {disclosure.byteLimit > 0 ? <div><dt>Maximum size</dt><dd>{formatBytes(disclosure.byteLimit)}</dd></div> : null}
      </dl>
      {disclosure.phase === 'initial' ? <p className="home-chat-disclosure-note">Recent messages, when included, are limited to at most 8 earlier user or assistant messages from this conversation (up to 64 KiB of redacted text). Files, shell access, project chats, project facts, and other conversations are outside this disclosure.</p> : <p className="home-chat-disclosure-note">The requested task or workspace result is not shown here. Denying keeps that result private.</p>}
      <p className="home-chat-consent-saving" role="status" aria-live="polite">{busy ? 'Saving your decision…' : ''}</p>
      <div className="home-chat-consent-actions">
        <Button type="button" variant="secondary" data-testid="home-chat-consent-deny" disabled={busy} onClick={() => onDecision('deny')}>Keep private</Button>
        <Button type="button" data-testid="home-chat-consent-allow" disabled={busy} onClick={() => onDecision('allow')}>{disclosure.phase === 'initial' ? 'Allow this turn' : 'Share and continue'}</Button>
      </div>
    </DialogContent>
  </DialogRoot>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes maximum`;
  return `${Math.round(bytes / 1024)} KiB maximum`;
}

function statusClass(status: string): string {
  if (status === 'Completed') return 'success';
  if (status === 'Cancelled — kept private' || status === 'Cancelled') return 'neutral';
  if (status === 'Assistant is responding…' || status === 'Stopping…') return 'active';
  if (status === 'Needs review' || status === 'Planning runtime unavailable' || status === 'Failed') return 'warning';
  return 'neutral';
}
