import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { decideEgress, getAiRun, getEgressManifest, type AiRunSnapshot, type EgressManifest } from '@/entities/ai-run';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

const STALE_DISCLOSURE_ERROR = 'This disclosure is no longer current. Review the updated scope before approving.';
const AMBIGUOUS_DECISION_ERROR = 'The decision outcome could not be confirmed. Refresh the run status before deciding again.';

interface UseDirectChatConsentInput {
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly run: AiRunSnapshot | null;
  readonly setRun: Dispatch<SetStateAction<AiRunSnapshot | null>>;
  readonly manifest: EgressManifest | null;
  readonly setManifest: Dispatch<SetStateAction<EgressManifest | null>>;
  readonly onApproved: (runId: string) => void;
}

export function useDirectChatConsent({ projectId, conversationId, csrfToken, run, setRun, manifest, setManifest, onApproved }: UseDirectChatConsentInput) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionAction, setDecisionAction] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionOutcomeUnknown, setDecisionOutcomeUnknown] = useState(false);
  const [rememberProviderPermission, setRememberProviderPermission] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const decisionKey = useRef<string | null>(null);
  const runRef = useRef(run);
  const scopeRef = useRef({ projectId, conversationId });
  runRef.current = run;
  scopeRef.current = { projectId, conversationId };

  useEffect(() => {
    const pending = isPending(run) && manifest?.runId === run?.runId;
    setDialogOpen(Boolean(pending));
    if (!pending) {
      decisionKey.current = null;
      setDecisionError(null);
      setDecisionOutcomeUnknown(false);
      setRememberProviderPermission(false);
    }
  }, [manifest?.runId, run?.decision, run?.runId, run?.status]);

  const isCurrentRun = useCallback((expectedRunId: string): boolean => {
    const current = runRef.current;
    const scope = scopeRef.current;
    return current?.runId === expectedRunId
      && current.projectId === scope.projectId
      && current.conversationId === scope.conversationId;
  }, []);

  const refreshStatus = useCallback(async (): Promise<boolean> => {
    const expectedRunId = run?.runId;
    if (!expectedRunId || refreshing) return false;
    setRefreshing(true);
    try {
      const snapshot = await getAiRun(expectedRunId);
      if (!isCurrentRun(expectedRunId)) return false;
      const disclosure = isPending(snapshot) ? await getEgressManifest(snapshot.runId) : null;
      if (!isCurrentRun(expectedRunId)) return false;
      setRun(snapshot);
      setManifest(disclosure);
      decisionKey.current = null;
      setDecisionError(null);
      setDecisionOutcomeUnknown(false);
      if (snapshot.decision === 'approved') onApproved(snapshot.runId);
      return true;
    } catch {
      if (isCurrentRun(expectedRunId)) {
        setDecisionError(AMBIGUOUS_DECISION_ERROR);
        setDecisionOutcomeUnknown(true);
      }
      return false;
    } finally {
      setRefreshing(false);
    }
  }, [isCurrentRun, onApproved, refreshing, run?.runId, setManifest, setRun]);

  useEffect(() => {
    const handlePermissionRevoked = (): void => { void refreshStatus(); };
    window.addEventListener('personal-ai:provider-permissions-revoked', handlePermissionRevoked);
    return () => window.removeEventListener('personal-ai:provider-permissions-revoked', handlePermissionRevoked);
  }, [refreshStatus]);

  async function submitDecision(decision: 'approve' | 'reject'): Promise<void> {
    const currentRun = run;
    const currentManifest = manifest;
    if (!currentRun || !isPending(currentRun) || !currentManifest || currentManifest.runId !== currentRun.runId
      || !csrfToken || decisionLoading || decisionOutcomeUnknown) return;
    setDecisionLoading(true);
    setDecisionAction(decision);
    setDecisionError(null);
    try {
      const snapshot = await decideEgress(currentManifest.runId, {
        manifestHash: currentManifest.manifestHash,
        decision,
        ...(decision === 'approve' && rememberProviderPermission ? { rememberProviderPermission: true } : {})
      }, csrfToken, decisionKey.current ?? (decisionKey.current = createIdempotencyKey()));
      if (!isCurrentRun(currentManifest.runId)) return;
      setRun(snapshot);
      setDialogOpen(false);
      decisionKey.current = null;
      setDecisionOutcomeUnknown(false);
      setRememberProviderPermission(false);
      if (decision === 'approve') onApproved(snapshot.runId);
      if (decision === 'approve' && rememberProviderPermission) {
        window.dispatchEvent(new CustomEvent('personal-ai:provider-permissions-changed'));
      }
    } catch (error: unknown) {
      await reconcileDecisionFailure(error, currentManifest);
    } finally {
      setDecisionLoading(false);
      setDecisionAction(null);
    }
  }

  async function reconcileDecisionFailure(error: unknown, currentManifest: EgressManifest): Promise<void> {
    if (!isCurrentRun(currentManifest.runId)) return;
    const code = error instanceof ApiClientError ? error.code : null;
    try {
      const snapshot = await getAiRun(currentManifest.runId);
      if (!isCurrentRun(currentManifest.runId)) return;
      setRun(snapshot);
      if (!isPending(snapshot)) {
        setDialogOpen(false);
        decisionKey.current = null;
        setDecisionOutcomeUnknown(false);
        setDecisionError(null);
        if (snapshot.decision === 'approved') onApproved(snapshot.runId);
        return;
      }
      if (code === 'EGRESS_MANIFEST_CONFLICT' || code === 'EGRESS_SOURCE_CHANGED') {
        setDecisionError(STALE_DISCLOSURE_ERROR);
        decisionKey.current = null;
        return;
      }
      setDecisionOutcomeUnknown(true);
      setDecisionError(AMBIGUOUS_DECISION_ERROR);
    } catch {
      if (isCurrentRun(currentManifest.runId)) {
        setDecisionOutcomeUnknown(true);
        setDecisionError(AMBIGUOUS_DECISION_ERROR);
      }
    }
  }

  async function refreshDisclosure(): Promise<void> {
    const currentManifest = manifest;
    if (!currentManifest || refreshing || !isCurrentRun(currentManifest.runId)) return;
    setRefreshing(true);
    try {
      const disclosure = await getEgressManifest(currentManifest.runId);
      if (!isCurrentRun(currentManifest.runId)) return;
      setManifest(disclosure);
      decisionKey.current = null;
      setDecisionError(null);
      setDecisionOutcomeUnknown(false);
    } catch {
      if (isCurrentRun(currentManifest.runId)) {
        setDecisionError('The provider disclosure could not be refreshed. Refresh the run status before deciding again.');
      }
    } finally {
      setRefreshing(false);
    }
  }

  function handleDialogOpenChange(open: boolean): void {
    if (open) setDialogOpen(true);
    else if (!decisionLoading && !decisionOutcomeUnknown) void submitDecision('reject');
  }

  return {
    dialogOpen,
    decisionLoading,
    decisionAction,
    decisionError,
    decisionOutcomeUnknown,
    rememberProviderPermission,
    setRememberProviderPermission,
    refreshing,
    refreshStatus,
    refreshDisclosure,
    handleDialogOpenChange,
    approve: () => { void submitDecision('approve'); },
    reject: () => { void submitDecision('reject'); }
  };
}

function isPending(snapshot: AiRunSnapshot | null): boolean {
  return snapshot?.status === 'pending_approval' && snapshot.decision === 'pending';
}
