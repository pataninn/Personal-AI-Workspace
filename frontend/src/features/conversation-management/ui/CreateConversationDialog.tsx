import { useEffect, useRef, useState } from 'react';

import { createConversation } from '@/entities/conversation';
import type { ConversationSnapshot } from '@/entities/conversation';
import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import {
  Alert,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  Input,
  Label
} from '@/shared/ui';
import { validateConversationTitle, type ConversationTitleErrors } from '@/features/conversation-management/model/conversation-validation';

interface CreateConversationDialogProps {
  readonly projectId: string;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (conversation: ConversationSnapshot) => void;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return 'We could not save this conversation. Try again.';
  }
  if (error.code === 'PROJECT_ARCHIVED') {
    return 'This project is archived. Existing messages are read-only.';
  }
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
    return 'This create attempt changed before it finished. Start it again.';
  }
  return 'We could not save this conversation. Check the name and try again.';
}

export function CreateConversationDialog({ projectId, open, disabled, archivedDescriptionId, onOpenChange, onCreated }: CreateConversationDialogProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [errors, setErrors] = useState<ConversationTitleErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [attemptedTitle, setAttemptedTitle] = useState<string | null>(null);
  const readOnlyDescriptionId = archivedDescriptionId ?? 'project-archived-message';

  useEffect(() => {
    if (open) {
      setErrors({});
      setFormError(null);
    }
  }, [open]);

  useEffect(() => {
    if (errors.title) {
      titleRef.current?.focus();
    }
  }, [errors]);

  async function submit(): Promise<void> {
    const nextErrors = validateConversationTitle(title);
    setErrors(nextErrors);
    setFormError(null);
    if (nextErrors.title || !csrfToken || disabled || isCreating) {
      return;
    }
    const normalizedTitle = title.trim();
    const key = intentKey && attemptedTitle === normalizedTitle ? intentKey : createIdempotencyKey();
    setIntentKey(key);
    setAttemptedTitle(normalizedTitle);
    setIsCreating(true);
    try {
      const conversation = await createConversation(projectId, { title: normalizedTitle }, csrfToken, key);
      setTitle('');
      setIntentKey(null);
      setAttemptedTitle(null);
      onOpenChange(false);
      onCreated(conversation);
    } catch (error: unknown) {
      setFormError(errorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={(nextOpen) => !isCreating && onOpenChange(nextOpen)}>
      <DialogContent data-testid="conversation-create-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus(); }}>
        <DialogTitle>Create conversation</DialogTitle>
        <DialogDescription>This conversation belongs only to this project. Saving a message stores it without starting an AI run.</DialogDescription>
        <form className="conversation-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="field-group">
            <Label htmlFor="conversation-title">Conversation name</Label>
            <Input
              ref={titleRef}
              id="conversation-title"
              data-testid="conversation-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-required="true"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={[errors.title ? 'conversation-title-error' : 'conversation-title-help', disabled ? readOnlyDescriptionId : null].filter(Boolean).join(' ')}
              disabled={isCreating || disabled}
            />
            <p id="conversation-title-help" data-testid="conversation-title-help" className="field-help">Use a short name you will recognize later.</p>
            {errors.title ? <p id="conversation-title-error" data-testid="conversation-title-error" role="alert" className="field-error">{errors.title}</p> : null}
          </div>
          {disabled && !archivedDescriptionId ? <p id={readOnlyDescriptionId} data-testid="project-archived-message" className="field-help">This project is archived. Existing messages are read-only.</p> : null}
          {formError ? <Alert tone="error" data-testid="conversation-create-error" role="alert">{formError}</Alert> : null}
          <div className="dialog-actions">
            <DialogClose asChild><Button type="button" variant="secondary" data-testid="conversation-create-cancel" disabled={isCreating}>Cancel</Button></DialogClose>
            <Button type="submit" data-testid="conversation-create-submit" aria-busy={isCreating} aria-describedby={disabled ? readOnlyDescriptionId : undefined} disabled={isCreating || disabled || !csrfToken}>{isCreating ? 'Creating conversation…' : 'Create conversation'}</Button>
          </div>
          <p data-testid="conversation-create-status-message" className="form-status" role="status" aria-live="polite">{isCreating ? 'Creating conversation…' : ''}</p>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
