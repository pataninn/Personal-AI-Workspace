import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createAutomationSchedule,
  listAutomationOccurrences,
  listAutomationSchedules,
  runAutomationNow,
  updateAutomationSchedule
} from '@/entities/automation';
import type {
  AutomationOccurrence,
  AutomationOccurrencePage,
  AutomationSchedule,
  CreateAutomationScheduleRequest,
  UpdateAutomationScheduleRequest
} from '@/entities/automation';
import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { hasUnresolvedOccurrence } from '@/features/automation-management/model/automation-presentation';

export interface ScheduleHistoryState {
  readonly status: 'loading' | 'success' | 'error';
  readonly occurrences: readonly AutomationOccurrence[];
  readonly nextCursor: string | null;
  readonly errorMessage: string | null;
  readonly loadingMore: boolean;
}

export interface RunState {
  readonly status: 'idle' | 'submitting' | 'queued' | 'uncertain' | 'blocked';
  readonly message: string | null;
}

const EMPTY_HISTORY: ScheduleHistoryState = {
  status: 'loading', occurrences: [], nextCursor: null, errorMessage: null, loadingMore: false
};

export function useAutomationManagement(): {
  readonly schedules: readonly AutomationSchedule[];
  readonly scheduleStatus: 'loading' | 'success' | 'error';
  readonly scheduleError: string | null;
  readonly histories: Readonly<Record<string, ScheduleHistoryState>>;
  readonly runStates: Readonly<Record<string, RunState>>;
  readonly readyNotice: { readonly schedule: AutomationSchedule; readonly occurrence: AutomationOccurrence } | null;
  readonly refresh: () => Promise<readonly AutomationSchedule[]>;
  readonly refreshHistory: (scheduleId: string) => Promise<void>;
  readonly loadMoreHistory: (scheduleId: string) => Promise<void>;
  readonly create: (request: CreateAutomationScheduleRequest, idempotencyKey: string) => Promise<AutomationSchedule>;
  readonly update: (scheduleId: string, request: UpdateAutomationScheduleRequest) => Promise<AutomationSchedule>;
  readonly run: (scheduleId: string) => Promise<void>;
  readonly retryRun: (scheduleId: string) => Promise<void>;
  readonly dismissNotice: () => void;
} {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [schedules, setSchedules] = useState<readonly AutomationSchedule[]>([]);
  const [scheduleStatus, setScheduleStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [histories, setHistories] = useState<Readonly<Record<string, ScheduleHistoryState>>>({});
  const [runStates, setRunStates] = useState<Readonly<Record<string, RunState>>>({});
  const [readyNotice, setReadyNotice] = useState<{ readonly schedule: AutomationSchedule; readonly occurrence: AutomationOccurrence } | null>(null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const notifiedOccurrenceIds = useRef(new Set<string>());
  const occurrenceStatuses = useRef(new Map<string, AutomationOccurrence['status']>());
  const initializedHistoryIds = useRef(new Set<string>());
  const pendingRunOccurrences = useRef(new Map<string, AutomationOccurrence>());
  const runKeys = useRef(new Map<string, string>());
  const runInFlight = useRef(new Set<string>());
  const scheduleRef = useRef<readonly AutomationSchedule[]>([]);
  const historiesRef = useRef<Readonly<Record<string, ScheduleHistoryState>>>({});

  useEffect(() => { scheduleRef.current = schedules; }, [schedules]);
  useEffect(() => { historiesRef.current = histories; }, [histories]);

  const rememberOccurrenceStatuses = useCallback((occurrences: readonly AutomationOccurrence[]): void => {
    for (const occurrence of occurrences) occurrenceStatuses.current.set(occurrence.id, occurrence.status);
  }, []);

  const noteReadyResults = useCallback((scheduleId: string, occurrences: readonly AutomationOccurrence[]): void => {
    const schedule = scheduleRef.current.find((candidate) => candidate.id === scheduleId);
    if (!schedule) return;
    if (!initializedHistoryIds.current.has(scheduleId)) {
      rememberOccurrenceStatuses(occurrences);
      initializedHistoryIds.current.add(scheduleId);
      return;
    }
    let newlyReady: AutomationOccurrence | undefined;
    for (const occurrence of occurrences) {
      const previousStatus = occurrenceStatuses.current.get(occurrence.id);
      occurrenceStatuses.current.set(occurrence.id, occurrence.status);
      if (!newlyReady && occurrence.status === 'succeeded' && previousStatus !== 'succeeded'
        && !notifiedOccurrenceIds.current.has(occurrence.id)) newlyReady = occurrence;
    }
    if (newlyReady) {
      notifiedOccurrenceIds.current.add(newlyReady.id);
      setReadyNotice({ schedule, occurrence: newlyReady });
    }
  }, [rememberOccurrenceStatuses]);

  const setHistoryPage = useCallback((scheduleId: string, page: AutomationOccurrencePage, loadingMore = false): void => {
    noteReadyResults(scheduleId, page.occurrences);
    setHistories((current) => ({ ...current, [scheduleId]: {
      status: 'success', occurrences: page.occurrences, nextCursor: page.nextCursor, errorMessage: null, loadingMore
    } }));
  }, [noteReadyResults]);

  const refreshOneHistory = useCallback(async (scheduleId: string, quiet = false): Promise<boolean | null> => {
    const previous = historiesRef.current[scheduleId];
    if (!quiet || !previous || previous.status !== 'success') {
      setHistories((current) => ({ ...current, [scheduleId]: { ...(current[scheduleId] ?? EMPTY_HISTORY), status: 'loading', errorMessage: null } }));
    }
    try {
      const page = await listAutomationOccurrences(scheduleId);
      const knownRun = pendingRunOccurrences.current.get(scheduleId);
      let occurrences = page.occurrences;
      if (knownRun) {
        if (occurrences.some((occurrence) => occurrence.id === knownRun.id)) {
          pendingRunOccurrences.current.delete(scheduleId);
        } else if (hasUnresolvedOccurrence([knownRun])) {
          occurrences = [knownRun, ...occurrences];
        } else {
          pendingRunOccurrences.current.delete(scheduleId);
        }
      }
      const resolvedPage = { ...page, occurrences };
      setHistoryPage(scheduleId, resolvedPage);
      if (!hasUnresolvedOccurrence(occurrences)) {
        setRunStates((current) => current[scheduleId]?.status === 'blocked'
          ? { ...current, [scheduleId]: { status: 'idle', message: null } }
          : current);
      }
      return !hasUnresolvedOccurrence(occurrences);
    } catch {
      setHistories((current) => ({ ...current, [scheduleId]: {
        ...(current[scheduleId] ?? EMPTY_HISTORY), status: 'error', errorMessage: 'Run history could not be loaded. Try again.', loadingMore: false
      } }));
      return null;
    }
  }, [setHistoryPage]);

  const refreshAllHistories = useCallback(async (nextSchedules: readonly AutomationSchedule[], quiet = false): Promise<void> => {
    await Promise.all(nextSchedules.map((schedule) => refreshOneHistory(schedule.id, quiet)));
  }, [refreshOneHistory]);

  const refresh = useCallback(async (): Promise<readonly AutomationSchedule[]> => {
    setScheduleStatus('loading');
    setScheduleError(null);
    try {
      const nextSchedules = await listAutomationSchedules();
      scheduleRef.current = nextSchedules;
      setSchedules(nextSchedules);
      setScheduleStatus('success');
      setHistories((current) => Object.fromEntries(nextSchedules.map((schedule) => [schedule.id, current[schedule.id] ?? EMPTY_HISTORY])));
      await refreshAllHistories(nextSchedules);
      return nextSchedules;
    } catch {
      setScheduleStatus('error');
      setScheduleError('Schedules could not be loaded. Try again.');
      return [];
    }
  }, [refreshAllHistories]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function handleVisibility(): void {
      const visible = document.visibilityState !== 'hidden';
      setPageVisible(visible);
      if (visible && scheduleRef.current.length) void refreshAllHistories(scheduleRef.current, true);
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [refreshAllHistories]);

  const pendingHistoryKey = Object.entries(histories)
    .filter(([, history]) => hasUnresolvedOccurrence(history.occurrences))
    .map(([scheduleId]) => scheduleId).join('\u0000');
  useEffect(() => {
    if (!pendingHistoryKey || !pageVisible) return undefined;
    let stopped = false;
    let delay = 5_000;
    let timeout: number;
    const poll = async (): Promise<void> => {
      await Promise.all(pendingHistoryKey.split('\u0000').map((scheduleId) => refreshOneHistory(scheduleId, true)));
      if (stopped) return;
      delay = Math.min(delay * 2, 30_000);
      timeout = window.setTimeout(() => { void poll(); }, delay);
    };
    timeout = window.setTimeout(() => { void poll(); }, delay);
    return () => { stopped = true; window.clearTimeout(timeout); };
  }, [pendingHistoryKey, pageVisible, refreshOneHistory]);

  const discoveryHistoryKey = schedules.filter((schedule) => schedule.enabled
    && !hasUnresolvedOccurrence(histories[schedule.id]?.occurrences ?? []))
    .map((schedule) => schedule.id).join('\u0000');
  useEffect(() => {
    if (!discoveryHistoryKey || !pageVisible) return;
    let stopped = false;
    let timeout: number;
    const poll = async (): Promise<void> => {
      await Promise.all(discoveryHistoryKey.split('\u0000').map((scheduleId) => refreshOneHistory(scheduleId, true)));
      if (!stopped) timeout = window.setTimeout(() => { void poll(); }, 30_000);
    };
    timeout = window.setTimeout(() => { void poll(); }, 30_000);
    return () => { stopped = true; window.clearTimeout(timeout); };
  }, [discoveryHistoryKey, pageVisible, refreshOneHistory]);

  useEffect(() => {
      const settledRunIds = Object.entries(runStates)
      .filter(([scheduleId, state]) => state.status === 'queued'
        && histories[scheduleId]?.status === 'success'
        && !hasUnresolvedOccurrence(histories[scheduleId].occurrences))
      .map(([scheduleId]) => scheduleId);
    if (!settledRunIds.length) return;
    for (const scheduleId of settledRunIds) runKeys.current.delete(scheduleId);
    setRunStates((current) => Object.fromEntries(Object.entries(current).map(([scheduleId, state]) => [
      scheduleId, settledRunIds.includes(scheduleId) ? { status: 'idle', message: null } : state
    ])));
  }, [histories, runStates]);

  async function create(request: CreateAutomationScheduleRequest, idempotencyKey: string): Promise<AutomationSchedule> {
    if (!csrfToken) throw new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'The local session is not available.');
    const created = await createAutomationSchedule(request, csrfToken, idempotencyKey);
    await refresh();
    return created;
  }

  async function update(scheduleId: string, request: UpdateAutomationScheduleRequest): Promise<AutomationSchedule> {
    if (!csrfToken) throw new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'The local session is not available.');
    const updated = await updateAutomationSchedule(scheduleId, request, csrfToken);
    await refresh();
    return updated;
  }

  async function submitRun(scheduleId: string, retry = false): Promise<void> {
    const currentRunState = runStates[scheduleId] ?? { status: 'idle', message: null };
    const currentHistory = historiesRef.current[scheduleId];
    if (runInFlight.current.has(scheduleId)) return;
    if (retry) {
      if (currentRunState.status !== 'uncertain' || !runKeys.current.has(scheduleId)
        || currentHistory?.status !== 'success' || hasUnresolvedOccurrence(currentHistory.occurrences)) return;
    } else if (currentRunState.status !== 'idle' || currentHistory?.status !== 'success'
      || hasUnresolvedOccurrence(currentHistory.occurrences)) return;
    if (!csrfToken) {
      setRunStates((current) => ({ ...current, [scheduleId]: { status: 'idle', message: 'Your session must be refreshed before running a briefing.' } }));
      return;
    }
    runInFlight.current.add(scheduleId);
    const key = runKeys.current.get(scheduleId) ?? createIdempotencyKey();
    runKeys.current.set(scheduleId, key);
    setRunStates((current) => ({ ...current, [scheduleId]: { status: 'submitting', message: null } }));
    try {
      const occurrence = await runAutomationNow(scheduleId, csrfToken, key);
      if (hasUnresolvedOccurrence([occurrence])) pendingRunOccurrences.current.set(scheduleId, occurrence);
      runKeys.current.delete(scheduleId);
      setRunStates((current) => ({ ...current, [scheduleId]: { status: 'queued', message: 'Run queued. Check history for its current status.' } }));
      await refreshOneHistory(scheduleId);
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'SCHEDULE_BUSY') {
        runKeys.current.delete(scheduleId);
        await refreshOneHistory(scheduleId);
        setRunStates((current) => ({ ...current, [scheduleId]: { status: 'blocked', message: 'A run is still resolving. Check its history before starting another.' } }));
        return;
      }
      const uncertain = !(error instanceof ApiClientError) || error.statusCode >= 500 || error.code === 'IDEMPOTENCY_KEY_REUSED';
      if (!uncertain) runKeys.current.delete(scheduleId);
      setRunStates((current) => ({ ...current, [scheduleId]: {
        status: uncertain ? 'uncertain' : 'idle',
        message: uncertain
          ? 'We could not confirm this request. Refresh history, then retry the same Run now request if it is not listed.'
          : scheduleActionError(error, 'The briefing could not be started.')
      } }));
      await refreshOneHistory(scheduleId);
    } finally {
      runInFlight.current.delete(scheduleId);
    }
  }

  async function run(scheduleId: string): Promise<void> { await submitRun(scheduleId); }
  async function retryRun(scheduleId: string): Promise<void> { await submitRun(scheduleId, true); }

  async function loadMoreHistory(scheduleId: string): Promise<void> {
    const current = histories[scheduleId];
    if (!current?.nextCursor || current.loadingMore) return;
    setHistories((items) => ({ ...items, [scheduleId]: { ...current, loadingMore: true, errorMessage: null } }));
    try {
      const page = await listAutomationOccurrences(scheduleId, current.nextCursor);
      const combined = [...current.occurrences, ...page.occurrences];
      rememberOccurrenceStatuses(page.occurrences);
      setHistories((items) => ({ ...items, [scheduleId]: {
        status: 'success', occurrences: combined, nextCursor: page.nextCursor, errorMessage: null, loadingMore: false
      } }));
    } catch {
      setHistories((items) => ({ ...items, [scheduleId]: { ...current, loadingMore: false, errorMessage: 'More run history could not be loaded. Try again.' } }));
    }
  }

  return {
    schedules, scheduleStatus, scheduleError, histories, runStates, readyNotice,
    refresh, refreshHistory: async (scheduleId) => { await refreshOneHistory(scheduleId); }, loadMoreHistory,
    create, update, run, retryRun, dismissNotice: () => setReadyNotice(null)
  };
}

export function scheduleActionError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  if (error.code === 'AUTOMATION_WORKSPACE_NOT_FOUND' || error.code === 'AUTOMATION_SKILL_NOT_FOUND' || error.code === 'AUTOMATION_NOT_FOUND') return 'This workspace, skill, or schedule is no longer available. Reload current choices.';
  if (error.code === 'SCHEDULE_SKILL_NOT_READ_ONLY') return 'Choose an enabled read-only skill to update this schedule.';
  if (error.code === 'SKILL_VERSION_CONFLICT') return 'This skill changed. Reload its current version before saving.';
  if (error.code === 'SCHEDULE_REVISION_CONFLICT') return 'This schedule changed. Reload its latest version before saving again.';
  if (error.code === 'BUDGET_EXHAUSTED') return 'The AI budget is exhausted. This run was not started.';
  if (error.code === 'DEMO_EXPIRED' || error.code === 'DEMO_DISABLED' || error.code === 'SESSION_UNAUTHENTICATED') return 'Your demo session has expired. Return to the demo entry to continue.';
  return fallback;
}
