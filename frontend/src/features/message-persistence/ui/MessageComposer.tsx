import { useRef, useState } from 'react';

import { createMessage } from '@/entities/conversation';
import type { MessageSnapshot } from '@/entities/message';
import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, Button, Label, Textarea } from '@/shared/ui';
import { validateMessageContent } from '@/features/message-persistence/model/message-validation';

interface MessageComposerProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly inputLabel?: string;
  readonly inputHelp?: string;
  readonly renderAdditionalActions?: (content: string) => React.ReactNode;
  readonly onSaved: (message: MessageSnapshot) => void;
}

function requestError(error: unknown): { readonly field?: string; readonly message: string } {
  if (error instanceof ApiClientError) {
    const detail = error.details.find((candidate) => candidate.field === 'content');
    if (detail) {
      return { field: 'content', message: detail.message };
    }
    if (error.code === 'PROJECT_ARCHIVED') {
      return { message: 'This project is archived. Existing messages are read-only.' };
    }
  }
  return { message: 'We could not save this message. Keep the draft and try again.' };
}

export function MessageComposer({ projectId, conversationId, disabled, archivedDescriptionId, inputLabel = 'Message', inputHelp, renderAdditionalActions, onSaved }: MessageComposerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [attemptedContent, setAttemptedContent] = useState<string | null>(null);
  const [savedAnnouncement, setSavedAnnouncement] = useState('');
  const readOnlyDescriptionId = archivedDescriptionId ?? 'project-archived-message';
  const aiRequestBlank = Boolean(renderAdditionalActions && content.trim().length === 0);

  async function submit(): Promise<void> {
    const validation = validateMessageContent(content);
    setFieldError(validation.content ?? null);
    setFormError(null);
    setSavedAnnouncement('');
    if (validation.content || disabled || !csrfToken || isSaving) {
      return;
    }
    const key = intentKey && attemptedContent === content ? intentKey : createIdempotencyKey();
    setIntentKey(key);
    setAttemptedContent(content);
    setIsSaving(true);
    try {
      const message = await createMessage(projectId, conversationId, { content }, csrfToken, key);
      onSaved(message);
      setContent('');
      setIntentKey(null);
      setAttemptedContent(null);
      setSavedAnnouncement('Message saved.');
      inputRef.current?.focus();
    } catch (error: unknown) {
      const mapped = requestError(error);
      if (mapped.field === 'content') {
        setFieldError(mapped.message);
      } else {
        setFormError(mapped.message);
      }
    } finally {
      setIsSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <>
      <form className="message-composer" data-testid="message-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="field-group" data-testid={renderAdditionalActions ? 'ai-run-message-input' : undefined}>
          <Label htmlFor="message-input">{inputLabel}</Label>
          <Textarea
            ref={inputRef}
            id="message-input"
            data-testid="message-input"
            rows={5}
            value={content}
            onChange={(event) => { setContent(event.target.value); if (fieldError) setFieldError(null); }}
            onKeyDown={handleKeyDown}
            aria-required="true"
            aria-invalid={Boolean(fieldError) || aiRequestBlank}
            aria-describedby={[fieldError ? 'message-input-error' : 'message-input-help', renderAdditionalActions ? 'ai-run-help' : null, aiRequestBlank ? 'ai-run-request-error' : null, disabled ? readOnlyDescriptionId : null].filter(Boolean).join(' ')}
            disabled={disabled || isSaving}
          />
          <p id="message-input-help" className="field-help">{inputHelp ?? 'Ctrl+Enter or Cmd+Enter saves the message. Saving does not start an AI run.'}</p>
          {fieldError ? <p id="message-input-error" data-testid="message-input-error" role="alert" className="field-error">{fieldError}</p> : null}
        </div>
        {disabled && !archivedDescriptionId ? <p id={readOnlyDescriptionId} data-testid="project-archived-message" className="field-help">This project is archived. Existing messages are read-only.</p> : null}
        {formError ? <Alert tone="error" data-testid="message-save-error" role="alert"><p>{formError}</p><Button type="button" variant="secondary" data-testid="message-retry-button" onClick={() => { void submit(); }}>Retry saving</Button></Alert> : null}
        <div className="composer-actions">
          <Button type="submit" variant={renderAdditionalActions ? 'secondary' : 'primary'} data-testid="message-submit" aria-busy={isSaving} aria-describedby={disabled ? readOnlyDescriptionId : undefined} disabled={disabled || isSaving || !csrfToken}>{isSaving ? 'Saving message…' : 'Save message'}</Button>
        </div>
        {isSaving ? <p data-testid="message-pending" className="form-status" role="status" aria-live="polite">Saving message…</p> : null}
        <p data-testid="message-submit-status" className="form-status" role="status" aria-live="polite">{isSaving ? 'Saving message…' : savedAnnouncement}</p>
      </form>
      {renderAdditionalActions?.(content)}
    </>
  );
}
