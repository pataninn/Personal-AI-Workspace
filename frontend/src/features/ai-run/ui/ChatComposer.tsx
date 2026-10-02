import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { Alert, Button, Label, Textarea } from '@/shared/ui';
import { useDirectChat } from '@/features/ai-run/model/use-direct-chat';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';

interface ChatComposerProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly onConversationReconciled: (history: ConversationHistoryResponse) => void;
}

/** Render in a conversation to send directly using the project's saved context. */
export function ChatComposer({ projectId, conversationId, disabled, archivedDescriptionId, onConversationReconciled }: ChatComposerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const chat = useDirectChat({ projectId, conversationId, csrfToken, disabled, onHistory: onConversationReconciled });
  return (
    <section className="chat-composer" data-testid="chat-composer">
      {chat.run && chat.run.decision === 'approved' ? <AiRunTimeline key={chat.run.runId} compact snapshot={chat.run} projectId={projectId}
        conversationId={conversationId} csrfToken={csrfToken} disabled={disabled} onSnapshotChange={chat.setRun} onConversationReconciled={onConversationReconciled} /> : null}
      <form className="message-composer" onSubmit={(event) => { event.preventDefault(); void chat.send(); }}>
        <Label htmlFor="chat-message">Message</Label>
        <Textarea id="chat-message" data-testid="message-input" rows={3} value={chat.content}
          onChange={(event) => chat.setContent(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void chat.send(); } }}
          aria-describedby={disabled ? archivedDescriptionId : 'chat-send-help'} disabled={disabled || chat.pending} />
        <div className="composer-actions">
          <p id="chat-send-help" className="field-help">Ctrl+Enter or Cmd+Enter to send.</p>
          <Button type="submit" data-testid="chat-send" aria-busy={chat.pending} aria-describedby={disabled ? archivedDescriptionId : undefined} disabled={disabled || chat.busy || !csrfToken || !chat.content.trim()}>{chat.pending ? 'Sending…' : 'Send'}</Button>
        </div>
      </form>
      {chat.error ? <Alert tone="error" role="alert"><p>{chat.error}</p><Button type="button" variant="secondary" disabled={chat.pending || chat.restoring} onClick={chat.hasRunLink ? chat.refresh : () => { void chat.send(); }}>{chat.hasRunLink ? 'Refresh status' : 'Try again'}</Button></Alert> : null}
    </section>
  );
}
