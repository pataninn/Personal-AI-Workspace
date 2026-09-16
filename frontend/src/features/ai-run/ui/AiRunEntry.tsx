import { useEffect, useState } from 'react';

import { useAppSelector } from '@/app/store/hooks';
import {
  createAiRun,
  decideEgress,
  getAiRun,
  getEgressManifest,
  type AiRunSnapshot,
  type EgressManifest
} from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { Alert, Button } from '@/shared/ui';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

import { ProviderConsentDialog } from '@/features/ai-run/ui/ProviderConsentDialog';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';
import { CommandExecutionSurface } from '@/features/ai-run/ui/CommandExecutionSurface';
import { RunStatusCard, type RunStatusState } from '@/features/ai-run/ui/RunStatusCard';

interface AiRunEntryProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

const GENERIC_DISCLOSURE_ERROR = 'We could not prepare the provider disclosure. Keep your request and try again.';
const AMBIGUOUS_DECISION_ERROR = 'The decision outcome could not be confirmed. Refresh the run status before deciding again.';
const STALE_DISCLOSURE_ERROR = 'This disclosure is no longer current. Review the updated scope before approving.';

export function AiRunEntry({ projectId, conversationId, request, disabled, archivedDescriptionId, onConversationReconciled }: AiRunEntryProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunStatusState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionAction, setDecisionAction] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionOutcomeUnknown, setDecisionOutcomeUnknown] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [intentRequest, setIntentRequest] = useState<string | null>(null);
  const [decisionKey, setDecisionKey] = useState<string | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);

  const trimmedRequest = request.trim();
  const blankRequest = trimmedRequest.length === 0;
  const requestErrorId = 'ai-run-request-error';
  const archivedDescription = archivedDescriptionId ?? 'project-archived-message';

  useEffect(() => {
    if (intentRequest !== null && intentRequest !== request) {
      setIntentKey(null);
      setIntentRequest(null);
    }
  }, [intentRequest, request]);

  async function beginRun(forceFreshIntent = false): Promise<void> {
    setIntentError(null);
    if (blankRequest || disabled || intentLoading || decisionLoading) {
      return;
    }
    if (!csrfToken) {
      setIntentError('Your local session is no longer available. Refresh the page and try again.');
      return;
    }
    const key = !forceFreshIntent && intentKey && intentRequest === request ? intentKey : createIdempotencyKey();
    setIntentKey(key);
    setIntentRequest(request);
    setIntentLoading(true);
    setRunState(null);
    setDecisionError(null);
    setDecisionOutcomeUnknown(false);
    try {
      const intent = await createAiRun(projectId, {
        conversationId,
        request: trimmedRequest,
        context: { relativePaths: [], includeRecentMessages: false }
      }, csrfToken, key);
      let manifest = intent.manifest;
      if (!manifest) {
        try {
          manifest = await getEgressManifest(intent.runId);
        } catch (error: unknown) {
          if (!(error instanceof ApiClientError && error.statusCode === 404)) {
            throw error;
          }
        }
      }
      if (!manifest) {
        throw new ApiClientError(200, 'INVALID_RESPONSE', 'The local app did not return a provider disclosure.');
      }
      setRunState({ snapshot: intent, manifest });
      setDialogOpen(intent.status === 'pending_approval' && intent.decision === 'pending');
    } catch (error: unknown) {
      if (error instanceof ApiClientError && (error.code === 'EGRESS_MANIFEST_CONFLICT' || error.code === 'EGRESS_SOURCE_CHANGED')) {
        setIntentKey(null);
        setIntentRequest(null);
      }
      setIntentError(mapIntentError(error));
    } finally {
      setIntentLoading(false);
    }
  }

  async function submitDecision(decision: 'approve' | 'reject'): Promise<void> {
    const manifest = runState?.manifest;
    if (!manifest || !csrfToken || decisionLoading || decisionOutcomeUnknown) {
      return;
    }
    setDecisionLoading(true);
    setDecisionAction(decision);
    setDecisionError(null);
    const key = decisionKey ?? createIdempotencyKey();
    setDecisionKey(key);
    try {
      const snapshot = await decideEgress(manifest.runId, { manifestHash: manifest.manifestHash, decision }, csrfToken, key);
      setRunState({ snapshot, manifest });
      setDialogOpen(false);
      setDecisionKey(null);
      setIntentKey(null);
    } catch (error: unknown) {
      await reconcileDecisionFailure(error, manifest);
    } finally {
      setDecisionLoading(false);
      setDecisionAction(null);
    }
  }

  async function reconcileDecisionFailure(error: unknown, manifest: EgressManifest): Promise<void> {
    const knownSafeFailure = error instanceof ApiClientError && ['RUNTIME_UNAVAILABLE', 'NIM_UNAVAILABLE', 'STAGING_FAILED', 'RUN_REVIEW_REQUIRED'].includes(error.code);
    try {
      const snapshot = await getAiRun(manifest.runId);
      if (snapshot.status !== 'pending_approval' || snapshot.decision !== 'pending') {
        setRunState({ snapshot, manifest, errorCode: error instanceof ApiClientError ? error.code : undefined });
        setDialogOpen(false);
        setDecisionKey(null);
        setIntentKey(null);
        return;
      }
      if (error instanceof ApiClientError && (error.code === 'EGRESS_MANIFEST_CONFLICT' || error.code === 'EGRESS_SOURCE_CHANGED')) {
        setDecisionError(STALE_DISCLOSURE_ERROR);
        setDecisionKey(null);
        return;
      }
      setDecisionOutcomeUnknown(!knownSafeFailure);
      setDecisionError(knownSafeFailure ? mapDecisionError(error) : AMBIGUOUS_DECISION_ERROR);
    } catch {
      setDecisionOutcomeUnknown(!knownSafeFailure);
      setDecisionError(knownSafeFailure ? mapDecisionError(error) : AMBIGUOUS_DECISION_ERROR);
    }
    if (knownSafeFailure) {
      const snapshot = safeFailureSnapshot(manifest, error);
      setRunState({ snapshot, manifest, errorCode: error instanceof ApiClientError ? error.code : undefined });
      setDialogOpen(false);
      setDecisionKey(null);
      setIntentKey(null);
    }
  }

  async function refreshDisclosure(): Promise<void> {
    if (!runState?.manifest || refreshLoading) {
      return;
    }
    setRefreshLoading(true);
    try {
      const manifest = await getEgressManifest(runState.manifest.runId);
      setRunState((current) => current ? { ...current, manifest } : current);
      setDecisionError(null);
      setDecisionOutcomeUnknown(false);
      setDecisionKey(null);
    } catch (error: unknown) {
      setDecisionError(error instanceof ApiClientError && error.code === 'EGRESS_MANIFEST_CONFLICT' ? STALE_DISCLOSURE_ERROR : GENERIC_DISCLOSURE_ERROR);
    } finally {
      setRefreshLoading(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    if (!runState?.snapshot.runId || refreshLoading) {
      return;
    }
    setRefreshLoading(true);
    try {
      const snapshot = await getAiRun(runState.snapshot.runId);
      setRunState((current) => current ? { ...current, snapshot } : current);
      if (snapshot.status !== 'pending_approval' || snapshot.decision !== 'pending') {
        setDialogOpen(false);
        setDecisionOutcomeUnknown(false);
        setDecisionError(null);
      } else {
        setDecisionOutcomeUnknown(false);
        setDecisionError(null);
      }
    } catch {
      setDecisionError(AMBIGUOUS_DECISION_ERROR);
    } finally {
      setRefreshLoading(false);
    }
  }

  function retryRun(): void {
    setRunState(null);
    setIntentError(null);
    setDecisionError(null);
    setDecisionOutcomeUnknown(false);
    setIntentKey(null);
    setIntentRequest(null);
    void beginRun(true);
  }

  function handleDialogOpenChange(open: boolean): void {
    if (open) {
      setDialogOpen(true);
      return;
    }
    if (!decisionLoading && !decisionOutcomeUnknown) {
      void submitDecision('reject');
    }
  }

  const formError = intentError ? <Alert tone="error" data-testid="ai-run-error" role="alert"><p>{intentError}</p><Button type="button" variant="secondary" data-testid="ai-run-error-retry" disabled={disabled || intentLoading} onClick={() => { void beginRun(); }}>Try again</Button></Alert> : null;
  const blankMessage = blankRequest ? 'Enter a request before asking the assistant.' : null;

  return (
    <>
      <section className="ai-run-entry" data-testid="ai-run-entry" aria-describedby={disabled ? archivedDescription : undefined}>
        <form data-testid="ai-run-form" onSubmit={(event) => { event.preventDefault(); void beginRun(); }}>
          <p className="field-help" id="ai-run-help">Ask AI first shows what will be sent to NVIDIA NIM. Saving a message does not start a run.</p>
          {blankMessage ? <p className="field-error" data-testid="ai-run-request-error" id={requestErrorId} role="alert">{blankMessage}</p> : null}
          <div className="composer-actions ai-run-actions">
            <Button
              type="submit"
              data-testid="ai-run-submit"
              aria-busy={intentLoading}
              aria-describedby={["ai-run-help", blankMessage ? requestErrorId : null, disabled ? archivedDescription : null].filter(Boolean).join(' ')}
              disabled={disabled || intentLoading || decisionLoading || !csrfToken || blankRequest}
            >
              {intentLoading ? <><span data-testid="ai-run-manifest-loading">Preparing provider disclosure…</span></> : 'Ask AI'}
            </Button>
          </div>
          {intentLoading ? <p className="form-status" data-testid="ai-run-manifest-loading-status" role="status" aria-live="polite">Preparing provider disclosure…</p> : null}
          {formError}
        </form>
        {runState ? <RunStatusCard state={runState} conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`} onRetry={retryRun} onRefresh={refreshStatus} /> : null}
        {runState && shouldRenderTimeline(runState.snapshot) ? <AiRunTimeline snapshot={runState.snapshot} projectId={projectId} conversationId={conversationId} csrfToken={csrfToken} disabled={disabled} onSnapshotChange={(snapshot) => { setRunState((current) => current ? { ...current, snapshot } : current); }} onConversationReconciled={onConversationReconciled} /> : null}
        {runState && shouldRenderCommandSurface(runState.snapshot) && runState.snapshot.runtime?.sandboxReady ? <CommandExecutionSurface run={runState.snapshot} readOnly={disabled} conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`} /> : null}
      </section>
      <ProviderConsentDialog
        manifest={runState?.manifest ?? null}
        open={dialogOpen}
        decisionLoading={decisionLoading || refreshLoading}
        decisionAction={decisionAction}
        decisionError={decisionError}
        decisionOutcomeUnknown={decisionOutcomeUnknown}
        approveEnabled={runState?.snapshot.status === 'pending_approval' && runState.snapshot.decision === 'pending'}
        onOpenChange={handleDialogOpenChange}
        onApprove={() => { void submitDecision('approve'); }}
        onReject={() => { void submitDecision('reject'); }}
        onRefreshDisclosure={() => { void refreshDisclosure(); }}
        onRefreshStatus={() => { void refreshStatus(); }}
      />
    </>
  );
}

function shouldRenderTimeline(snapshot: AiRunSnapshot): boolean {
  return snapshot.phase !== 'staging' && snapshot.decision === 'approved' && ['ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'succeeded', 'failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status);
}

function shouldRenderCommandSurface(snapshot: AiRunSnapshot): boolean {
  return ['ready', 'queued', 'running', 'waiting_approval'].includes(snapshot.status);
}

function mapIntentError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'CONVERSATION_NOT_FOUND') {
      return 'This project or conversation is no longer available. Keep your request and return to the conversation.';
    }
    if (error.code === 'PROJECT_ARCHIVED') {
      return 'This project is archived. AI runs are read-only.';
    }
    if (error.code === 'RUNTIME_UNAVAILABLE') {
      return 'The local sandbox gateway is unavailable. Nothing was staged or sent to NVIDIA. Check the local app services, then try again.';
    }
    if (error.code === 'NIM_UNAVAILABLE') {
      return 'NVIDIA NIM is not ready through the local gateway. Nothing was sent to NVIDIA. Try again after provider setup is available.';
    }
    if (error.code === 'VALIDATION_ERROR') {
      const requestDetail = error.details.find((detail) => detail.field === 'request');
      if (requestDetail) {
        return requestDetail.message;
      }
    }
  }
  return GENERIC_DISCLOSURE_ERROR;
}

function mapDecisionError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'NIM_UNAVAILABLE') {
    return 'NVIDIA NIM is not ready through the local gateway. Nothing was sent to NVIDIA. Try again after provider setup is available.';
  }
  if (error instanceof ApiClientError && error.code === 'RUNTIME_UNAVAILABLE') {
    return 'The local sandbox gateway is unavailable. Nothing was staged or sent to NVIDIA. Check the local app services, then try again.';
  }
  if (error instanceof ApiClientError && error.code === 'STAGING_FAILED') {
    return 'We could not prepare the private run environment. No provider call was started.';
  }
  if (error instanceof ApiClientError && error.code === 'RUN_REVIEW_REQUIRED') {
    return AMBIGUOUS_DECISION_ERROR;
  }
  return GENERIC_DISCLOSURE_ERROR;
}

function safeFailureSnapshot(manifest: EgressManifest, error: unknown): AiRunSnapshot {
  const code = error instanceof ApiClientError ? error.code : 'STAGING_FAILED';
  const reviewRequired = code === 'RUN_REVIEW_REQUIRED';
  return {
    runId: manifest.runId,
    projectId: '',
    conversationId: '',
    status: reviewRequired ? 'review_required' : 'failed',
    phase: reviewRequired ? 'review' : 'staging',
    manifestHash: manifest.manifestHash,
    decision: 'approved',
    safeMessage: reviewRequired ? AMBIGUOUS_DECISION_ERROR : mapDecisionError(error),
    cleanup: reviewRequired ? 'unknown' : 'not_started',
    providerTransmission: reviewRequired ? 'unknown' : 'not_started_confirmed',
    stagingItemCount: 0
  };
}
