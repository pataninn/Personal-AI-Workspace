import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

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
import { listProjectFacts } from '@/entities/project-fact';
import { ApiClientError } from '@/shared/api';
import { Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button } from '@/shared/ui';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

import { ProviderConsentDialog } from '@/features/ai-run/ui/ProviderConsentDialog';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';
import { ContextScopePicker } from '@/features/ai-run/ui/ContextScopePicker';
import { MemoryContextPicker } from '@/features/ai-run/ui/MemoryContextPicker';
import { ProposedChangeReview } from '@/features/ai-run/ui/ProposedChangeReview';
import { RunStatusCard, type RunStatusState } from '@/features/ai-run/ui/RunStatusCard';
import { ProviderPermissionManager } from '@/features/ai-run/ui/ProviderPermissionManager';

interface AiRunEntryProps {
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly recentMessageCount?: number;
  readonly disabled: boolean;
  readonly archivedDescriptionId?: string;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

const GENERIC_DISCLOSURE_ERROR = 'We could not prepare the provider disclosure. Keep your request and try again.';
const AMBIGUOUS_DECISION_ERROR = 'The decision outcome could not be confirmed. Refresh the run status before deciding again.';
const STALE_DISCLOSURE_ERROR = 'This disclosure is no longer current. Review the updated scope before approving.';

export function AiRunEntry({ projectId, conversationId, request, recentMessageCount = 0, disabled, archivedDescriptionId, onConversationReconciled }: AiRunEntryProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const location = useLocation();
  const navigate = useNavigate();
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunStatusState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionAction, setDecisionAction] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionOutcomeUnknown, setDecisionOutcomeUnknown] = useState(false);
  const [rememberProviderPermission, setRememberProviderPermission] = useState(false);
  const [permissionListReady, setPermissionListReady] = useState(false);
  const [runRestoreReady, setRunRestoreReady] = useState(() => !new URLSearchParams(location.search).has('runId'));
  const [runRestoreError, setRunRestoreError] = useState<string | null>(null);
  const [runRestoreAttempt, setRunRestoreAttempt] = useState(0);
  const [duplicateWorkConfirm, setDuplicateWorkConfirm] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [intentRequest, setIntentRequest] = useState<string | null>(null);
  const [intentContextKey, setIntentContextKey] = useState<string | null>(null);
  const [decisionKey, setDecisionKey] = useState<string | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [includeRecentMessages, setIncludeRecentMessages] = useState(false);
  const [selectedFactIds, setSelectedFactIds] = useState<readonly string[]>([]);
  const [selectedFactVersions, setSelectedFactVersions] = useState<Readonly<Record<string, number>>>({});
  const [memoryChoiceRequired, setMemoryChoiceRequired] = useState(false);
  const askAiButtonRef = useRef<HTMLButtonElement>(null);
  const handledRunQueryRef = useRef<string | null | undefined>(undefined);
  const replaceRunIdInUrl = useCallback((runId: string | null): void => {
    const searchParams = new URLSearchParams(location.search);
    if (runId) searchParams.set('runId', runId);
    else searchParams.delete('runId');
    const search = searchParams.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  const trimmedRequest = request.trim();
  const blankRequest = trimmedRequest.length === 0;
  const contextSelectionKey = contextKey(projectId, selectedPaths, includeRecentMessages, selectedFactIds, selectedFactVersions);
  const requestErrorId = 'ai-run-request-error';
  const archivedDescription = archivedDescriptionId ?? 'project-archived-message';
  const handlePermissionListStateChange = useCallback((ready: boolean): void => setPermissionListReady(ready), []);

  useEffect(() => {
    setSelectedPaths([]);
    setIncludeRecentMessages(false);
    setSelectedFactIds([]);
    setSelectedFactVersions({});
    setMemoryChoiceRequired(false);
    setPermissionListReady(false);
    setIntentKey(null);
    setIntentRequest(null);
    setIntentContextKey(null);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const runId = new URLSearchParams(location.search).get('runId');
    const runRestoreKey = JSON.stringify([projectId, conversationId, runId]);
    if (handledRunQueryRef.current === runRestoreKey) {
      return () => { cancelled = true; };
    }
    handledRunQueryRef.current = runRestoreKey;
    setRunState(null);
    setDialogOpen(false);
    setDuplicateWorkConfirm(false);
    setRunRestoreError(null);
    if (!runId) {
      setRunRestoreReady(true);
      return () => { cancelled = true; };
    }
    setRunRestoreReady(false);
    void getAiRun(runId)
      .then(async (snapshot) => {
        if (snapshot.projectId !== projectId || snapshot.conversationId !== conversationId) {
          throw new Error('This run belongs to a different project or conversation.');
        }
        let manifest: EgressManifest | null = null;
        if (snapshot.status === 'pending_approval' && snapshot.decision === 'pending') {
          manifest = await getEgressManifest(snapshot.runId);
        }
        if (cancelled) return;
        setRunState({ snapshot, manifest });
        setDialogOpen(snapshot.status === 'pending_approval' && snapshot.decision === 'pending');
        setRunRestoreReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setRunRestoreError('The selected run could not be restored in this conversation. Retry the lookup or remove the run link.');
        setRunRestoreReady(true);
      });
    return () => { cancelled = true; };
  }, [conversationId, location.search, projectId, runRestoreAttempt]);

  useEffect(() => {
    const handlePermissionChange = (): void => {
      const runId = runState?.snapshot.runId;
      if (!runId) return;
      void getAiRun(runId).then((snapshot) => {
        setRunState((current) => current?.snapshot.runId === runId ? { ...current, snapshot } : current);
        if (snapshot.status === 'pending_approval' && snapshot.decision === 'pending') setDialogOpen(true);
      }).catch(() => undefined);
    };
    window.addEventListener('personal-ai:provider-permissions-revoked', handlePermissionChange);
    return () => window.removeEventListener('personal-ai:provider-permissions-revoked', handlePermissionChange);
  }, [runState?.snapshot.runId]);

  useEffect(() => {
    if (runState?.manifest && runState.snapshot.status === 'pending_approval' && runState.snapshot.decision === 'pending') {
      setDialogOpen(true);
    }
  }, [runState?.manifest, runState?.snapshot.decision, runState?.snapshot.status]);

  useEffect(() => {
    if (intentRequest !== null && (intentRequest !== request || intentContextKey !== contextSelectionKey)) {
      setIntentKey(null);
      setIntentRequest(null);
      setIntentContextKey(null);
    }
  }, [contextSelectionKey, intentContextKey, intentRequest, request]);

  async function beginRun(forceFreshIntent = false, explicitlyConfirmedFreshRun = false): Promise<void> {
    setIntentError(null);
    if (blankRequest || disabled || intentLoading || decisionLoading || memoryChoiceRequired || !runRestoreReady || runRestoreError) {
      return;
    }
    if (runState && blocksAskAi(runState.snapshot.status) && !explicitlyConfirmedFreshRun) return;
    if (runState && requiresDuplicateConfirmation(runState.snapshot) && !explicitlyConfirmedFreshRun) {
      setDuplicateWorkConfirm(true);
      return;
    }
    if (!csrfToken) {
      setIntentError('Your local session is no longer available. Refresh the page and try again.');
      return;
    }
    const key = !forceFreshIntent && intentKey && intentRequest === request && intentContextKey === contextSelectionKey ? intentKey : createIdempotencyKey();
    setIntentKey(key);
    setIntentRequest(request);
    setIntentContextKey(contextSelectionKey);
    setIntentLoading(true);
    setDuplicateWorkConfirm(false);
    setRememberProviderPermission(false);
    setDecisionError(null);
    setDecisionOutcomeUnknown(false);
    try {
      if (selectedFactIds.length > 0) {
        const currentFacts = await loadSelectedFactsForReview(projectId);
        if (!currentFacts) {
          setMemoryChoiceRequired(true);
          setIntentError('Project memory could not be checked. Review the facts again or explicitly continue without project memory.');
          return;
        }
        if (!selectedFactIds.every((factId) => currentFacts.get(factId) === selectedFactVersions[factId])) {
          setSelectedFactIds([]);
          setSelectedFactVersions({});
          setMemoryChoiceRequired(true);
          setIntentError('A selected fact changed or is no longer active. Review the current facts before starting this run.');
          return;
        }
      }
      const intent = await createAiRun(projectId, {
        conversationId,
        request: trimmedRequest,
        context: { relativePaths: selectedPaths, includeRecentMessages, factIds: selectedFactIds }
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
      setRunRestoreError(null);
      setRunRestoreReady(true);
      handledRunQueryRef.current = JSON.stringify([projectId, conversationId, intent.runId]);
      replaceRunIdInUrl(intent.runId);
      setDialogOpen(intent.status === 'pending_approval' && intent.decision === 'pending');
    } catch (error: unknown) {
      if (error instanceof ApiClientError && (error.code === 'EGRESS_MANIFEST_CONFLICT' || error.code === 'EGRESS_SOURCE_CHANGED')) {
        setIntentKey(null);
        setIntentRequest(null);
        setIntentContextKey(null);
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
      const snapshot = await decideEgress(manifest.runId, {
        manifestHash: manifest.manifestHash,
        decision,
        ...(decision === 'approve' && rememberProviderPermission ? { rememberProviderPermission: true } : {})
      }, csrfToken, key);
      setRunState({ snapshot, manifest });
      if (decision === 'approve' && rememberProviderPermission) {
        window.dispatchEvent(new CustomEvent('personal-ai:provider-permissions-changed'));
      }
      setRememberProviderPermission(false);
      setDialogOpen(false);
      setDecisionKey(null);
      setIntentKey(null);
      setIntentContextKey(null);
    } catch (error: unknown) {
      await reconcileDecisionFailure(error, manifest);
    } finally {
      setDecisionLoading(false);
      setDecisionAction(null);
    }
  }

  async function reconcileDecisionFailure(error: unknown, manifest: EgressManifest): Promise<void> {
    const knownSafeFailure = error instanceof ApiClientError && ['EGRESS_SOURCE_CHANGED', 'RUNTIME_UNAVAILABLE', 'NIM_UNAVAILABLE', 'STAGING_FAILED', 'RUN_REVIEW_REQUIRED'].includes(error.code);
    try {
      const snapshot = await getAiRun(manifest.runId);
      if (snapshot.status !== 'pending_approval' || snapshot.decision !== 'pending') {
        setRunState({ snapshot, manifest, errorCode: error instanceof ApiClientError ? error.code : undefined });
        setDialogOpen(false);
        setDecisionKey(null);
        setIntentKey(null);
        setIntentContextKey(null);
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
      setIntentContextKey(null);
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
      if (error instanceof ApiClientError && error.code === 'EGRESS_MANIFEST_CONFLICT') {
        retryRun();
        return;
      }
      setDecisionError(GENERIC_DISCLOSURE_ERROR);
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
    setIntentError(null);
    setDecisionError(null);
    setDecisionOutcomeUnknown(false);
    setDuplicateWorkConfirm(false);
    setIntentKey(null);
    setIntentRequest(null);
    setIntentContextKey(null);
    void beginRun(true, true);
  }

  function confirmSeparateRun(): void {
    setDuplicateWorkConfirm(false);
    void beginRun(true, true);
  }

  function removeRunLink(): void {
    handledRunQueryRef.current = null;
    replaceRunIdInUrl(null);
    setRunState(null);
    setRunRestoreError(null);
    setRunRestoreReady(true);
  }

  function continueWithoutMemory(): void {
    setSelectedFactIds([]);
    setSelectedFactVersions({});
    setMemoryChoiceRequired(false);
    setIntentError(null);
    setIntentKey(null);
    setIntentRequest(null);
    setIntentContextKey(null);
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

  const formError = intentError ? <Alert tone="error" data-testid="ai-run-error" role="alert"><p>{intentError}</p>{memoryChoiceRequired ? <Button type="button" variant="secondary" data-testid="memory-context-continue-without" onClick={continueWithoutMemory}>Continue without project memory</Button> : <Button type="button" variant="secondary" data-testid="ai-run-error-retry" disabled={disabled || intentLoading} onClick={() => { void beginRun(); }}>Try again</Button>}</Alert> : memoryChoiceRequired ? <Alert tone="warning" data-testid="memory-context-choice-required" role="alert"><p>Review project memory and confirm the facts for this run, or explicitly continue without project memory.</p><Button type="button" variant="secondary" data-testid="memory-context-continue-without" onClick={continueWithoutMemory}>Continue without project memory</Button></Alert> : null;
  const blankMessage = blankRequest ? 'Enter a request before asking the assistant.' : null;
  const askAiBlockedByRun = Boolean(runState && blocksAskAi(runState.snapshot.status));

  return (
    <>
      <section className="ai-run-entry" data-testid="ai-run-entry" aria-describedby={disabled ? archivedDescription : undefined}>
        <form data-testid="ai-run-form" onSubmit={(event) => { event.preventDefault(); void beginRun(); }}>
          <p className="field-help" id="ai-run-help">Ask AI first shows what will be sent to NVIDIA NIM. Saving a message does not start a run.</p>
          <p className="field-help" data-testid="ai-run-approval-classification"><strong>Safe:</strong> choosing project context only prepares a local disclosure. <strong>Sensitive:</strong> sending it to NVIDIA needs your one-time approval or a saved provider permission. File changes and commands always need separate approval.</p>
          <ContextScopePicker
            projectId={projectId}
            selectedPaths={selectedPaths}
            includeRecentMessages={includeRecentMessages}
            recentMessageCount={recentMessageCount}
            disabled={disabled || intentLoading || decisionLoading || dialogOpen}
            onChange={({ relativePaths, includeRecentMessages: nextIncludeRecentMessages }) => {
              setSelectedPaths(relativePaths);
              setIncludeRecentMessages(nextIncludeRecentMessages);
            }}
          />
          <MemoryContextPicker
            projectId={projectId}
            selectedFactIds={selectedFactIds}
            selectedFactVersions={selectedFactVersions}
            disabled={disabled || intentLoading || decisionLoading || dialogOpen}
            onChange={(factIds, versions) => { setSelectedFactIds(factIds); setSelectedFactVersions(versions); }}
            onReviewStarted={() => { setMemoryChoiceRequired(true); setIntentError('Review project memory selection before continuing this run.'); }}
            onUnavailable={() => { setMemoryChoiceRequired(true); }}
            onSelectionConfirmed={() => { setMemoryChoiceRequired(false); setIntentError(null); }}
            onExplicitSkip={continueWithoutMemory}
          />
          {blankMessage ? <p className="field-error" data-testid="ai-run-request-error" id={requestErrorId} role="alert">{blankMessage}</p> : null}
          <div className="composer-actions ai-run-actions">
            <Button
              ref={askAiButtonRef}
              type="submit"
              data-testid="ai-run-submit"
              aria-busy={intentLoading}
              aria-describedby={["ai-run-help", blankMessage ? requestErrorId : null, disabled ? archivedDescription : null].filter(Boolean).join(' ')}
              disabled={disabled || intentLoading || decisionLoading || memoryChoiceRequired || !permissionListReady || !csrfToken || blankRequest || !runRestoreReady || Boolean(runRestoreError) || askAiBlockedByRun}
            >
              {intentLoading ? <><span data-testid="ai-run-manifest-loading">Preparing provider disclosure…</span></> : 'Ask AI'}
            </Button>
          </div>
          {intentLoading ? <p className="form-status" data-testid="ai-run-manifest-loading-status" role="status" aria-live="polite">Preparing provider disclosure…</p> : null}
          {formError}
          {runRestoreError ? <Alert tone="error" role="alert" data-testid="ai-run-restore-error"><p>{runRestoreError}</p><div className="run-status-actions"><Button type="button" variant="secondary" onClick={() => { handledRunQueryRef.current = null; setRunRestoreAttempt((attempt) => attempt + 1); }}>Retry lookup</Button><Button type="button" variant="secondary" onClick={removeRunLink}>Remove run link</Button></div></Alert> : null}
          {askAiBlockedByRun ? <p className="field-help" data-testid="ai-run-new-request-blocked" role="status">This run is still unresolved. Review or refresh it before starting another run.</p> : null}
        </form>
        <ProviderPermissionManager projectId={projectId} csrfToken={csrfToken} onListStateChange={handlePermissionListStateChange} />
        {runState ? <RunStatusCard state={runState} conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`} onRetry={retryRun} onRefresh={refreshStatus} /> : null}
        {runState && canSafelyRetry(runState.snapshot) ? <Button type="button" variant="secondary" data-testid="ai-run-safe-retry" disabled={disabled || intentLoading || decisionLoading || !csrfToken} onClick={retryRun}>Try again</Button> : null}
        {runState && requiresDuplicateConfirmation(runState.snapshot) ? <Button type="button" variant="secondary" data-testid="ai-run-separate-request" disabled={disabled || intentLoading || decisionLoading || !csrfToken} onClick={() => setDuplicateWorkConfirm(true)}>Start a separate run</Button> : null}
        {runState && shouldRenderTimeline(runState.snapshot) ? <AiRunTimeline snapshot={runState.snapshot} manifest={runState.manifest} projectId={projectId} conversationId={conversationId} csrfToken={csrfToken} disabled={disabled} onSnapshotChange={(snapshot) => { setRunState((current) => current ? { ...current, snapshot } : current); }} onConversationReconciled={onConversationReconciled} /> : null}
        {runState && shouldRenderChangeReview(runState.snapshot) ? <ProposedChangeReview runId={runState.snapshot.runId} readOnly={disabled} conversationHref={`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`} /> : null}
      </section>
      <ProviderConsentDialog
        manifest={runState?.manifest ?? null}
        open={dialogOpen}
        decisionLoading={decisionLoading || refreshLoading}
        decisionAction={decisionAction}
        decisionError={decisionError}
        decisionOutcomeUnknown={decisionOutcomeUnknown}
        approveEnabled={runState?.snapshot.status === 'pending_approval' && runState.snapshot.decision === 'pending'}
        rememberProviderPermission={rememberProviderPermission}
        onOpenChange={handleDialogOpenChange}
        onApprove={() => { void submitDecision('approve'); }}
        onRememberProviderPermissionChange={setRememberProviderPermission}
        onReject={() => { void submitDecision('reject'); }}
        onRefreshDisclosure={() => { void refreshDisclosure(); }}
        onRefreshStatus={() => { void refreshStatus(); }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          askAiButtonRef.current?.focus();
        }}
      />
      <AlertDialogRoot open={duplicateWorkConfirm} onOpenChange={(open) => { if (!open) setDuplicateWorkConfirm(false); }}>
        <AlertDialogContent data-testid="ai-run-duplicate-work-warning" onCloseAutoFocus={(event) => { event.preventDefault(); askAiButtonRef.current?.focus(); }}>
          <AlertDialogTitle>Start a separate AI run?</AlertDialogTitle>
          <AlertDialogDescription>The provider may already have received the earlier request. Starting a separate run may repeat provider work.</AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">Keep current run</Button></AlertDialogCancel>
            <Button type="button" data-testid="ai-run-separate-confirm" disabled={disabled || intentLoading || decisionLoading} onClick={confirmSeparateRun}>Confirm and start separate run</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </>
  );
}

function shouldRenderTimeline(snapshot: AiRunSnapshot): boolean {
  return snapshot.decision === 'approved'
    && snapshot.phase !== 'staging'
    && ['ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'succeeded', 'failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status);
}

function shouldRenderChangeReview(snapshot: AiRunSnapshot): boolean {
  return snapshot.status === 'succeeded';
}

function blocksAskAi(status: AiRunSnapshot['status']): boolean {
  return ['pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'review_required'].includes(status);
}

function canSafelyRetry(snapshot: AiRunSnapshot): boolean {
  if (snapshot.status === 'failed' && snapshot.phase === 'staging') return false;
  return (snapshot.status === 'failed' || snapshot.status === 'review_required')
    && snapshot.providerTransmission === 'not_started_confirmed';
}

function requiresDuplicateConfirmation(snapshot: AiRunSnapshot): boolean {
  return ['failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status)
    && snapshot.providerTransmission !== 'not_started_confirmed';
}

async function loadSelectedFactsForReview(projectId: string): Promise<ReadonlyMap<string, number> | null> {
  try {
    const facts = await listProjectFacts(projectId);
    return new Map(facts.map((fact) => [fact.id, fact.version]));
  } catch {
    return null;
  }
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
      return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
    }
    if (error.code === 'NIM_UNAVAILABLE') {
      return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
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
  if (error instanceof ApiClientError && error.code === 'EGRESS_SOURCE_CHANGED') {
    return 'The approved project context changed. Review a fresh provider disclosure before trying again.';
  }
  if (error instanceof ApiClientError && error.code === 'NIM_UNAVAILABLE') {
    return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
  }
  if (error instanceof ApiClientError && error.code === 'RUNTIME_UNAVAILABLE') {
    return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
  }
  if (error instanceof ApiClientError && error.code === 'STAGING_FAILED') {
    return 'The approved context could not be prepared for NVIDIA NIM. No provider request was started.';
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

function contextKey(projectId: string, paths: readonly string[], includeRecentMessages: boolean, factIds: readonly string[], versions: Readonly<Record<string, number>>): string {
  const facts = [...factIds].sort().map((id) => `${id}@${versions[id] ?? 'unknown'}`).join('\u001f');
  return `${projectId}:${includeRecentMessages ? 'messages' : 'request-only'}:${paths.join('\u001f')}:${facts}`;
}
