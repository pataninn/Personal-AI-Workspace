import { useRef, useState } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { createConversation, type ConversationSnapshot } from '@/entities/conversation';
import { selectCsrfToken } from '@/entities/user-session';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, Button, TypingIndicator } from '@/shared/ui';

interface NewConversationButtonProps {
  readonly projectId: string;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly onCreated: (conversation: ConversationSnapshot) => void;
}

export function NewConversationButton({ projectId, disabled, archivedDescriptionId, onCreated }: NewConversationButtonProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const intent = useRef<{ projectId: string; key: string } | null>(null);
  async function create(): Promise<void> {
    if (busy.current || disabled || !csrfToken) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    if (intent.current?.projectId !== projectId) intent.current = { projectId, key: createIdempotencyKey() };
    try {
      const conversation = await createConversation(projectId, { title: 'New chat' }, csrfToken, intent.current.key);
      intent.current = null;
      onCreated(conversation);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return <div>
    <Button type="button" variant="secondary" data-testid="conversation-create-trigger" disabled={disabled || !csrfToken || pending} aria-describedby={disabled ? archivedDescriptionId : undefined} aria-busy={pending} onClick={() => { void create(); }}>{pending ? <TypingIndicator /> : failed ? 'Try again' : 'New chat'}</Button>
    {failed ? <Alert tone="error">Unable to open a new chat. Try again.</Alert> : null}
  </div>;
}
