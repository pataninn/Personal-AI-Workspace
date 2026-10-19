import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getAiRun, getEgressManifest, sendChatMessage, type AiRunIntent, type AiRunSnapshot, type EgressManifest } from '@/entities/ai-run';
import { getConversation, type ConversationHistoryResponse } from '@/entities/conversation';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

import { useDirectChatConsent } from './use-direct-chat-consent';

const BLOCKING_STATUSES = new Set<AiRunSnapshot['status']>([
  'pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested',
  'failed', 'blocked', 'cancelled', 'review_required'
]);

interface UseDirectChatInput {
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly disabled: boolean;
  readonly permissionListReady: boolean;
  readonly onHistory: (history: ConversationHistoryResponse) => void;
}

interface ChatRunRequest {
  readonly runId: string;
  readonly request: string;
}

export function useDirectChat(input: UseDirectChatInput) {
  const { projectId, conversationId, csrfToken, disabled, permissionListReady, onHistory } = input;
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<'retry-send' | 'refresh-run' | null>(null);
  const [pending, setPending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [run, setRun] = useState<AiRunSnapshot | null>(null);
  const [manifest, setManifest] = useState<EgressManifest | null>(null);
  const [duplicateWorkConfirm, setDuplicateWorkConfirm] = useState(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [params, setParams] = useSearchParams();
  const runId = params.get('runId');
  const busyRef = useRef(false);
  const intent = useRef<{ content: string; key: string } | null>(null);
  const requestForRun = useRef<ChatRunRequest | null>(null);
  const contentRef = useRef(content);
  const currentRoute = useRef({ projectId, conversationId, onHistory });
  contentRef.current = content;
  currentRoute.current = { projectId, conversationId, onHistory };
  const isCurrentRoute = useCallback((expectedProjectId: string, expectedConversationId: string): boolean => (
    currentRoute.current.projectId === expectedProjectId && currentRoute.current.conversationId === expectedConversationId
  ), []);

  const clearApprovedDraft = useCallback((runKey: string): void => {
    const approvedRequest = requestForRun.current;
    if (approvedRequest?.runId === runKey && contentRef.current.trim() === approvedRequest.request.trim()) {
      setContent('');
    }
  }, []);

  const consent = useDirectChatConsent({ projectId, conversationId, csrfToken, run, setRun, manifest, setManifest, onApproved: clearApprovedDraft });

  useEffect(() => {
    setContent('');
    setError(null);
    setErrorAction(null);
    setRun(null);
    setManifest(null);
    setDuplicateWorkConfirm(false);
    requestForRun.current = null;
    intent.current = null;
  }, [projectId, conversationId]);

  useEffect(() => {
    let cancelled = false;
    if (!runId) {
      setRestoring(false);
      return undefined;
    }
    if (run?.runId === runId) {
      setRestoring(false);
      return undefined;
    }
    setRestoring(true);
    setError(null);
    void restoreRun(runId, projectId, conversationId)
      .then(({ snapshot, disclosure }) => {
        if (cancelled || !isCurrentRoute(projectId, conversationId)) return;
        setRun(snapshot);
        setManifest(disclosure);
        if (requestForRun.current?.runId !== runId) requestForRun.current = null;
      })
      .catch(() => {
        if (!cancelled && isCurrentRoute(projectId, conversationId)) {
          setError('The current AI run could not be loaded. Refresh its status before sending again.');
          setErrorAction('refresh-run');
        }
      })
      .finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [conversationId, projectId, refreshAttempt, run?.runId, runId]);

  const refresh = useCallback((): void => {
    setRefreshAttempt((value) => value + 1);
  }, []);

  const refreshRun = useCallback(async (): Promise<void> => {
    if (!run?.runId) {
      refresh();
      return;
    }
    await consent.refreshStatus();
  }, [consent.refreshStatus, refresh, run?.runId]);

  function canSubmit(): boolean {
    return !disabled && permissionListReady && Boolean(csrfToken) && !pending && !restoring
      && !consent.decisionLoading && !consent.refreshing && !busyRef.current
      && !(runId && !run) && !runBlocksNewSend(run);
  }

  async function send(): Promise<void> {
    if (!canSubmit() || !content.trim()) return;
    await submitChatRun(content.trim(), false);
  }

  async function retrySend(): Promise<void> {
    if (!canSubmit() || !content.trim()) return;
    await submitChatRun(content.trim(), false);
  }

  async function submitChatRun(request: string, forceNewKey: boolean): Promise<void> {
    if (busyRef.current || !csrfToken) return;
    busyRef.current = true;
    setPending(true);
    setError(null);
    setErrorAction(null);
    const key = forceNewKey || intent.current?.content !== request
      ? createIdempotencyKey()
      : intent.current?.key ?? createIdempotencyKey();
    intent.current = { content: request, key };
    try {
      const created = await sendChatMessage(projectId, conversationId, request, csrfToken, key);
      if (!isCurrentRoute(projectId, conversationId)) return;
      await acceptSubmittedRun(request, created);
    } catch (caught: unknown) {
      if (isCurrentRoute(projectId, conversationId)) {
        setError(chatError(caught));
        setErrorAction('retry-send');
      }
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  async function acceptSubmittedRun(request: string, created: AiRunIntent): Promise<void> {
    intent.current = null;
    requestForRun.current = { runId: created.runId, request };
    setRun(created);
    setManifest(created.manifest ?? null);
    setParams((previous) => updateRunParam(previous, created.runId), { replace: true });
    setError(null);
    setErrorAction(null);
    if (created.decision === 'approved' || created.decision === 'policy_authorized') clearApprovedDraft(created.runId);

    let disclosure = created.manifest ?? null;
    if (isPendingApproval(created) && !disclosure) {
      try {
        disclosure = await getEgressManifest(created.runId);
        if (!isCurrentRoute(projectId, conversationId)) return;
        setManifest(disclosure);
      } catch {
        if (isCurrentRoute(projectId, conversationId)) {
          setError('Your message was saved, but its provider disclosure could not be loaded. Refresh the run status before deciding.');
          setErrorAction('refresh-run');
        }
      }
    }
    await reconcileHistory();
  }

  async function reconcileHistory(): Promise<void> {
    try {
      const savedHistory = await getConversation(projectId, conversationId);
      if (isCurrentRoute(projectId, conversationId)) currentRoute.current.onHistory(savedHistory);
    } catch {
      if (isCurrentRoute(projectId, conversationId)) {
        setError('Your message was saved, but the conversation history could not be refreshed. Refresh the run status to reload it.');
        setErrorAction('refresh-run');
      }
    }
  }

  async function safeRetry(): Promise<void> {
    const request = recoveryRequest();
    if (!run || !canSafelyRetry(run) || !request || !canBeginRecovery()) return;
    await submitChatRun(request, true);
  }

  async function startSeparateRun(): Promise<void> {
    const request = recoveryRequest();
    if (!run || !requiresDuplicateConfirmation(run) || !request || !canBeginRecovery()) return;
    setDuplicateWorkConfirm(false);
    await submitChatRun(request, true);
  }

  function recoveryRequest(): string {
    const request = requestForRun.current;
    if (request && request.runId === run?.runId) return request.request;
    return '';
  }

  function canBeginRecovery(): boolean {
    return !disabled && permissionListReady && Boolean(csrfToken) && !pending && !restoring
      && !consent.decisionLoading && !consent.refreshing && !busyRef.current;
  }

  const blockedByRun = runBlocksNewSend(run);
  const busy = pending || restoring || consent.decisionLoading || consent.refreshing || !permissionListReady
    || Boolean(runId && !run) || blockedByRun;
  const safeRetryAvailable = Boolean(run && canSafelyRetry(run) && recoveryRequest());
  const separateRunAvailable = Boolean(run && requiresDuplicateConfirmation(run) && recoveryRequest());
  const restoredRecoveryNeedsReview = Boolean(run && runId === run.runId && !recoveryRequest()
    && (canSafelyRetry(run) || requiresDuplicateConfirmation(run)));

  return {
    content,
    setContent,
    error,
    errorAction,
    pending,
    restoring: restoring || consent.refreshing,
    hasRunLink: Boolean(runId),
    busy,
    lockDraft: pending || consent.decisionLoading || consent.dialogOpen,
    run,
    manifest,
    setRun,
    ...consent,
    duplicateWorkConfirm,
    setDuplicateWorkConfirm,
    safeRetryAvailable,
    separateRunAvailable,
    restoredRecoveryNeedsReview,
    send,
    retrySend,
    refresh: refreshRun,
    refreshStatus: refreshRun,
    refreshDecisionStatus: consent.refreshStatus,
    safeRetry,
    startSeparateRun
  };
}

function updateRunParam(previous: URLSearchParams, runId: string): URLSearchParams {
  const next = new URLSearchParams(previous);
  next.set('runId', runId);
  return next;
}

async function restoreRun(runId: string, projectId: string, conversationId: string): Promise<{ readonly snapshot: AiRunSnapshot; readonly disclosure: EgressManifest | null }> {
  const snapshot = await getAiRun(runId);
  if (snapshot.projectId !== projectId || snapshot.conversationId !== conversationId) throw new Error('Wrong conversation');
  const disclosure = isPendingApproval(snapshot) ? await getEgressManifest(runId) : null;
  return { snapshot, disclosure };
}

function isPendingApproval(snapshot: AiRunSnapshot): boolean {
  return snapshot.status === 'pending_approval' && snapshot.decision === 'pending';
}

function runBlocksNewSend(snapshot: AiRunSnapshot | null): boolean {
  if (!snapshot) return false;
  if (['failed', 'blocked', 'cancelled', 'review_required'].includes(snapshot.status)) {
    return snapshot.providerTransmission !== 'not_started_confirmed';
  }
  return BLOCKING_STATUSES.has(snapshot.status);
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

function chatError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const detail = error.details[0];
    if (detail) return detail.message;
    if (error.code === 'EGRESS_SOURCE_CHANGED') return 'A selected file or fact changed while sending. Review the current provider disclosure before trying again.';
    if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'CONVERSATION_NOT_FOUND') return 'This project or conversation is unavailable. Keep your draft and return to the conversation.';
  }
  return 'Your message could not be sent. Keep your draft and try again.';
}
