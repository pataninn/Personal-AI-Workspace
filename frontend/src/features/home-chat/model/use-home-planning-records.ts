import { useCallback, useEffect, useRef, useState } from 'react';

import {
  acceptHomeProposal,
  cancelHomeProposal,
  editHomeProposalItem,
  getHomeProposal,
  listHomeProposals,
  removeHomeProposalItem,
  resumeHomeProposal
} from '@/entities/home-conversation';
import type { HomeConversationEvent, HomeProposal, HomeProposalItem } from '@/entities/home-conversation';
import { getProject } from '@/entities/project';
import { getGlobalTask, getTaskActionReceipt, undoTaskAction } from '@/entities/project-task';
import type { GlobalTaskItem, GlobalTaskWorkspace, TaskActionReceiptMetadata } from '@/entities/project-task';
import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

export type PlanningRecordLoadState = 'loading' | 'ready' | 'error';

export interface HomeReceiptCardState {
  readonly id: string;
  readonly turnId: string | null;
  readonly state: PlanningRecordLoadState;
  readonly receipt: TaskActionReceiptMetadata | null;
  readonly target: GlobalTaskItem | GlobalTaskWorkspace | null;
  readonly targetUnavailable: boolean;
  readonly undoPending: boolean;
  readonly undoError: string | null;
  readonly conflictReason: string | null;
}

export interface HomeProposalCardState {
  readonly proposal: HomeProposal;
  readonly state: PlanningRecordLoadState;
  readonly error: string | null;
  readonly busy: boolean;
  readonly message: string | null;
  readonly itemError: { readonly itemId: string; readonly message: string } | null;
}

interface UseHomePlanningRecordsOptions {
  readonly conversationId: string | null;
  readonly events: readonly HomeConversationEvent[];
  readonly eventsConversationId: string | null;
  readonly refreshEvents: () => Promise<void>;
  readonly onSummaryRefreshRequested?: () => void;
}

export interface HomePlanningRecordsController {
  readonly receipts: readonly HomeReceiptCardState[];
  readonly proposals: readonly HomeProposalCardState[];
  readonly proposalsState: PlanningRecordLoadState;
  readonly proposalsError: string | null;
  readonly refreshReceipt: (receiptId: string) => Promise<void>;
  readonly undoReceipt: (receiptId: string) => Promise<void>;
  readonly editItem: (proposalId: string, itemId: string, changes: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly removeItem: (proposalId: string, itemId: string) => Promise<void>;
  readonly acceptProposal: (proposalId: string) => Promise<void>;
  readonly resumeProposal: (proposalId: string) => Promise<void>;
  readonly cancelProposal: (proposalId: string) => Promise<void>;
  readonly retryProposals: () => void;
  readonly refreshEvents: () => Promise<void>;
}

const RECEIPT_EVENT_TYPE = 'action.receipt';
const PROPOSAL_EVENT_TYPES = new Set(['proposal.created', 'proposal.updated', 'proposal.accepted', 'proposal.item_status_changed', 'proposal.cancelled']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function undoConflictReason(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.code !== 'ACTION_UNDO_CONFLICT') return null;
  const reason = record(error.responseData)?.reason;
  return typeof reason === 'string' ? reason : null;
}

function conflictMessage(reason: string | null): string {
  if (reason === 'workspace_not_empty') return 'Undo was not applied because this workspace still has tasks. No tasks were removed.';
  if (reason === 'folder_attached') return 'Undo was not applied because this workspace now has an attached folder.';
  if (reason === 'already_undone') return 'This action has already been undone.';
  if (reason === 'archived_workspace') return 'Undo was not applied because the workspace has been archived.';
  return 'This item changed after the action, so Undo was not applied.';
}

function undoErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.statusCode === 401) return 'Your session expired. Sign in again before undoing this action.';
  return 'Undo could not be confirmed. Refresh the receipt before retrying.';
}

function isEligibleToResume(proposal: HomeProposal): boolean {
  if (!['accepted', 'executing', 'partial', 'unknown'].includes(proposal.state)) return false;
  return proposal.items.some((item) => ['ready', 'executing', 'unknown'].includes(item.state) && item.receiptId === null);
}

function isCancelable(proposal: HomeProposal): boolean {
  return ['accepted', 'executing', 'partial', 'unknown'].includes(proposal.state) &&
    proposal.items.some((item) => ['ready', 'executing', 'unknown'].includes(item.state) && item.receiptId === null);
}

async function loadAllProposalDetails(conversationId: string): Promise<readonly HomeProposal[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listHomeProposals(conversationId, cursor);
    ids.push(...page.proposals.map((proposal) => proposal.id));
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  } while (true);
  return Promise.all(ids.map((id) => getHomeProposal(conversationId, id)));
}

export function useHomePlanningRecords({
  conversationId,
  events,
  eventsConversationId,
  refreshEvents,
  onSummaryRefreshRequested
}: UseHomePlanningRecordsOptions): HomePlanningRecordsController {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [receipts, setReceipts] = useState<readonly HomeReceiptCardState[]>([]);
  const [receiptsConversationId, setReceiptsConversationId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<readonly HomeProposalCardState[]>([]);
  const [proposalsConversationId, setProposalsConversationId] = useState<string | null>(null);
  const [proposalsState, setProposalsState] = useState<PlanningRecordLoadState>('loading');
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [proposalAttempt, setProposalAttempt] = useState(0);
  const loadedReceiptIds = useRef(new Set<string>());
  const loadingReceiptIds = useRef(new Set<string>());
  const loadingProposalIds = useRef(new Set<string>());
  const pendingProposalReloads = useRef(new Set<string>());
  const proposalEventSequences = useRef(new Map<string, number>());
  const undoKeys = useRef(new Map<string, string>());
  const currentConversation = useRef(conversationId);
  currentConversation.current = conversationId;

  useEffect(() => {
    currentConversation.current = conversationId;
    loadedReceiptIds.current.clear();
    loadingReceiptIds.current.clear();
    loadingProposalIds.current.clear();
    pendingProposalReloads.current.clear();
    proposalEventSequences.current.clear();
    undoKeys.current.clear();
    setReceipts([]);
    setReceiptsConversationId(conversationId);
    setProposals([]);
    setProposalsConversationId(conversationId);
    setProposalsError(null);
    setProposalsState(conversationId ? 'loading' : 'ready');
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setProposalsState('loading');
    setProposalsError(null);
    void loadAllProposalDetails(conversationId).then((items) => {
      if (cancelled || currentConversation.current !== conversationId) return;
      setProposals(items.map((proposal) => ({ proposal, state: 'ready', error: null, busy: false, message: null, itemError: null })));
      setProposalsConversationId(conversationId);
      setProposalsState('ready');
    }).catch(() => {
      if (cancelled || currentConversation.current !== conversationId) return;
      setProposalsError('Saved planning previews could not be loaded. Refresh to try again.');
      setProposalsState('error');
    });
    return () => { cancelled = true; };
  }, [conversationId, proposalAttempt]);

  const loadReceipt = useCallback(async (receiptId: string, turnId: string | null, force = false): Promise<void> => {
    if (!conversationId || loadingReceiptIds.current.has(receiptId) || (!force && loadedReceiptIds.current.has(receiptId))) return;
    loadingReceiptIds.current.add(receiptId);
    const requestConversation = conversationId;
    setReceipts((previous) => {
      const current = previous.find((item) => item.id === receiptId);
      const next: HomeReceiptCardState = current
        ? { ...current, state: 'loading' }
        : { id: receiptId, turnId, state: 'loading', receipt: null, target: null, targetUnavailable: false, undoPending: false, undoError: null, conflictReason: null };
      return [next, ...previous.filter((item) => item.id !== receiptId)];
    });
    try {
      const receipt = await getTaskActionReceipt(receiptId);
      if (currentConversation.current !== requestConversation) return;
      let target: GlobalTaskItem | GlobalTaskWorkspace | null = null;
      let targetUnavailable = false;
      try {
        if (receipt.targetKind === 'task') {
          target = await getGlobalTask(receipt.targetId, true);
        } else {
          const workspace = await getProject(receipt.targetId);
          target = { id: workspace.id, name: workspace.name, status: workspace.status };
        }
      } catch {
        targetUnavailable = true;
      }
      if (currentConversation.current !== requestConversation) return;
      loadedReceiptIds.current.add(receiptId);
      setReceipts((previous) => previous.map((item) => {
        if (item.id !== receiptId) return item;
        const reconciled = item.receipt?.undoStatus !== receipt.undoStatus && receipt.undoStatus !== 'available';
        return { ...item, state: 'ready', receipt, target, targetUnavailable, undoPending: false,
          ...(reconciled ? { undoError: null, conflictReason: null } : {}) };
      }));
    } catch {
      if (currentConversation.current !== requestConversation) return;
      loadedReceiptIds.current.add(receiptId);
      setReceipts((previous) => previous.map((item) => item.id === receiptId ? { ...item, state: 'error', undoPending: false } : item));
    } finally {
      loadingReceiptIds.current.delete(receiptId);
    }
  }, [conversationId]);

  const refreshProposalFromServer = useCallback(async (proposalId: string): Promise<void> => {
    if (!conversationId) return;
    if (loadingProposalIds.current.has(proposalId)) {
      pendingProposalReloads.current.add(proposalId);
      return;
    }
    loadingProposalIds.current.add(proposalId);
    const requestConversation = conversationId;
    try {
      do {
        pendingProposalReloads.current.delete(proposalId);
        try {
          const proposal = await getHomeProposal(requestConversation, proposalId);
          if (currentConversation.current !== requestConversation) return;
          setProposals((previous) => {
            const current = previous.find((item) => item.proposal.id === proposal.id);
            const next: HomeProposalCardState = { proposal, state: 'ready', error: null, busy: current?.busy ?? false, message: null, itemError: current?.itemError ?? null };
            return current ? previous.map((item) => item.proposal.id === proposal.id ? next : item) : [next, ...previous];
          });
          setProposalsConversationId(requestConversation);
        } catch {
          if (currentConversation.current === requestConversation) {
            setProposals((previous) => previous.map((item) => item.proposal.id === proposalId
              ? { ...item, error: 'This saved preview could not be refreshed.', state: 'error' }
              : item));
          }
        }
      } while (currentConversation.current === requestConversation && pendingProposalReloads.current.has(proposalId));
    } finally {
      loadingProposalIds.current.delete(proposalId);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || eventsConversationId !== conversationId) return;
    for (const event of events) {
      if (event.type === RECEIPT_EVENT_TYPE && event.entityId) void loadReceipt(event.entityId, event.turnId);
      if (PROPOSAL_EVENT_TYPES.has(event.type) && event.entityId) {
        const lastSequence = proposalEventSequences.current.get(event.entityId) ?? 0;
        if (event.sequence > lastSequence) {
          proposalEventSequences.current.set(event.entityId, event.sequence);
          void refreshProposalFromServer(event.entityId);
        }
      }
    }
  }, [conversationId, events, eventsConversationId, loadReceipt, refreshProposalFromServer]);

  const refreshReceipt = useCallback(async (receiptId: string): Promise<void> => {
    const current = receipts.find((item) => item.id === receiptId);
    await loadReceipt(receiptId, current?.turnId ?? null, true);
  }, [loadReceipt, receipts]);

  const undoReceipt = useCallback(async (receiptId: string): Promise<void> => {
    if (!csrfToken) return;
    const current = receipts.find((item) => item.id === receiptId);
    if (!current?.receipt || current.receipt.undoStatus !== 'available' || current.undoPending) return;
    const key = undoKeys.current.get(receiptId) ?? createIdempotencyKey();
    undoKeys.current.set(receiptId, key);
    setReceipts((previous) => previous.map((item) => item.id === receiptId ? { ...item, undoPending: true, undoError: null, conflictReason: null } : item));
    try {
      const refreshedReceipt = await getTaskActionReceipt(receiptId);
      if (refreshedReceipt.undoStatus === 'undone') {
        undoKeys.current.delete(receiptId);
        setReceipts((previous) => previous.map((item) => item.id === receiptId ? { ...item, receipt: refreshedReceipt, undoPending: false, undoError: null, conflictReason: null } : item));
        await loadReceipt(receiptId, current.turnId, true);
        return;
      }
      if (refreshedReceipt.undoStatus !== 'available') {
        setReceipts((previous) => previous.map((item) => item.id === receiptId ? { ...item, receipt: refreshedReceipt, undoPending: false, undoError: null } : item));
        return;
      }
      const result = await undoTaskAction(receiptId, csrfToken, key);
      undoKeys.current.delete(receiptId);
      setReceipts((previous) => previous.map((item) => item.id === receiptId
        ? { ...item, receipt: result.originalAction, target: result.target?.kind === 'task' ? result.target.item : result.target?.kind === 'workspace' ? result.target.workspace : null, targetUnavailable: result.target === null, undoPending: false, undoError: null, conflictReason: null }
        : item));
      onSummaryRefreshRequested?.();
      await loadReceipt(receiptId, current.turnId, true);
    } catch (error: unknown) {
      const conflictReason = undoConflictReason(error);
      if (conflictReason) {
        undoKeys.current.delete(receiptId);
        setReceipts((previous) => previous.map((item) => item.id === receiptId
          ? { ...item, undoPending: false, undoError: conflictMessage(conflictReason), conflictReason }
          : item));
        await loadReceipt(receiptId, current.turnId, true);
        return;
      }
      setReceipts((previous) => previous.map((item) => item.id === receiptId
        ? { ...item, undoPending: false, undoError: undoErrorMessage(error) }
        : item));
      await loadReceipt(receiptId, current.turnId, true);
    }
  }, [csrfToken, loadReceipt, onSummaryRefreshRequested, receipts]);

  const mutateProposal = useCallback(async (
    proposalId: string,
    mutation: (proposal: HomeProposal, token: string) => Promise<HomeProposal>,
    itemId?: string,
    canMutate: (proposal: HomeProposal) => boolean = (proposal) => proposal.state === 'review_required'
  ): Promise<void> => {
    const current = proposals.find((item) => item.proposal.id === proposalId);
    if (!conversationId || !csrfToken || !current || current.busy || !canMutate(current.proposal)) return;
    const requestConversation = conversationId;
    setProposals((previous) => previous.map((item) => item.proposal.id === proposalId ? { ...item, busy: true, error: null, message: null, itemError: null } : item));
    try {
      const proposal = await mutation(current.proposal, csrfToken);
      if (currentConversation.current !== requestConversation) return;
      setProposals((previous) => previous.map((item) => item.proposal.id === proposalId ? { proposal, state: 'ready', error: null, busy: false, message: null, itemError: null } : item));
    } catch (error: unknown) {
      if (currentConversation.current !== requestConversation) return;
      const validationMessage = error instanceof ApiClientError && error.statusCode === 400
        ? error.details[0]?.message ?? 'Check this proposed item and try again.'
        : null;
      try {
        const proposal = await getHomeProposal(requestConversation, proposalId);
        setProposals((previous) => previous.map((item) => item.proposal.id === proposalId
          ? { proposal, state: 'ready', error: validationMessage ? null : 'The change could not be confirmed. Current saved state was reloaded.', busy: false, message: null,
            itemError: itemId && validationMessage ? { itemId, message: validationMessage } : null }
          : item));
      } catch {
        setProposals((previous) => previous.map((item) => item.proposal.id === proposalId
          ? { ...item, state: 'error', error: 'The change could not be confirmed. Refresh this preview before trying again.', busy: false,
            itemError: itemId && validationMessage ? { itemId, message: validationMessage } : null }
          : item));
      }
    }
  }, [conversationId, csrfToken, proposals]);

  const editItem = useCallback(async (proposalId: string, itemId: string, changes: Readonly<Record<string, unknown>>): Promise<void> => {
    await mutateProposal(proposalId, (proposal, token) => editHomeProposalItem(conversationId ?? '', proposalId, itemId, proposal.revision, changes, token), itemId);
  }, [conversationId, mutateProposal]);

  const removeItem = useCallback(async (proposalId: string, itemId: string): Promise<void> => {
    await mutateProposal(proposalId, (proposal, token) => removeHomeProposalItem(conversationId ?? '', proposalId, itemId, proposal.revision, token), itemId);
  }, [conversationId, mutateProposal]);

  const acceptProposal = useCallback(async (proposalId: string): Promise<void> => {
    const existing = proposals.find((item) => item.proposal.id === proposalId)?.proposal;
    if (!existing || !conversationId || existing.state !== 'review_required' || existing.items.length === 0) return;
    await mutateProposal(proposalId, async (proposal, token) => {
      const accepted = await acceptHomeProposal(conversationId, proposalId, proposal.revision, token);
      await refreshEvents();
      return accepted.proposal;
    });
  }, [conversationId, mutateProposal, proposals, refreshEvents]);

  const resumeProposal = useCallback(async (proposalId: string): Promise<void> => {
    if (!conversationId) return;
    await mutateProposal(proposalId, async (_proposal, token) => {
      const resumed = await resumeHomeProposal(conversationId, proposalId, token);
      await refreshEvents();
      return resumed.proposal;
    }, undefined, isEligibleToResume);
  }, [conversationId, mutateProposal, refreshEvents]);

  const cancelProposal = useCallback(async (proposalId: string): Promise<void> => {
    await mutateProposal(proposalId, async (proposal, token) => {
      const cancelled = await cancelHomeProposal(conversationId ?? '', proposalId, proposal.revision, token);
      await refreshEvents();
      return cancelled;
    }, undefined, isCancelable);
  }, [conversationId, mutateProposal, refreshEvents]);

  return {
    receipts: receiptsConversationId === conversationId ? receipts : [],
    proposals: proposalsConversationId === conversationId ? proposals : [],
    proposalsState,
    proposalsError,
    refreshReceipt,
    undoReceipt,
    editItem,
    removeItem,
    acceptProposal,
    resumeProposal,
    cancelProposal,
    retryProposals: () => setProposalAttempt((attempt) => attempt + 1),
    refreshEvents
  };
}

export function proposalCanResume(proposal: HomeProposal): boolean {
  return isEligibleToResume(proposal);
}

export function hasProposalReceipt(item: HomeProposalItem): boolean {
  return item.receiptId !== null;
}
