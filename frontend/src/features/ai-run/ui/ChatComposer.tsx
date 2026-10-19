import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAppSelector } from '@/app/store/hooks';
import { cancelAiRun, type AiRunSnapshot } from '@/entities/ai-run';
import { AccountUsageGateNotice, useAccountUsage } from '@/entities/account-usage';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { selectCsrfToken } from '@/entities/user-session';
import { AssistantPolicySummary } from '@/features/assistant-policy-status';
import { useWorkspaceAssistantPolicy } from '@/features/ai-run/model/use-workspace-assistant-policy';
import { useDirectChat } from '@/features/ai-run/model/use-direct-chat';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';
import { RunStatusCard } from '@/features/ai-run/ui/RunStatusCard';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, Icon, Label, Textarea } from '@/shared/ui';

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
  const policy = useWorkspaceAssistantPolicy(projectId);
  const usage = useAccountUsage();
  const quotaAvailable = usage.state.status === 'success' && usage.state.data.availability.canSubmit;
  const [legacyCancelPending, setLegacyCancelPending] = useState(false);
  const [legacyCancelError, setLegacyCancelError] = useState<string | null>(null);
  const legacyCancelKey = useRef<{ readonly runId: string; readonly key: string } | null>(null);
  const chat = useDirectChat({ projectId, conversationId, csrfToken, disabled, permissionListReady: policy.ready, onHistory: onConversationReconciled });
  const timeline = chat.run && shouldRenderTimeline(chat.run) ? <AiRunTimeline key={chat.run.runId} compact snapshot={chat.run} manifest={chat.manifest}
    projectId={projectId} conversationId={conversationId} csrfToken={csrfToken} disabled={disabled} onSnapshotChange={chat.setRun}
    onConversationReconciled={onConversationReconciled} /> : null;
  const legacyPending = chat.run?.status === 'pending_approval' && chat.run.decision === 'pending';
  const showStatusCard = Boolean(chat.run && ['rejected', 'staging'].includes(chat.run.status));
  const canEditDraft = !disabled && !chat.lockDraft;

  useEffect(() => {
    legacyCancelKey.current = null;
    setLegacyCancelError(null);
  }, [chat.run?.runId]);

  async function cancelLegacyRun(): Promise<void> {
    const run = chat.run;
    if (!legacyPending || !run || !csrfToken || legacyCancelPending) return;
    setLegacyCancelPending(true);
    setLegacyCancelError(null);
    const key = legacyCancelKey.current?.runId === run.runId ? legacyCancelKey.current.key : createIdempotencyKey();
    legacyCancelKey.current = { runId: run.runId, key };
    try {
      const cancelled = await cancelAiRun(run.runId, csrfToken, key);
      chat.setRun(cancelled);
      legacyCancelKey.current = null;
    } catch {
      setLegacyCancelError('This older run could not be cancelled. Refresh its saved status before trying again.');
    } finally {
      setLegacyCancelPending(false);
    }
  }

  const retryError = (): void => {
    if (chat.errorAction === 'retry-send' && quotaAvailable) void chat.retrySend();
    else if (chat.run) void chat.refreshStatus();
    else chat.refresh();
  };

  return (
    <section className="chat-composer max-h-[55%] overflow-y-auto" aria-label="Message composer" tabIndex={0} data-testid="chat-composer">
      {timelineTarget ? createPortal(timeline, timelineTarget) : timeline}
      <AssistantPolicySummary compact status={policy.status} policy={policy.policy} />
      <AccountUsageGateNotice state={usage.state} />
      {policy.status === 'error' ? <Alert tone="error" role="alert" data-testid="workspace-policy-load-error">
        <p>Workspace assistant policy could not be checked. Sending stays paused until it can be verified.</p>
        <Button type="button" variant="secondary" onClick={policy.retry}>Retry policy check</Button>
      </Alert> : null}
      {legacyPending ? <Alert tone="warning" role="status" data-testid="ai-run-legacy-pending">
        <p>This older run is waiting for a decision that is no longer available. It will not resume under the current workspace policy.</p>
        <p>Cancel it or return to the conversation history. A fresh request will use the current scope policy.</p>
        <div className="composer-actions">
          <Button type="button" variant="secondary" data-testid="ai-run-legacy-cancel" disabled={!csrfToken || legacyCancelPending} aria-busy={legacyCancelPending} onClick={() => { void cancelLegacyRun(); }}>
            {legacyCancelPending ? 'Cancelling older run...' : 'Cancel older run'}
          </Button>
          <Button type="button" variant="secondary" data-testid="ai-run-legacy-refresh" disabled={chat.restoring} onClick={() => { void chat.refreshStatus(); }}>Refresh run status</Button>
        </div>
        {legacyCancelError ? <p role="alert" data-testid="ai-run-legacy-cancel-error">{legacyCancelError}</p> : null}
      </Alert> : null}
      {chat.restoredRecoveryNeedsReview ? <Alert tone="warning" data-testid="ai-run-restored-request-unavailable" role="status">
        <p>This restored run cannot be safely matched to its original request, so retry is unavailable. Review the saved message in conversation history before starting another request.</p>
        {chat.run?.providerTransmission === 'not_started_confirmed'
          ? <p>The server confirmed that no provider request was sent. Enter the request again below to create a fresh policy-bound run.</p>
          : <><p>Provider transmission remains unconfirmed. Refresh the saved run before resending; new sends stay blocked while status is unresolved.</p>
            <Button type="button" variant="secondary" data-testid="ai-run-restored-request-refresh" disabled={chat.restoring} onClick={() => { void chat.refreshStatus(); }}>Refresh run status</Button></>}
      </Alert> : null}
      {chat.pending || chat.restoring && legacyPending ? <p className="form-status" data-testid="chat-send-status" role="status" aria-live="polite">
        {chat.pending ? 'Starting assistant run...' : 'Checking saved run status...'}
      </p> : null}
      <form className="message-composer" onSubmit={(event) => { event.preventDefault(); if (quotaAvailable) void chat.send(); }}>
        <Label htmlFor="chat-message">Message</Label>
        <Textarea id="chat-message" data-testid="message-input" placeholder="Message the assistant" rows={3} value={chat.content}
          onChange={(event) => chat.setContent(event.target.value)}
          onKeyDown={(event) => { if (quotaAvailable && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void chat.send(); } }}
          aria-describedby={disabled ? archivedDescriptionId : 'chat-send-help'} disabled={!canEditDraft || chat.pending} />
        <div className="composer-actions">
          <p id="chat-send-help" className="field-help">Ctrl+Enter or Cmd+Enter to send.</p>
          <Button ref={submitButton} type="submit" data-testid="ai-run-submit" aria-busy={chat.pending}
            aria-describedby={disabled ? archivedDescriptionId : undefined}
            disabled={disabled || !quotaAvailable || !policy.ready || chat.busy || !csrfToken || !chat.content.trim()}>
            {chat.pending ? 'Sending...' : 'Send'}<Icon name="arrow" size={18} />
          </Button>
        </div>
      </form>
      {chat.error ? <Alert tone="error" role="alert" data-testid="chat-send-error"><p>{chat.error}</p>
        {chat.errorAction ? <Button type="button" variant="secondary" disabled={chat.pending || chat.restoring || chat.errorAction === 'retry-send' && !quotaAvailable} onClick={retryError}>
          {chat.errorAction === 'retry-send' ? 'Try again' : 'Refresh run status'}
        </Button> : null}
      </Alert> : null}
      {showStatusCard && chat.run ? <RunStatusCard state={{ snapshot: chat.run, manifest: chat.manifest }}
        conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`}
        retryDisabled={!quotaAvailable}
        onRetry={() => { void chat.safeRetry(); }} onRefresh={() => { void chat.refreshStatus(); }} /> : null}
      {chat.safeRetryAvailable && policy.ready ? <Button type="button" variant="secondary" data-testid="ai-run-safe-retry" disabled={disabled || !quotaAvailable || chat.pending || chat.restoring || !csrfToken} onClick={() => { void chat.safeRetry(); }}>Try again</Button> : null}
      {chat.separateRunAvailable && policy.ready ? <Button type="button" variant="secondary" data-testid="ai-run-separate-request" disabled={disabled || !quotaAvailable || chat.pending || chat.restoring || !csrfToken} onClick={() => chat.setDuplicateWorkConfirm(true)}>Start a separate run</Button> : null}
      <AlertDialogRoot open={chat.duplicateWorkConfirm} onOpenChange={(open) => { if (!open) chat.setDuplicateWorkConfirm(false); }}>
        <AlertDialogContent data-testid="ai-run-duplicate-work-warning" onCloseAutoFocus={(event) => { event.preventDefault(); submitButton.current?.focus(); }}>
          <AlertDialogTitle>Start a separate assistant run?</AlertDialogTitle>
          <AlertDialogDescription>The provider may already have received the earlier request. Starting a separate run may repeat provider work.</AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">Keep current run</Button></AlertDialogCancel>
            <Button type="button" data-testid="ai-run-separate-confirm" disabled={disabled || !quotaAvailable || chat.pending || chat.restoring || !policy.ready || !csrfToken} onClick={() => { void chat.startSeparateRun(); }}>Confirm and start separate run</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </section>
  );
}

function shouldRenderTimeline(snapshot: AiRunSnapshot): boolean {
  return ['approved', 'policy_authorized'].includes(snapshot.decision) && snapshot.phase !== 'staging' && snapshot.status !== 'rejected'
    && ['ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'succeeded', 'failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status);
}
