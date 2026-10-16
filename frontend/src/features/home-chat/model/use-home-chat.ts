import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import {
  cancelHomeTurn,
  createHomeConversation,
  decideHomeConsent,
  getHomeConversation,
  getHomeTurn,
  listHomeConversations,
  listHomeEvents,
  listHomeMessages,
  listHomeTurns,
  submitHomeTurn
} from '@/entities/home-conversation';
import type {
  HomeConsentDisclosure,
  HomeConversationEvent,
  HomeConversationScope,
  HomeConversationSnapshot,
  HomeMessageSnapshot,
  HomeTurnSnapshot,
  HomeTurnSubmission
} from '@/entities/home-conversation';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';
type SendStatus = 'idle' | 'creating' | 'submitting' | 'reconciling' | 'uncertain' | 'retrying';

interface SendIntent {
  readonly scopeKey: string;
  readonly conversationId: string;
  readonly content: string;
  readonly key: string;
  readonly afterTurnSequence: number;
}

interface CreateIntent {
  readonly scopeKey: string;
  readonly title: string;
  readonly key: string;
}

const ACTIVE_STATUSES = new Set(['pending', 'running', 'cancel_requested']);
const UNAVAILABLE_KEY = 'home-chat-runtime-unavailable';

function scopeKey(scope: HomeConversationScope): string {
  return scope.kind === 'home' ? 'home' : `workspace:${scope.workspaceId}`;
}

function viewKey(scopeId: string, conversationId: string | null, isNew: boolean): string {
  return `${scopeId}::${conversationId ?? (isNew ? 'new' : 'auto')}`;
}

function sameScope(left: HomeConversationScope, right: HomeConversationScope): boolean {
  return left.kind === right.kind && (left.kind === 'home' || (right.kind === 'workspace' && left.workspaceId === right.workspaceId));
}

function unavailableInSession(): boolean {
  try { return window.sessionStorage.getItem(UNAVAILABLE_KEY) === 'true'; } catch { return false; }
}

function normalizeTitle(message: string): string {
  return message.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function mergeMessages(current: readonly HomeMessageSnapshot[], incoming: readonly HomeMessageSnapshot[]): readonly HomeMessageSnapshot[] {
  const byId = new Map<string, HomeMessageSnapshot>();
  for (const message of [...current, ...incoming]) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function mergeTurns(current: readonly HomeTurnSnapshot[], incoming: readonly HomeTurnSnapshot[]): readonly HomeTurnSnapshot[] {
  const byId = new Map<string, HomeTurnSnapshot>();
  for (const turn of [...current, ...incoming]) byId.set(turn.id, turn);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function mergeEvents(current: readonly HomeConversationEvent[], incoming: readonly HomeConversationEvent[]): readonly HomeConversationEvent[] {
  const bySequence = new Map<number, HomeConversationEvent>();
  for (const event of [...current, ...incoming]) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

async function readAllTurns(conversationId: string, afterSequence = 0): Promise<readonly HomeTurnSnapshot[]> {
  const turns: HomeTurnSnapshot[] = [];
  let cursor = afterSequence;
  while (true) {
    const page = await listHomeTurns(conversationId, cursor);
    turns.push(...page.turns);
    if (page.nextAfterSequence === null || page.nextAfterSequence === cursor || page.turns.length === 0) break;
    cursor = page.nextAfterSequence;
  }
  return turns;
}

async function readAllEvents(conversationId: string, afterSequence = 0): Promise<readonly HomeConversationEvent[]> {
  const events: HomeConversationEvent[] = [];
  let cursor = afterSequence;
  while (true) {
    const page = await listHomeEvents(conversationId, cursor);
    const ordered = [...page.events].sort((left, right) => left.sequence - right.sequence);
    events.push(...ordered.filter((event) => event.sequence > cursor));
    const lastProcessed = ordered.at(-1)?.sequence ?? cursor;
    if (page.nextAfterSequence === null || page.nextAfterSequence === cursor || ordered.length === 0) break;
    cursor = Math.max(lastProcessed, page.nextAfterSequence);
  }
  return events;
}

function disclosureFromEvent(event: HomeConversationEvent): HomeConsentDisclosure | null {
  const payload = event.payload;
  if (event.type !== 'consent.requested' || !event.turnId || !event.entityId) return null;
  const phase = payload.phase;
  const profile = payload.providerProfile;
  const model = payload.model;
  const scopeKind = payload.scopeKind;
  const categories = payload.categories;
  const itemCount = payload.itemCount;
  const byteLimit = payload.byteLimit;
  if ((phase !== 'initial' && phase !== 'tool_result') || typeof profile !== 'string' || typeof model !== 'string' ||
    (scopeKind !== 'home' && scopeKind !== 'workspace') || !Array.isArray(categories) ||
    typeof itemCount !== 'number' || typeof byteLimit !== 'number') return null;
  const scopeId = payload.scopeId;
  if (scopeKind === 'workspace' && typeof scopeId !== 'string') return null;
  const name = profile === 'nvidia-hosted-nim' ? 'NVIDIA hosted NIM' : profile === 'nebius-token-factory' ? 'Nebius Token Factory' : profile;
  return {
    disclosureId: event.entityId,
    phase,
    provider: { profile, name, model },
    scope: scopeKind === 'home' ? { kind: 'home' } : { kind: 'workspace', workspaceId: scopeId as string },
    categories: categories.filter((item): item is HomeConsentDisclosure['categories'][number] => typeof item === 'string'),
    itemCount,
    byteLimit
  };
}

function pendingDisclosureFrom(events: readonly HomeConversationEvent[], scope: HomeConversationScope): { readonly turnId: string; readonly disclosure: HomeConsentDisclosure } | null {
  let pending: { turnId: string; disclosure: HomeConsentDisclosure } | null = null;
  for (const event of events) {
    if (event.type === 'consent.requested') {
      const disclosure = disclosureFromEvent(event);
      if (disclosure && sameScope(disclosure.scope, scope)) pending = { turnId: event.turnId as string, disclosure };
    } else if (event.type === 'consent.decided' && event.turnId === pending?.turnId && event.entityId === pending.disclosure.disclosureId) {
      pending = null;
    }
  }
  return pending;
}

function conversationError(error: unknown): string {
  if (error instanceof ApiClientError && error.statusCode === 404) return 'This conversation is unavailable in the selected scope.';
  return 'Conversation history could not be loaded. Refresh to reconnect.';
}

function requestError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'PLANNING_RUNTIME_UNAVAILABLE') return 'The configured planning runtime is unavailable. Check its configuration or wait for it to reconnect, then reload Home chat to retry.';
    if (error.details[0]?.message) return error.details[0].message;
    if (error.statusCode === 401) return 'Your session expired. Sign in again to continue.';
  }
  return 'The request may not have been saved. Refresh history before retrying.';
}

function definitiveClientRejection(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode >= 400 && error.statusCode < 500 && error.code !== 'HOME_REQUEST_KEY_REUSED';
}

export interface UseHomeChatOptions {
  readonly scope: HomeConversationScope;
  readonly disabled?: boolean;
}

export interface HomeChatController {
  readonly conversations: readonly HomeConversationSnapshot[];
  readonly listStatus: LoadStatus;
  readonly listError: string | null;
  readonly hasMoreConversations: boolean;
  readonly loadMoreConversations: () => Promise<void>;
  readonly retryConversationList: () => void;
  readonly selectedConversation: HomeConversationSnapshot | null;
  readonly selectedConversationId: string | null;
  readonly isNewConversation: boolean;
  readonly startNewConversation: () => void;
  readonly navigationLocked: boolean;
  readonly messages: readonly HomeMessageSnapshot[];
  readonly turns: readonly HomeTurnSnapshot[];
  readonly events: readonly HomeConversationEvent[];
  readonly lastProcessedEventSequence: number;
  readonly historyStatus: LoadStatus;
  readonly historyError: string | null;
  readonly hasEarlierMessages: boolean;
  readonly loadEarlierMessages: () => Promise<void>;
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly send: () => Promise<void>;
  readonly retryCreate: () => Promise<void>;
  readonly createNeedsRetry: boolean;
  readonly checkSubmission: () => Promise<void>;
  readonly retrySameSubmission: () => Promise<void>;
  readonly submitCanRetry: boolean;
  readonly sendStatus: SendStatus;
  readonly sendError: string | null;
  readonly clearSendError: () => void;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly runtimeUnavailable: boolean;
  readonly activeTurn: HomeTurnSnapshot | null;
  readonly pendingDisclosure: { readonly turnId: string; readonly disclosure: HomeConsentDisclosure } | null;
  readonly decisionPending: boolean;
  readonly decide: (decision: 'allow' | 'deny') => Promise<void>;
  readonly cancelPending: boolean;
  readonly cancelNeedsCheck: boolean;
  readonly statusCheckPending: boolean;
  readonly cancel: () => Promise<void>;
  readonly checkTurnStatus: () => Promise<void>;
  readonly reconnecting: boolean;
  readonly refreshConversation: () => void;
  readonly loadStatus: (turnId: string) => string | null;
  readonly wasKeptPrivate: (turnId: string) => boolean;
}

export function useHomeChat({ scope, disabled = false }: UseHomeChatOptions): HomeChatController {
  const [searchParams, setSearchParams] = useSearchParams();
  const csrfToken = useAppSelector(selectCsrfToken);
  const scopeId = scopeKey(scope);
  const urlConversationId = searchParams.get('conversation');
  const [selectionOverride, setSelectionOverride] = useState<{ readonly from: string | null; readonly value: string | null } | null>(null);
  const selectedConversationId = selectionOverride?.from === urlConversationId ? selectionOverride.value : urlConversationId;
  const [isNewConversation, setIsNewConversation] = useState(false);
  const selectedViewKey = viewKey(scopeId, selectedConversationId, isNewConversation);
  const scopeRef = useRef(scope);
  const urlConversationRef = useRef(urlConversationId);
  const scopeIdRef = useRef(scopeId);
  const viewKeyRef = useRef(selectedViewKey);
  const isNewRef = useRef(isNewConversation);
  scopeRef.current = scope;
  urlConversationRef.current = urlConversationId;
  scopeIdRef.current = scopeId;
  viewKeyRef.current = selectedViewKey;
  isNewRef.current = isNewConversation;

  const [conversations, setConversations] = useState<readonly HomeConversationSnapshot[]>([]);
  const [listStatus, setListStatus] = useState<LoadStatus>('idle');
  const [listError, setListError] = useState<string | null>(null);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [loadedListScope, setLoadedListScope] = useState('');
  const [loadedConversation, setLoadedConversation] = useState<HomeConversationSnapshot | null>(null);
  const [loadedForKey, setLoadedForKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly HomeMessageSnapshot[]>([]);
  const [messageCursor, setMessageCursor] = useState<number | null>(null);
  const [turns, setTurns] = useState<readonly HomeTurnSnapshot[]>([]);
  const [events, setEvents] = useState<readonly HomeConversationEvent[]>([]);
  const [lastProcessedEventSequence, setLastProcessedEventSequence] = useState(0);
  const eventsRef = useRef<readonly HomeConversationEvent[]>([]);
  const eventCursorRef = useRef(0);
  const [historyStatus, setHistoryStatus] = useState<LoadStatus>('idle');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [sendStatus, setSendStatus] = useState<SendStatus>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [createNeedsRetry, setCreateNeedsRetry] = useState(false);
  const [submitCanRetry, setSubmitCanRetry] = useState(false);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(unavailableInSession);
  const [pendingDisclosure, setPendingDisclosure] = useState<{ readonly turnId: string; readonly disclosure: HomeConsentDisclosure } | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelNeedsCheck, setCancelNeedsCheck] = useState(false);
  const [statusCheckPending, setStatusCheckPending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reviewedUnknownTurnIds, setReviewedUnknownTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deniedTurnIds, setDeniedTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const sendIntentRef = useRef<SendIntent | null>(null);
  const createIntentRef = useRef<CreateIntent | null>(null);
  const busyRef = useRef(false);
  const busyTokenRef = useRef(0);
  const previousViewKeyRef = useRef(selectedViewKey);
  const cancelAttemptRef = useRef(false);
  const prevScopeIdRef = useRef(scopeId);

  if (previousViewKeyRef.current !== selectedViewKey) {
    previousViewKeyRef.current = selectedViewKey;
    busyTokenRef.current += 1;
    busyRef.current = false;
  }

  function beginBusyOperation(): number {
    const token = ++busyTokenRef.current;
    busyRef.current = true;
    return token;
  }

  function endBusyOperation(token: number): void {
    if (busyTokenRef.current === token) busyRef.current = false;
  }

  const current = useCallback((key: string): boolean => viewKeyRef.current === key, []);
  const currentScope = useCallback((key: string): boolean => scopeIdRef.current === key, []);

  useEffect(() => {
    if (prevScopeIdRef.current !== scopeId) {
      prevScopeIdRef.current = scopeId;
      setIsNewConversation(false);
      setDraft('');
      setSendError(null);
      setPendingDisclosure(null);
      sendIntentRef.current = null;
      createIntentRef.current = null;
    }
  }, [scopeId]);

  useEffect(() => {
    if (selectionOverride && selectionOverride.from !== urlConversationId) setSelectionOverride(null);
  }, [selectionOverride, urlConversationId]);

  useEffect(() => {
    cancelAttemptRef.current = false;
    setCancelPending(false);
    setCancelNeedsCheck(false);
    setStatusCheckPending(false);
    setDecisionPending(false);
    setSendError(null);
    setReconnecting(false);
  }, [selectedViewKey]);

  useEffect(() => {
    let cancelled = false;
    setListStatus('loading');
    setListError(null);
    void listHomeConversations(scope).then((page) => {
      if (cancelled || scopeIdRef.current !== scopeId) return;
      setConversations(page.conversations);
      setListCursor(page.nextCursor);
      setLoadedListScope(scopeId);
      setListStatus('success');
    }).catch(() => {
      if (cancelled || scopeIdRef.current !== scopeId) return;
      setListError('Saved conversations could not be loaded. Try again.');
      setListStatus('error');
    });
    return () => { cancelled = true; };
  }, [scopeId, listAttempt]);

  useEffect(() => {
    if (loadedListScope !== scopeId || listStatus !== 'success' || selectedConversationId || isNewConversation) return;
    const first = conversations[0];
    if (!first) return;
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('conversation', first.id);
      return next;
    }, { replace: true });
  }, [conversations, isNewConversation, listStatus, loadedListScope, scopeId, selectedConversationId, setSearchParams]);

  useEffect(() => {
    if (!selectedConversationId) {
      setLoadedForKey(null);
      setLoadedConversation(null);
      setMessages([]);
      setMessageCursor(null);
      setTurns([]);
      eventsRef.current = [];
      eventCursorRef.current = 0;
      setEvents([]);
      setLastProcessedEventSequence(0);
      setPendingDisclosure(null);
      setHistoryStatus('idle');
      setHistoryError(null);
      return;
    }
    const requestKey = viewKey(scopeId, selectedConversationId, false);
    let cancelled = false;
    eventCursorRef.current = 0;
    eventsRef.current = [];
    setEvents([]);
    setLastProcessedEventSequence(0);
    setLoadedForKey(null);
    setLoadedConversation(null);
    setMessages([]);
    setMessageCursor(null);
    setTurns([]);
    setPendingDisclosure(null);
    setHistoryStatus('loading');
    setHistoryError(null);
    void Promise.all([
      getHomeConversation(selectedConversationId),
      listHomeMessages(selectedConversationId),
      readAllTurns(selectedConversationId),
      readAllEvents(selectedConversationId, 0)
    ]).then(([conversation, messagePage, loadedTurns, loadedEvents]) => {
      if (cancelled || !current(requestKey)) return;
      if (!sameScope(conversation.scope, scopeRef.current)) throw new Error('Conversation is outside the selected scope.');
      setLoadedConversation(conversation);
      setConversations((previous) => previous.some((item) => item.id === conversation.id) ? previous : [conversation, ...previous]);
      setMessages((previous) => mergeMessages(previous, messagePage.messages));
      setMessageCursor(messagePage.nextBeforeSequence);
      setTurns((previous) => mergeTurns(previous, loadedTurns));
      const sortedEvents = mergeEvents(eventsRef.current, loadedEvents);
      eventsRef.current = sortedEvents;
      setEvents(sortedEvents);
      const cursor = Math.max(eventCursorRef.current, sortedEvents.at(-1)?.sequence ?? 0);
      eventCursorRef.current = cursor;
      setLastProcessedEventSequence(cursor);
      setPendingDisclosure(pendingDisclosureFrom(sortedEvents, scopeRef.current));
      const denied = new Set<string>();
      for (const event of sortedEvents) {
        if (event.type === 'consent.decided' && event.turnId && event.payload.decision === 'deny') denied.add(event.turnId);
      }
      setDeniedTurnIds((previous) => new Set([...previous, ...denied]));
      setLoadedForKey(requestKey);
      setHistoryStatus('success');
    }).catch((error: unknown) => {
      if (cancelled || !current(requestKey)) return;
      setHistoryError(conversationError(error));
      setHistoryStatus('error');
    });
    return () => { cancelled = true; };
  }, [current, refreshAttempt, scopeId, selectedConversationId]);

  const selectedConversation = loadedForKey === selectedViewKey && loadedConversation?.id === selectedConversationId
    ? loadedConversation
    : conversations.find((item) => item.id === selectedConversationId) ?? null;
  const visibleMessages = loadedForKey === selectedViewKey ? messages : [];
  const activeTurn = useMemo(() => {
    const reverse = [...turns].reverse();
    return reverse.find((turn) => ACTIVE_STATUSES.has(turn.status)) ?? reverse[0] ?? null;
  }, [turns]);
  const currentTurnNeedsReview = Boolean(activeTurn?.status === 'unknown' && !reviewedUnknownTurnIds.has(activeTurn.id));
  const activeTurnBlocksSend = Boolean(activeTurn && (ACTIVE_STATUSES.has(activeTurn.status) || currentTurnNeedsReview));
  const pendingForActiveTurn = Boolean(pendingDisclosure && pendingDisclosure.turnId === activeTurn?.id);
  const sendBusy = sendStatus === 'creating' || sendStatus === 'submitting' || sendStatus === 'reconciling' || sendStatus === 'retrying';

  const refreshEventFeed = useCallback(async (conversationId: string, requestKey: string): Promise<void> => {
    let cursor = eventCursorRef.current;
    let reachedEnd = false;
    while (!reachedEnd) {
      const page = await listHomeEvents(conversationId, cursor);
      if (!current(requestKey)) return;
      const ordered = [...page.events].sort((left, right) => left.sequence - right.sequence);
      const newEvents = ordered.filter((event) => event.sequence > cursor);
      if (!newEvents.length && page.nextAfterSequence !== null) break;
      for (const event of newEvents) {
        cursor = event.sequence;
        eventCursorRef.current = cursor;
        setLastProcessedEventSequence(cursor);
      }
      if (newEvents.length) {
        const merged = mergeEvents(eventsRef.current, newEvents);
        eventsRef.current = merged;
        setEvents(merged);
        setPendingDisclosure(pendingDisclosureFrom(merged, scopeRef.current));
        const denied = new Set<string>();
        for (const event of newEvents) {
          if (event.type === 'consent.decided' && event.turnId && event.payload.decision === 'deny') denied.add(event.turnId);
        }
        if (denied.size) setDeniedTurnIds((previous) => new Set([...previous, ...denied]));
        setTurns((previous) => previous.map((turn) => {
          const statusEvent = [...newEvents].reverse().find((event) => event.type === 'turn.status_changed' && event.turnId === turn.id);
          const status = statusEvent?.payload.status;
          return statusEvent && typeof status === 'string' && isTurnStatus(status) ? { ...turn, status, updatedAt: statusEvent.createdAt } : turn;
        }));
      }
      reachedEnd = page.nextAfterSequence === null;
      if (!reachedEnd) {
        const next = page.nextAfterSequence;
        if (next === cursor && newEvents.length === 0) break;
        cursor = next ?? cursor;
      }
    }
  }, [current]);

  const refreshConversation = useCallback((): void => {
    setReconnecting(false);
    setRefreshAttempt((value) => value + 1);
  }, []);

  const retryConversationList = useCallback((): void => setListAttempt((value) => value + 1), []);

  const loadMoreConversations = useCallback(async (): Promise<void> => {
    if (!listCursor || listLoadingMore || loadedListScope !== scopeId) return;
    const requestScope = scopeId;
    setListLoadingMore(true);
    try {
      const page = await listHomeConversations(scopeRef.current, listCursor);
      if (!currentScope(requestScope)) return;
      setConversations((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...page.conversations.filter((item) => !seen.has(item.id))];
      });
      setListCursor(page.nextCursor);
    } catch {
      if (currentScope(requestScope)) setListError('More conversations could not be loaded. Try again.');
    } finally {
      if (currentScope(requestScope)) setListLoadingMore(false);
    }
  }, [currentScope, listCursor, listLoadingMore, loadedListScope, scopeId]);

  const startNewConversation = useCallback((): void => {
    if (sendIntentRef.current || createIntentRef.current) return;
    setSelectionOverride({ from: urlConversationRef.current, value: null });
    setIsNewConversation(true);
    viewKeyRef.current = viewKey(scopeIdRef.current, null, true);
    sendIntentRef.current = null;
    createIntentRef.current = null;
    setSendStatus('idle');
    setSendError(null);
    setCreateNeedsRetry(false);
    setSubmitCanRetry(false);
    setDraft('');
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('conversation');
      return next;
    });
  }, [setSearchParams]);

  const loadEarlierMessages = useCallback(async (): Promise<void> => {
    if (!selectedConversationId || messageCursor === null || historyStatus !== 'success') return;
    const requestKey = selectedViewKey;
    try {
      const page = await listHomeMessages(selectedConversationId, messageCursor);
      if (!current(requestKey)) return;
      setMessages((previous) => mergeMessages(previous, page.messages));
      setMessageCursor(page.nextBeforeSequence);
    } catch {
      if (current(requestKey)) setHistoryError('Earlier messages could not be loaded. Try again.');
    }
  }, [current, historyStatus, messageCursor, selectedConversationId, selectedViewKey]);

  const markUnsupported = useCallback((): void => {
    setRuntimeUnavailable(true);
    try { window.sessionStorage.setItem(UNAVAILABLE_KEY, 'true'); } catch { /* session storage is optional */ }
  }, []);

  const refreshLatestFor = useCallback(async (conversationId: string, requestKey: string): Promise<HomeMessageSnapshot[]> => {
    const page = await listHomeMessages(conversationId);
    if (!current(requestKey)) return [];
    setMessages((previous) => mergeMessages(previous, page.messages));
    setMessageCursor((previous) => previous ?? page.nextBeforeSequence);
    return [...page.messages];
  }, [current]);

  const applySubmission = useCallback((submission: HomeTurnSubmission, requestKey: string, content: string): void => {
    if (!current(requestKey)) return;
    setTurns((previous) => mergeTurns(previous, [submission.turn]));
    setMessages((previous) => mergeMessages(previous, [submission.message]));
    setSubmitCanRetry(false);
    setSendError(null);
    if (submission.execution.state === 'consent_required') {
      setPendingDisclosure({ turnId: submission.turn.id, disclosure: submission.execution.disclosure });
      setSendStatus('idle');
      return;
    }
    setPendingDisclosure(null);
    if (submission.execution.state === 'unsupported' || submission.turn.status === 'unsupported') markUnsupported();
    if ((submission.execution.state === 'running' || submission.execution.state === 'resumed') && submission.turn.status === 'running') {
      setDraft((previous) => previous === content ? '' : previous);
    }
    setSendStatus('idle');
  }, [current, markUnsupported]);

  const findCommittedSubmission = useCallback((intent: SendIntent, loadedTurns: readonly HomeTurnSnapshot[], loadedMessages: readonly HomeMessageSnapshot[]): { turn: HomeTurnSnapshot; message: HomeMessageSnapshot } | null => {
    const candidateTurns = loadedTurns.filter((turn) => turn.sequence > intent.afterTurnSequence).sort((left, right) => right.sequence - left.sequence);
    for (const turn of candidateTurns) {
      const message = loadedMessages.find((item) => item.turnId === turn.id && item.role === 'user' && item.content === intent.content);
      if (message) return { turn, message };
    }
    return null;
  }, []);

  const reconcileSubmission = useCallback(async (intent: SendIntent, requestKey: string): Promise<'found' | 'missing' | 'unavailable'> => {
    try {
      await refreshEventFeed(intent.conversationId, requestKey);
      const [messagePage, foundTurns] = await Promise.all([
        listHomeMessages(intent.conversationId),
        readAllTurns(intent.conversationId, intent.afterTurnSequence)
      ]);
      if (!current(requestKey)) return 'unavailable';
      setMessages((previous) => mergeMessages(previous, messagePage.messages));
      setMessageCursor((previous) => previous ?? messagePage.nextBeforeSequence);
      setTurns((previous) => mergeTurns(previous, foundTurns));
      const found = findCommittedSubmission(intent, foundTurns, messagePage.messages);
      if (!found) return 'missing';
      setTurns((previous) => mergeTurns(previous, [found.turn]));
      setMessages((previous) => mergeMessages(previous, [found.message]));
      setSendStatus('idle');
      setSendError(null);
      setSubmitCanRetry(false);
      sendIntentRef.current = null;
      const disclosure = pendingDisclosureFrom(eventsRef.current, scopeRef.current);
      setPendingDisclosure(disclosure);
      if (found.turn.status === 'unsupported') markUnsupported();
      if (found.turn.status === 'running') setDraft((previous) => previous === intent.content ? '' : previous);
      return 'found';
    } catch {
      if (current(requestKey)) {
        setSendStatus('uncertain');
        setSendError('We could not confirm whether this message was saved. Refresh history before retrying.');
        setSubmitCanRetry(false);
      }
      return 'unavailable';
    }
  }, [current, findCommittedSubmission, markUnsupported, refreshEventFeed]);

  const createForCurrentDraft = useCallback(async (content: string, requestKey: string): Promise<HomeConversationSnapshot | null> => {
    const title = normalizeTitle(content);
    let intent = createIntentRef.current;
    if (!intent || intent.scopeKey !== scopeIdRef.current || intent.title !== title) {
      intent = { scopeKey: scopeIdRef.current, title, key: createIdempotencyKey() };
      createIntentRef.current = intent;
    }
    setSendStatus('creating');
    setSendError(null);
    setCreateNeedsRetry(false);
    try {
      const conversation = await createHomeConversation(scopeRef.current, intent.title, csrfToken ?? '', intent.key);
      if (!current(requestKey)) return null;
      createIntentRef.current = null;
      setCreateNeedsRetry(false);
      setConversations((previous) => [conversation, ...previous.filter((item) => item.id !== conversation.id)]);
      setLoadedConversation(conversation);
      setIsNewConversation(false);
      const targetKey = viewKey(scopeIdRef.current, conversation.id, false);
      setSelectionOverride({ from: urlConversationRef.current, value: conversation.id });
      viewKeyRef.current = targetKey;
      previousViewKeyRef.current = targetKey;
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set('conversation', conversation.id);
        return next;
      });
      return conversation;
    } catch (error: unknown) {
      if (!current(requestKey)) return null;
      setSendStatus('idle');
      setSendError(requestError(error));
      if (definitiveClientRejection(error)) createIntentRef.current = null;
      else setCreateNeedsRetry(true);
      return null;
    }
  }, [csrfToken, current, setSearchParams]);

  const retryCreate = useCallback(async (): Promise<void> => {
    const intent = createIntentRef.current;
    if (!intent || !csrfToken || disabled || busyRef.current) return;
    const requestKey = viewKeyRef.current;
    const operation = beginBusyOperation();
    setSendStatus('creating');
    setSendError(null);
    try {
      const conversation = await createHomeConversation(scopeRef.current, intent.title, csrfToken, intent.key);
      if (!current(requestKey)) return;
      createIntentRef.current = null;
      setCreateNeedsRetry(false);
      setConversations((previous) => [conversation, ...previous.filter((item) => item.id !== conversation.id)]);
      setLoadedConversation(conversation);
      setIsNewConversation(false);
      const targetKey = viewKey(scopeIdRef.current, conversation.id, false);
      setSelectionOverride({ from: urlConversationRef.current, value: conversation.id });
      viewKeyRef.current = targetKey;
      previousViewKeyRef.current = targetKey;
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set('conversation', conversation.id);
        return next;
      });
      setSendStatus('idle');
    } catch (error: unknown) {
      if (current(requestKey)) {
        setSendStatus('idle');
        setSendError(requestError(error));
        if (definitiveClientRejection(error)) { createIntentRef.current = null; setCreateNeedsRetry(false); }
      }
    } finally { endBusyOperation(operation); }
  }, [csrfToken, current, disabled, setSearchParams]);

  const performSubmit = useCallback(async (intent: SendIntent, requestKey: string): Promise<void> => {
    if (!csrfToken || busyRef.current) return;
    const operation = beginBusyOperation();
    setSendStatus('submitting');
    setSendError(null);
    setSubmitCanRetry(false);
    try {
      const submission = await submitHomeTurn(intent.conversationId, intent.content, csrfToken, intent.key);
      if (!current(requestKey)) return;
      sendIntentRef.current = null;
      applySubmission(submission, requestKey, intent.content);
      void refreshEventFeed(intent.conversationId, requestKey).then(() => refreshLatestFor(intent.conversationId, requestKey)).catch(() => {
        if (current(requestKey)) setReconnecting(true);
      });
    } catch (error: unknown) {
      if (!current(requestKey)) return;
      setSendError(requestError(error));
      if (definitiveClientRejection(error)) {
        sendIntentRef.current = null;
        setSendStatus('idle');
        setSubmitCanRetry(false);
      } else {
        setSendStatus('reconciling');
        const result = await reconcileSubmission(intent, requestKey);
        if (!current(requestKey)) return;
        if (result === 'missing') {
          setSendStatus('uncertain');
          setSendError('The message may have been saved. Check status, then retry the same request if no turn appears.');
          setSubmitCanRetry(true);
        }
      }
    } finally { endBusyOperation(operation); }
  }, [applySubmission, csrfToken, current, reconcileSubmission, refreshEventFeed, refreshLatestFor]);

  const send = useCallback(async (): Promise<void> => {
    const content = draft;
    const requestKey = viewKeyRef.current;
    if (!content.trim() || content.length > 20000 || !csrfToken || disabled || runtimeUnavailable || busyRef.current || activeTurnBlocksSend || pendingDisclosure || createNeedsRetry || sendIntentRef.current ||
      (selectedConversationId && (historyStatus !== 'success' || loadedForKey !== requestKey))) return;
    const operation = beginBusyOperation();
    setSendError(null);
    let conversationId = selectedConversationId;
    if (!conversationId) {
      const created = await createForCurrentDraft(content, requestKey);
      if (!created) { endBusyOperation(operation); return; }
      conversationId = created.id;
      const targetKey = viewKey(scopeIdRef.current, conversationId, false);
      if (viewKeyRef.current !== targetKey) { endBusyOperation(operation); return; }
    }
    const currentTurns = loadedForKey === requestKey ? turns : [];
    const intent: SendIntent = {
      scopeKey: scopeIdRef.current,
      conversationId,
      content,
      key: createIdempotencyKey(),
      afterTurnSequence: currentTurns.reduce((maximum, turn) => Math.max(maximum, turn.sequence), 0)
    };
    sendIntentRef.current = intent;
    const targetKey = viewKey(scopeIdRef.current, conversationId, false);
    endBusyOperation(operation);
    await performSubmit(intent, targetKey);
  }, [activeTurnBlocksSend, createForCurrentDraft, createNeedsRetry, csrfToken, disabled, draft, historyStatus, loadedForKey, pendingDisclosure, performSubmit, runtimeUnavailable, selectedConversationId, turns]);

  const checkSubmission = useCallback(async (): Promise<void> => {
    const intent = sendIntentRef.current;
    if (!intent || busyRef.current) return;
    const requestKey = viewKey(scopeIdRef.current, intent.conversationId, false);
    const operation = beginBusyOperation();
    setSendStatus('reconciling');
    setSendError(null);
    const result = await reconcileSubmission(intent, requestKey);
    if (current(requestKey)) {
      if (result === 'missing') {
        setSendStatus('uncertain');
        setSendError('No saved turn is visible yet. You can retry this same request safely.');
        setSubmitCanRetry(true);
      }
    }
    endBusyOperation(operation);
  }, [current, reconcileSubmission]);

  const retrySameSubmission = useCallback(async (): Promise<void> => {
    const intent = sendIntentRef.current;
    if (!intent || !submitCanRetry || busyRef.current || disabled) return;
    const requestKey = viewKey(scopeIdRef.current, intent.conversationId, false);
    const operation = beginBusyOperation();
    setSendStatus('reconciling');
    setSendError(null);
    const result = await reconcileSubmission(intent, requestKey);
    if (result !== 'missing' || !current(requestKey)) { endBusyOperation(operation); return; }
    setSendStatus('retrying');
    endBusyOperation(operation);
    await performSubmit(intent, requestKey);
  }, [current, disabled, performSubmit, reconcileSubmission, submitCanRetry]);

  const decide = useCallback(async (decision: 'allow' | 'deny'): Promise<void> => {
    const pending = pendingDisclosure;
    if (!pending || !csrfToken || decisionPending || disabled) return;
    const requestKey = viewKeyRef.current;
    setDecisionPending(true);
    setSendError(null);
    try {
      const result = await decideHomeConsent(selectedConversationId ?? '', pending.turnId, pending.disclosure.disclosureId, decision, csrfToken);
      if (!current(requestKey)) return;
      setTurns((previous) => mergeTurns(previous, [result.turn]));
      if (decision === 'deny') setDeniedTurnIds((previous) => new Set(previous).add(pending.turnId));
      if (result.execution.state === 'unsupported' || result.turn.status === 'unsupported') markUnsupported();
      setPendingDisclosure(null);
      if (decision === 'allow' && result.turn.status === 'running') setDraft((previous) => previous === draft ? '' : previous);
      await refreshEventFeed(selectedConversationId ?? '', requestKey);
    } catch {
      if (current(requestKey)) {
        setSendError('Your decision could not be confirmed. Refresh the conversation before deciding again.');
        setReconnecting(true);
        setRefreshAttempt((value) => value + 1);
      }
    } finally { if (current(requestKey)) setDecisionPending(false); }
  }, [current, csrfToken, decisionPending, disabled, draft, markUnsupported, pendingDisclosure, refreshEventFeed, selectedConversationId]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!selectedConversationId || !activeTurn || activeTurn.status !== 'running' || !csrfToken || disabled || cancelAttemptRef.current) return;
    const requestKey = viewKeyRef.current;
    cancelAttemptRef.current = true;
    setCancelPending(true);
    setCancelNeedsCheck(false);
    setSendError(null);
    try {
      const result = await cancelHomeTurn(selectedConversationId, activeTurn.id, csrfToken);
      if (!current(requestKey)) return;
      setTurns((previous) => mergeTurns(previous, [result.turn]));
      if (result.turn.status === 'cancelled') cancelAttemptRef.current = false;
      await refreshEventFeed(selectedConversationId, requestKey);
    } catch {
      if (current(requestKey)) {
        setSendError('The stop request could not be confirmed. Check status before trying again.');
        setReconnecting(true);
        setCancelNeedsCheck(true);
      }
    } finally { if (current(requestKey)) setCancelPending(false); }
  }, [activeTurn, current, csrfToken, disabled, refreshEventFeed, selectedConversationId]);

  const checkTurnStatus = useCallback(async (): Promise<void> => {
    if (!selectedConversationId || !activeTurn) return;
    const requestKey = viewKeyRef.current;
    setStatusCheckPending(true);
    setReconnecting(true);
    try {
      const result = await getHomeTurn(selectedConversationId, activeTurn.id);
      if (!current(requestKey)) return;
      setTurns((previous) => mergeTurns(previous, [result]));
      setCancelNeedsCheck(false);
      if (result.status === 'running' || result.status === 'cancelled' || result.status === 'unknown') cancelAttemptRef.current = false;
      if (result.status === 'unknown') setReviewedUnknownTurnIds((previous) => new Set(previous).add(result.id));
      await refreshEventFeed(selectedConversationId, requestKey);
      await refreshLatestFor(selectedConversationId, requestKey);
      setReconnecting(false);
      setSendError(null);
    } catch {
      if (current(requestKey)) {
        setSendError('Status is still unavailable. Try refreshing the conversation again.');
        setReconnecting(true);
      }
    } finally {
      if (current(requestKey)) setStatusCheckPending(false);
    }
  }, [activeTurn, current, refreshEventFeed, refreshLatestFor, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId || activeTurn?.status !== 'running' || pendingForActiveTurn || disabled) return;
    const requestKey = selectedViewKey;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const refreshed = await getHomeTurn(selectedConversationId, activeTurn.id);
        if (cancelled || !current(requestKey)) return;
        setTurns((previous) => mergeTurns(previous, [refreshed]));
        await refreshEventFeed(selectedConversationId, requestKey);
        await refreshLatestFor(selectedConversationId, requestKey);
        setReconnecting(false);
        setSendError(null);
      } catch {
        if (cancelled || !current(requestKey)) return;
        setReconnecting(true);
      }
      if (!cancelled && current(requestKey)) timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeTurn?.id, activeTurn?.status, current, disabled, pendingForActiveTurn, refreshEventFeed, refreshLatestFor, selectedConversationId, selectedViewKey]);

  const wasKeptPrivate = useCallback((turnId: string): boolean => deniedTurnIds.has(turnId), [deniedTurnIds]);
  const loadStatus = useCallback((turnId: string): string | null => {
    const turn = turns.find((item) => item.id === turnId);
    if (!turn) return null;
    if (turn.status === 'cancelled' && deniedTurnIds.has(turn.id)) return 'Cancelled — kept private';
    const labels: Record<HomeTurnSnapshot['status'], string> = {
      pending: 'Waiting for your decision', running: 'Assistant is responding…', cancel_requested: 'Stopping…',
      completed: 'Completed', partial: 'Partially completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Needs review', unsupported: 'Planning runtime unavailable'
    };
    return labels[turn.status];
  }, [deniedTurnIds, turns]);

  const canSend = !disabled && !runtimeUnavailable && !sendBusy && !activeTurnBlocksSend && !pendingDisclosure && !createNeedsRetry && !sendIntentRef.current &&
    Boolean(draft.trim()) && draft.length <= 20000 && (!selectedConversationId || (historyStatus === 'success' && loadedForKey === selectedViewKey));
  const navigationLocked = Boolean(sendIntentRef.current || createIntentRef.current);

  return {
    conversations: loadedListScope === scopeId ? conversations : [], listStatus, listError,
    hasMoreConversations: Boolean(listCursor), loadMoreConversations, retryConversationList,
    selectedConversation, selectedConversationId, isNewConversation,
    startNewConversation, navigationLocked,
    messages: visibleMessages, turns, events, lastProcessedEventSequence, historyStatus, historyError,
    hasEarlierMessages: messageCursor !== null, loadEarlierMessages,
    draft, setDraft, send, retryCreate, checkSubmission, retrySameSubmission,
    sendStatus, createNeedsRetry, submitCanRetry, sendError,
    clearSendError: () => setSendError(null),
    busy: sendBusy || decisionPending || cancelPending,
    canSend, runtimeUnavailable, activeTurn, pendingDisclosure, decisionPending, decide,
    cancelPending, cancelNeedsCheck, statusCheckPending, cancel, checkTurnStatus, reconnecting, refreshConversation,
    loadStatus, wasKeptPrivate
  };
}

function isTurnStatus(value: string): value is HomeTurnSnapshot['status'] {
  return ['pending', 'running', 'cancel_requested', 'completed', 'partial', 'failed', 'cancelled', 'unknown', 'unsupported'].includes(value);
}
