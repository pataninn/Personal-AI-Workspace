import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import type { AiRunSnapshot } from '@/entities/ai-run';
import { Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, Icon, Label, Textarea } from '@/shared/ui';
import { useDirectChat } from '@/features/ai-run/model/use-direct-chat';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';
import { ProviderConsentDialog } from '@/features/ai-run/ui/ProviderConsentDialog';
import { ProviderPermissionManager } from '@/features/ai-run/ui/ProviderPermissionManager';
import { RunStatusCard } from '@/features/ai-run/ui/RunStatusCard';

interface ChatComposerProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly history: ConversationHistoryResponse | null;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly timelineTarget?: HTMLElement | null;
  readonly onConversationReconciled: (history: ConversationHistoryResponse) => void;
}

export function ChatComposer({ projectId, conversationId, disabled, archivedDescriptionId, timelineTarget, onConversationReconciled }: ChatComposerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [permissionListReady, setPermissionListReady] = useState(false);
  const chat = useDirectChat({ projectId, conversationId, csrfToken, disabled, permissionListReady, onHistory: onConversationReconciled });
  const timeline = chat.run && shouldRenderTimeline(chat.run) ? <AiRunTimeline key={chat.run.runId} compact snapshot={chat.run} manifest={chat.manifest}
    projectId={projectId} conversationId={conversationId} csrfToken={csrfToken} disabled={disabled} onSnapshotChange={chat.setRun}
    onConversationReconciled={onConversationReconciled} /> : null;
  const showStatusCard = Boolean(chat.run && ['rejected', 'staging'].includes(chat.run.status));
  const canEditDraft = !disabled && !chat.lockDraft;

  const handlePermissionListStateChange = useCallback((ready: boolean): void => setPermissionListReady(ready), []);
  useEffect(() => { setPermissionListReady(false); }, [projectId]);
  const handleCloseConsent = (event: Event): void => {
    event.preventDefault();
    submitButton.current?.focus();
  };
  const retryError = (): void => {
    if (chat.errorAction === 'retry-send') void chat.retrySend();
    else if (chat.run) void chat.refreshStatus();
    else chat.refresh();
  };

  return (
    <section className="chat-composer" data-testid="chat-composer">
      {timelineTarget ? createPortal(timeline, timelineTarget) : timeline}
      {chat.run?.providerApprovalMode === 'remembered_permission' ? <Alert tone="warning" data-testid="ai-run-remembered-permission-notice" role="status">
        <p><strong>Using saved provider permission.</strong> This request and its selected project context match an active permission.</p>
        {chat.manifest ? <p>Provider: {chat.manifest.provider}. Model: {chat.manifest.model}.</p> : null}
        <a href="#provider-permission-manager">Review or revoke provider permissions</a>
      </Alert> : null}
      {chat.restoredRecoveryNeedsReview ? <Alert tone="warning" data-testid="ai-run-restored-request-unavailable" role="status">
        <p>This restored run cannot be safely matched to its original request, so retry is unavailable. Review the saved message in conversation history before starting another request.</p>
        {chat.run?.providerTransmission === 'not_started_confirmed'
          ? <p>The server confirmed that no provider request was sent. Enter the request again below to create a new run with a fresh disclosure.</p>
          : <><p>Provider transmission remains unconfirmed. Refresh the saved run before resending; new sends stay blocked while status is unresolved.</p>
            <Button type="button" variant="secondary" data-testid="ai-run-restored-request-refresh" disabled={chat.restoring} onClick={() => { void chat.refreshStatus(); }}>Refresh run status</Button></>}
      </Alert> : null}
      {chat.pending || chat.restoring && isPendingRun(chat.run) ? <p className="form-status" data-testid="chat-send-status" role="status" aria-live="polite">
        {chat.pending ? 'Saving your message and preparing provider disclosure…' : 'Preparing provider disclosure…'}
      </p> : null}
      <form className="message-composer" onSubmit={(event) => { event.preventDefault(); void chat.send(); }}>
        <Label htmlFor="chat-message">Message</Label>
        <Textarea id="chat-message" data-testid="message-input" placeholder="Message the assistant" rows={3} value={chat.content}
          onChange={(event) => chat.setContent(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void chat.send(); } }}
          aria-describedby={disabled ? archivedDescriptionId : 'chat-send-help'} disabled={!canEditDraft || chat.pending} />
        <div className="composer-actions">
          <p id="chat-send-help" className="field-help">Sending saves your message. Provider transmission waits for your approval or an exact saved permission. Ctrl+Enter or Cmd+Enter to send.</p>
          <Button ref={submitButton} type="submit" data-testid="ai-run-submit" aria-busy={chat.pending}
            aria-describedby={disabled ? archivedDescriptionId : undefined}
            disabled={disabled || chat.busy || !csrfToken || !chat.content.trim()}>
            {chat.pending ? 'Saving…' : 'Send'}<Icon name="arrow" size={18} />
          </Button>
        </div>
      </form>
      {chat.error ? <Alert tone="error" role="alert" data-testid="chat-send-error"><p>{chat.error}</p>
        {chat.errorAction ? <Button type="button" variant="secondary" disabled={chat.pending || chat.restoring} onClick={retryError}>
          {chat.errorAction === 'retry-send' ? 'Try again' : 'Refresh run status'}
        </Button> : null}
      </Alert> : null}
      {showStatusCard && chat.run ? <RunStatusCard state={{ snapshot: chat.run, manifest: chat.manifest }}
        conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`}
        onRetry={() => { void chat.safeRetry(); }} onRefresh={() => { void chat.refreshStatus(); }} /> : null}
      {chat.safeRetryAvailable ? <Button type="button" variant="secondary" data-testid="ai-run-safe-retry" disabled={disabled || chat.pending || chat.restoring || !csrfToken} onClick={() => { void chat.safeRetry(); }}>Try again</Button> : null}
      {chat.separateRunAvailable ? <Button type="button" variant="secondary" data-testid="ai-run-separate-request" disabled={disabled || chat.pending || chat.restoring || !csrfToken} onClick={() => chat.setDuplicateWorkConfirm(true)}>Start a separate run</Button> : null}
      <ProviderPermissionManager projectId={projectId} csrfToken={csrfToken} onListStateChange={handlePermissionListStateChange} />
      <ProviderConsentDialog
        manifest={chat.manifest}
        open={chat.dialogOpen}
        decisionLoading={chat.decisionLoading || chat.restoring}
        decisionAction={chat.decisionAction}
        decisionError={chat.decisionError}
        decisionOutcomeUnknown={chat.decisionOutcomeUnknown}
        approveEnabled={isPendingRun(chat.run)}
        rememberProviderPermission={chat.rememberProviderPermission}
        showFactContent={false}
        onOpenChange={chat.handleDialogOpenChange}
        onApprove={chat.approve}
        onRememberProviderPermissionChange={chat.setRememberProviderPermission}
        onReject={chat.reject}
        onRefreshDisclosure={() => { void chat.refreshDisclosure(); }}
        onRefreshStatus={() => { void chat.refreshDecisionStatus(); }}
        onCloseAutoFocus={handleCloseConsent}
      />
      <AlertDialogRoot open={chat.duplicateWorkConfirm} onOpenChange={chat.setDuplicateWorkConfirm}>
        <AlertDialogContent data-testid="ai-run-duplicate-work-warning" onCloseAutoFocus={handleCloseConsent}>
          <AlertDialogTitle>Start a separate AI run?</AlertDialogTitle>
          <AlertDialogDescription>The provider may already have received the earlier request. Starting a separate run may repeat provider work.</AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">Keep current run</Button></AlertDialogCancel>
            <Button type="button" data-testid="ai-run-separate-confirm" disabled={disabled || chat.pending || chat.restoring || !csrfToken}
              onClick={() => { void chat.startSeparateRun(); }}>Confirm and start separate run</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </section>
  );
}

function isPendingRun(snapshot: AiRunSnapshot | null): boolean {
  return snapshot?.status === 'pending_approval' && snapshot.decision === 'pending';
}

function shouldRenderTimeline(snapshot: AiRunSnapshot): boolean {
  return snapshot.decision === 'approved' && snapshot.phase !== 'staging' && snapshot.status !== 'rejected'
    && ['ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'succeeded', 'failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status);
}
