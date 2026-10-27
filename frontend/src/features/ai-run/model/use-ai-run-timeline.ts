import { useCallback, useEffect, useRef, useState } from 'react';

import {
  aiRunEventsUrl,
  cancelAiRun,
  getAiRun,
  normalizeAiRunSnapshot,
  parseAiRunEvent,
  startAiRun,
  type AiRunEvent,
  type AiRunSnapshot,
  type AiRunStatus
} from '@/entities/ai-run';
import { getConversation, type ConversationHistoryResponse } from '@/entities/conversation';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

export const MAX_TIMELINE_OUTPUT_BYTES = 64 * 1024;

export type AiRunTimelineConnection = 'idle' | 'starting' | 'connecting' | 'streaming' | 'disconnected' | 'complete' | 'error';
export type AiRunReconciliationStatus = 'idle' | 'loading' | 'complete' | 'partial' | 'failed';

export interface UseAiRunTimelineOptions {
  readonly snapshot: AiRunSnapshot;
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly enabled: boolean;
  readonly onSnapshotChange?: (snapshot: AiRunSnapshot) => void;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

export interface UseAiRunTimelineResult {
  readonly snapshot: AiRunSnapshot;
  readonly connection: AiRunTimelineConnection;
  readonly assistantText: string;
  readonly events: readonly AiRunEvent[];
  readonly conversation: ConversationHistoryResponse | null;
  readonly reconciliationStatus: AiRunReconciliationStatus;
  readonly reconciliationReads: { readonly run: boolean; readonly conversation: boolean };
  readonly error: string | null;
  readonly cancelError: string | null;
  readonly cancelPending: boolean;
  readonly cancel: () => void;
  readonly refresh: () => void;
}

const ACTIVE_STATUSES = new Set<AiRunStatus>(['queued', 'running', 'waiting_approval', 'cancel_requested']);
const TERMINAL_STATUSES = new Set<AiRunStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'review_required', 'rejected']);
const EVENT_TYPES: readonly AiRunEvent['type'][] = [
  'run.snapshot',
  'run.started',
  'run.status_changed',
  'assistant.delta',
  'assistant.message.completed',
  'tool.proposed',
  'tool.progress',
  'approval.required',
  'approval.decided',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'run.completed',
  'run.failed',
  'run.blocked',
  'run.cancel_requested',
  'run.cancelled',
  'run.needs_manual_review'
];

export function useAiRunTimeline({ snapshot, projectId, conversationId, csrfToken, enabled, onSnapshotChange, onConversationReconciled }: UseAiRunTimelineOptions): UseAiRunTimelineResult {
  const [localSnapshot, setLocalSnapshot] = useState(snapshot);
  const [connection, setConnection] = useState<AiRunTimelineConnection>(initialConnection(snapshot.status));
  const [assistantText, setAssistantText] = useState('');
  const [events, setEvents] = useState<readonly AiRunEvent[]>([]);
  const [conversation, setConversation] = useState<ConversationHistoryResponse | null>(null);
  const [reconciliationStatus, setReconciliationStatus] = useState<AiRunReconciliationStatus>('idle');
  const [reconciliationReads, setReconciliationReads] = useState({ run: false, conversation: false });
  const [error, setError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const runIdRef = useRef(snapshot.runId);
  const startedRuns = useRef(new Set<string>());
  const cancelKeys = useRef(new Map<string, string>());
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectSuppressed = useRef(false);
  const lastSequence = useRef(new Map<string, number>());
  const onSnapshotChangeRef = useRef(onSnapshotChange);
  const onConversationReconciledRef = useRef(onConversationReconciled);
  const latestSnapshotRef = useRef(localSnapshot);
  onSnapshotChangeRef.current = onSnapshotChange;
  onConversationReconciledRef.current = onConversationReconciled;

  const setSnapshot = useCallback((next: AiRunSnapshot | ((current: AiRunSnapshot) => AiRunSnapshot)): void => {
    const resolved = typeof next === 'function' ? next(latestSnapshotRef.current) : next;
    latestSnapshotRef.current = resolved;
    setLocalSnapshot(resolved);
    onSnapshotChangeRef.current?.(resolved);
  }, []);

  const reconcile = useCallback(async (fallbackError?: string): Promise<void> => {
    setReconciliationStatus('loading');
    setReconciliationReads({ run: false, conversation: false });
    const [runResult, historyResult] = await Promise.allSettled([
      getAiRun(snapshot.runId),
      getConversation(projectId, conversationId)
    ]);
    const runRead = runResult.status === 'fulfilled';
    const conversationRead = historyResult.status === 'fulfilled';
    setReconciliationReads({ run: runRead, conversation: conversationRead });
    setReconciliationStatus(runRead && conversationRead ? 'complete' : runRead || conversationRead ? 'partial' : 'failed');
    if (runRead) {
      const run = runResult.value;
      setSnapshot(run);
      if (TERMINAL_STATUSES.has(run.status) && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('personal-ai:project-tasks-refresh', { detail: { projectId } }));
      }
      if (run.status === 'succeeded' && (run.taskSuggestions?.length ?? 0) > 0 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('personal-ai:task-suggestions-refresh', { detail: { conversationId } }));
      }
      const keepFallbackError = fallbackError !== undefined && (run.status === 'ready' || run.status === 'pending_approval');
      setError(keepFallbackError ? fallbackError : null);
      if (TERMINAL_STATUSES.has(run.status) && conversationRead) setConnection('complete');
    } else {
      setError(fallbackError ?? 'The saved run could not be refreshed. Check your connection and refresh the run status.');
    }
    if (conversationRead) {
      const history = historyResult.value;
      setConversation(history);
      onConversationReconciledRef.current?.(history);
      if (runRead) {
        const linkedMessageId = runResult.value.assistant?.messageId;
        const linkedAssistant = linkedMessageId
          ? history.messages.find((message) => message.id === linkedMessageId && message.role === 'assistant')
          : undefined;
        if (linkedAssistant) {
          setAssistantText(boundText(linkedAssistant.content));
        } else if (runRead && TERMINAL_STATUSES.has(runResult.value.status)) {
          // A terminal REST snapshot without its run-linked assistant message is
          // authoritative: clear provisional stream text, including empty success.
          setAssistantText('');
        }
      }
    }
  }, [conversationId, projectId, setSnapshot, snapshot.runId]);

  useEffect(() => {
    // A completed run restored from its URL needs the same saved-history check as live completion.
    if (enabled && TERMINAL_STATUSES.has(latestSnapshotRef.current.status)) void reconcile();
  }, [enabled, reconcile, snapshot.runId]);

  useEffect(() => {
    if (runIdRef.current === snapshot.runId) {
      return;
    }
    runIdRef.current = snapshot.runId;
    startedRuns.current.clear();
    cancelKeys.current.clear();
    lastSequence.current.clear();
    reconnectSuppressed.current = false;
    setLocalSnapshot(snapshot);
    latestSnapshotRef.current = snapshot;
    setAssistantText('');
    setEvents([]);
    setConversation(null);
    setReconciliationStatus('idle');
    setReconciliationReads({ run: false, conversation: false });
    setError(null);
    setCancelError(null);
    setCancelPending(false);
    setConnection(initialConnection(snapshot.status));
  }, [snapshot]);

  useEffect(() => {
    if (!enabled || snapshot.status !== 'ready' || !csrfToken || startedRuns.current.has(snapshot.runId)) {
      return undefined;
    }
    startedRuns.current.add(snapshot.runId);
    setConnection('starting');
    setError(null);
    if (typeof startAiRun !== 'function') {
      setConnection('error');
      setError('The run start control is unavailable. Refresh this page before trying again.');
      return undefined;
    }
    let cancelled = false;
    void startAiRun(snapshot.runId, csrfToken, createIdempotencyKey())
      .then((next) => {
        if (!cancelled) {
          const current = latestSnapshotRef.current;
          if (TERMINAL_STATUSES.has(current.status) && current.status !== next.status) {
            void reconcile();
            return;
          }
          setSnapshot(next);
          if (TERMINAL_STATUSES.has(next.status)) {
            setConnection('complete');
            void reconcile();
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          const startError = 'The assistant run could not be started. Refresh run status before trying again.';
          setConnection('error');
          setError(startError);
          void reconcile(startError);
        }
      });
    return () => { cancelled = true; };
  }, [csrfToken, enabled, reconcile, setSnapshot, snapshot.runId, snapshot.status]);

  useEffect(() => {
    if (!enabled || !localSnapshot.runId || !ACTIVE_STATUSES.has(localSnapshot.status)) {
      return undefined;
    }
    if (reconnectSuppressed.current) {
      return undefined;
    }
    if (typeof EventSource === 'undefined') {
      reconnectSuppressed.current = true;
      setConnection('disconnected');
      void reconcile();
      return undefined;
    }
    if (sourceRef.current) {
      return undefined;
    }
    const source = new EventSource(aiRunEventsUrl(localSnapshot.runId), { withCredentials: true });
    sourceRef.current = source;
    setConnection('connecting');
    const handleMessage = (raw: MessageEvent): void => {
      const event = parseAiRunEvent(raw.data);
      if (!event || event.runId !== localSnapshot.runId || isDuplicate(event, lastSequence.current)) {
        return;
      }
      lastSequence.current.set(event.runId, event.sequence);
      setEvents((current) => [...current, event].slice(-100));
      applyEvent(event, setSnapshot, setAssistantText, setConnection);
      if (event.type === 'tool.progress' && event.payload.title === 'Project task saved' && event.payload.status === 'completed') {
        window.dispatchEvent(new CustomEvent('personal-ai:project-tasks-refresh', { detail: { projectId } }));
      }
      if (isTerminalEvent(event.type)) {
        source.close();
        sourceRef.current = null;
        setConnection('complete');
        void reconcile();
      }
    };
    const handlers = EVENT_TYPES.map((type) => {
      const handler = handleMessage as EventListener;
      source.addEventListener(type, handler);
      return { type, handler };
    });
    const handleError = (): void => {
      reconnectSuppressed.current = true;
      source.close();
      sourceRef.current = null;
      setConnection('disconnected');
      void reconcile();
    };
    source.addEventListener('error', handleError);
    return () => {
      for (const { type, handler } of handlers) {
        source.removeEventListener(type, handler);
      }
      source.removeEventListener('error', handleError);
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [enabled, localSnapshot.runId, localSnapshot.status, projectId, reconcile, refreshVersion, setSnapshot]);

  useEffect(() => {
    if (refreshVersion === 0) {
      return;
    }
    void reconcile();
  }, [reconcile, refreshVersion]);

  const cancel = useCallback((): void => {
    if (!csrfToken || cancelPending || TERMINAL_STATUSES.has(localSnapshot.status)) {
      return;
    }
    setCancelPending(true);
    setCancelError(null);
    const key = cancelKeys.current.get(localSnapshot.runId) ?? createIdempotencyKey();
    cancelKeys.current.set(localSnapshot.runId, key);
    if (typeof cancelAiRun !== 'function') {
      setCancelPending(false);
      setConnection('error');
      setError('The run cancel control is unavailable. Refresh this page before trying again.');
      return;
    }
    void cancelAiRun(localSnapshot.runId, csrfToken, key)
      .then((next) => {
        const current = latestSnapshotRef.current;
        if (TERMINAL_STATUSES.has(current.status) && current.status !== next.status) {
          setCancelPending(false);
          void reconcile();
          return;
        }
        setSnapshot(next);
        setCancelPending(false);
        if (TERMINAL_STATUSES.has(next.status)) {
          setConnection('complete');
          void reconcile();
        }
      })
      .catch(() => {
        setCancelPending(false);
        setCancelError('Cancellation could not be confirmed. Refresh the run status before retrying.');
        setConnection('error');
        setError('Cancellation could not be confirmed. Refresh the run status before retrying.');
        void reconcile();
      });
  }, [cancelPending, csrfToken, localSnapshot.runId, localSnapshot.status, reconcile, setSnapshot]);

  const refresh = useCallback((): void => {
    reconnectSuppressed.current = false;
    setCancelError(null);
    setReconciliationStatus('loading');
    setRefreshVersion((value) => value + 1);
  }, []);

  return { snapshot: localSnapshot, connection, assistantText, events, conversation, reconciliationStatus, reconciliationReads, error, cancelError, cancelPending, cancel, refresh };
}

function applyEvent(
  event: AiRunEvent,
  setSnapshot: (snapshot: AiRunSnapshot | ((current: AiRunSnapshot) => AiRunSnapshot)) => void,
  setAssistantText: (update: (current: string) => string) => void,
  setConnection: (connection: AiRunTimelineConnection) => void
): void {
  if (event.type === 'run.snapshot') {
    try {
      setSnapshot(normalizeAiRunSnapshot(event.payload));
    } catch {
      return;
    }
    setConnection('streaming');
    return;
  }
  if (event.type === 'assistant.delta') {
    const delta = typeof event.payload.text === 'string' ? event.payload.text : '';
    if (delta) {
      setAssistantText((current) => boundText(current + delta));
    }
    setConnection('streaming');
    return;
  }
  if (event.type === 'tool.progress') { setConnection('streaming'); return; }
  const status = readStatus(event.payload.status);
  if (status) {
    setSnapshotFromStatus(event.payload, status, setSnapshot);
  }
  if (event.type === 'assistant.message.completed') {
    setSnapshotFromStatus(event.payload, undefined, setSnapshot);
  }
  setConnection(isTerminalEvent(event.type) ? 'complete' : 'streaming');
}

function setSnapshotFromStatus(payload: Readonly<Record<string, unknown>>, status: AiRunStatus | undefined, setSnapshot: (snapshot: AiRunSnapshot | ((current: AiRunSnapshot) => AiRunSnapshot)) => void): void {
  setSnapshot((current) => ({
    ...current,
    ...(status ? { status, phase: status === 'review_required' ? 'review' : TERMINAL_STATUSES.has(status) ? 'terminal' : current.phase } : {}),
    ...(typeof payload.safeMessage === 'string' ? { safeMessage: payload.safeMessage } : {}),
    ...(typeof payload.contentLength === 'number' || typeof payload.messageId === 'string' ? {
      assistant: {
        ...(current.assistant ?? { complete: false, contentLength: 0 }),
        ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
        ...(typeof payload.contentLength === 'number' ? { contentLength: Math.max(0, Math.floor(payload.contentLength)) } : {})
      }
    } : {})
  }));
}

function readStatus(value: unknown): AiRunStatus | undefined {
  return value === 'pending_approval' || value === 'rejected' || value === 'staging' || value === 'ready' || value === 'queued' || value === 'running' || value === 'waiting_approval' || value === 'succeeded' || value === 'failed' || value === 'cancel_requested' || value === 'cancelled' || value === 'blocked' || value === 'review_required' ? value : undefined;
}

function initialConnection(status: AiRunStatus): AiRunTimelineConnection {
  return TERMINAL_STATUSES.has(status) ? 'complete' : ACTIVE_STATUSES.has(status) ? 'connecting' : 'idle';
}

function isDuplicate(event: AiRunEvent, sequences: ReadonlyMap<string, number>): boolean {
  return event.sequence <= (sequences.get(event.runId) ?? -1);
}

function isTerminalEvent(type: AiRunEvent['type']): boolean {
  return type === 'run.completed' || type === 'run.failed' || type === 'run.blocked' || type === 'run.cancelled' || type === 'run.needs_manual_review';
}

function boundText(value: string): string {
  if (new TextEncoder().encode(value).byteLength <= MAX_TIMELINE_OUTPUT_BYTES) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > MAX_TIMELINE_OUTPUT_BYTES) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
