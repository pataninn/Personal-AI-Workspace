import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationOccurrence, AutomationSchedule } from '@/entities/automation';
import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { useAutomationManagement } from '@/features/automation-management';

const api = vi.hoisted(() => ({
  createAutomationSchedule: vi.fn(), listAutomationOccurrences: vi.fn(), listAutomationSchedules: vi.fn(),
  runAutomationNow: vi.fn(), updateAutomationSchedule: vi.fn()
}));

vi.mock('@/entities/automation', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/automation')>(), ...api }));
vi.mock('@/shared/lib/idempotency-key', () => ({ createIdempotencyKey: () => 'automation-run-key-1' }));

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE: AutomationSchedule = {
  id: SCHEDULE_ID, workspaceId: '22222222-2222-4222-8222-222222222222', conversationId: '33333333-3333-4333-8333-333333333333',
  skillId: '44444444-4444-4444-8444-444444444444', skillVersion: 2, localTime: '08:30', timeZone: 'Asia/Shanghai',
  enabled: true, revision: 3, nextDueAt: '2026-10-21T00:30:00.000Z', lastRunStatus: null,
  createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z'
};
const QUEUED_OCCURRENCE: AutomationOccurrence = {
  id: '55555555-5555-4555-8555-555555555555', kind: 'manual', intendedFor: '2026-10-20T08:30:00.000Z', status: 'queued',
  scheduleRevision: 3, skillVersion: 2, homeTurnId: null, failureCode: null, attemptCount: 0, taskSources: [],
  providerUsage: { state: 'not_started', calls: [] }, createdAt: '2026-10-20T08:30:00.000Z', updatedAt: '2026-10-20T08:30:00.000Z'
};

function wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: { userSession: {
      status: 'authenticated' as const,
      principal: { id: 'owner', displayName: 'Owner', accountKind: 'regular' as const, role: 'user' as const },
      csrfToken: 'preview-csrf', expiresAt: null, errorCode: null
    } }
  });
  return <Provider store={store}>{children}</Provider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listAutomationSchedules.mockResolvedValue([SCHEDULE]);
  api.listAutomationOccurrences.mockResolvedValue({ occurrences: [], nextCursor: null });
  api.runAutomationNow.mockResolvedValue(QUEUED_OCCURRENCE);
});

describe('useAutomationManagement run reconciliation', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('continues polling long runs after the backoff reaches thirty seconds and stops on completion', async () => {
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [QUEUED_OCCURRENCE], nextCursor: null });
    const { result, unmount } = renderHook(() => useAutomationManagement(), { wrapper });
    await waitFor(() => expect(result.current.histories[SCHEDULE_ID]?.status).toBe('success'));
    vi.useFakeTimers();
    // Begin a new polling effect under fake timers.
    act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    const initialCalls = api.listAutomationOccurrences.mock.calls.length;
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    expect(api.listAutomationOccurrences).toHaveBeenCalledTimes(initialCalls + 5);
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const completedCalls = api.listAutomationOccurrences.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(api.listAutomationOccurrences).toHaveBeenCalledTimes(completedCalls + 3);
    unmount();
  });

  it('discovers a future scheduled result and stops discovery while hidden or unmounted', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAutomationManagement(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.histories[SCHEDULE_ID]?.occurrences).toEqual([]);
    const updated = { ...SCHEDULE, nextDueAt: '2026-10-22T00:30:00.000Z', lastRunStatus: 'succeeded' as const };
    api.listAutomationSchedules.mockResolvedValue([updated]);
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.readyNotice?.occurrence.status).toBe('succeeded');
    expect(result.current.schedules[0]).toEqual(updated);
    expect(result.current.readyNotice?.schedule).toEqual(updated);
    const calls = api.listAutomationOccurrences.mock.calls.length;
    act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(api.listAutomationOccurrences).toHaveBeenCalledTimes(calls);
    unmount();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(api.listAutomationOccurrences).toHaveBeenCalledTimes(calls);
  });

  it('refreshes authoritative schedule metadata once for a batch of changed histories', async () => {
    const second = { ...SCHEDULE, id: '77777777-7777-4777-8777-777777777777' };
    api.listAutomationSchedules.mockResolvedValue([SCHEDULE, second]);
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAutomationManagement(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    api.listAutomationSchedules.mockResolvedValue([SCHEDULE, second].map((schedule) => ({ ...schedule, lastRunStatus: 'succeeded' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.listAutomationSchedules).toHaveBeenCalledTimes(2);
    expect(result.current.schedules.every((schedule) => schedule.lastRunStatus === 'succeeded')).toBe(true);
    unmount();
  });

  it('reconciles first-load history newer than the initial schedule snapshot', async () => {
    const updated = { ...SCHEDULE, nextDueAt: '2026-10-22T00:30:00.000Z', lastRunStatus: 'succeeded' as const };
    api.listAutomationSchedules.mockResolvedValueOnce([SCHEDULE]).mockResolvedValue([updated]);
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    const { result } = renderHook(() => useAutomationManagement(), { wrapper });
    await waitFor(() => expect(result.current.schedules[0]).toEqual(updated));
    expect(api.listAutomationSchedules).toHaveBeenCalledTimes(2);
    expect(result.current.readyNotice).toBeNull();
  });

  it('retries failed metadata reads without hiding successful history', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAutomationManagement(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    api.listAutomationSchedules.mockRejectedValueOnce(new Error('Temporary summary failure'))
      .mockResolvedValue([{ ...SCHEDULE, lastRunStatus: 'succeeded' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.histories[SCHEDULE_ID]?.status).toBe('success');
    expect(result.current.schedules[0]?.lastRunStatus).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.schedules[0]?.lastRunStatus).toBe('succeeded');
    unmount();
  });

  it('does not let a delayed metadata read replace a completed schedule edit', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAutomationManagement(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let resolveOld: (schedules: AutomationSchedule[]) => void = () => { throw new Error('Request not started'); };
    const updated = { ...SCHEDULE, revision: 4, localTime: '09:30', updatedAt: '2026-10-21T01:00:00.000Z' };
    api.listAutomationSchedules.mockReturnValueOnce(new Promise<AutomationSchedule[]>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue([updated]);
    api.listAutomationOccurrences.mockResolvedValue({ occurrences: [{ ...QUEUED_OCCURRENCE, status: 'succeeded' }], nextCursor: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    api.updateAutomationSchedule.mockResolvedValue(updated);
    await act(async () => { await result.current.update(SCHEDULE_ID, { expectedRevision: 3, localTime: '09:30' }); });
    await act(async () => { resolveOld([SCHEDULE]); });
    expect(result.current.schedules[0]).toEqual(updated);
    unmount();
  });

  it('does not poll disabled schedules with settled history', async () => {
    api.listAutomationSchedules.mockResolvedValue([{ ...SCHEDULE, enabled: false }]);
    vi.useFakeTimers();
    renderHook(() => useAutomationManagement(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(api.listAutomationOccurrences).toHaveBeenCalledTimes(1);
  });

  it('keeps an acknowledged run visible when the immediate history read has not caught up and prevents a second run', async () => {
    let finishRun: ((occurrence: AutomationOccurrence) => void) | undefined;
    api.runAutomationNow.mockReturnValueOnce(new Promise<AutomationOccurrence>((resolve) => { finishRun = resolve; }));
    const { result } = renderHook(() => useAutomationManagement(), { wrapper });
    await waitFor(() => expect(result.current.histories[SCHEDULE_ID]?.status).toBe('success'));

    let firstRun: Promise<void> | undefined;
    act(() => {
      firstRun = result.current.run(SCHEDULE_ID);
      void result.current.run(SCHEDULE_ID);
    });
    await waitFor(() => expect(api.runAutomationNow).toHaveBeenCalledTimes(1));
    await act(async () => { finishRun?.(QUEUED_OCCURRENCE); await firstRun; });

    expect(api.runAutomationNow).toHaveBeenCalledWith(SCHEDULE_ID, 'preview-csrf', 'automation-run-key-1');
    expect(result.current.histories[SCHEDULE_ID]?.occurrences).toEqual([QUEUED_OCCURRENCE]);
    expect(result.current.runStates[SCHEDULE_ID]?.status).toBe('queued');
    await act(async () => { await result.current.run(SCHEDULE_ID); });
    expect(api.runAutomationNow).toHaveBeenCalledTimes(1);
  });

  it('retries an uncertain Run now with its exact idempotency key', async () => {
    api.runAutomationNow.mockRejectedValueOnce(new TypeError('network disconnected'));
    const { result } = renderHook(() => useAutomationManagement(), { wrapper });
    await waitFor(() => expect(result.current.histories[SCHEDULE_ID]?.status).toBe('success'));

    await act(async () => { await result.current.run(SCHEDULE_ID); });
    expect(result.current.runStates[SCHEDULE_ID]?.status).toBe('uncertain');
    await act(async () => { await result.current.retryRun(SCHEDULE_ID); });

    expect(api.runAutomationNow.mock.calls).toEqual([
      [SCHEDULE_ID, 'preview-csrf', 'automation-run-key-1'],
      [SCHEDULE_ID, 'preview-csrf', 'automation-run-key-1']
    ]);
    expect(result.current.histories[SCHEDULE_ID]?.occurrences).toEqual([QUEUED_OCCURRENCE]);
  });

  it('blocks on SCHEDULE_BUSY until a later history read is clean', async () => {
    api.runAutomationNow.mockRejectedValueOnce(new ApiClientError(409, 'SCHEDULE_BUSY', 'Busy'));
    const { result } = renderHook(() => useAutomationManagement(), { wrapper });
    await waitFor(() => expect(result.current.histories[SCHEDULE_ID]?.status).toBe('success'));

    await act(async () => { await result.current.run(SCHEDULE_ID); });
    expect(result.current.runStates[SCHEDULE_ID]?.status).toBe('blocked');
    await act(async () => { await result.current.run(SCHEDULE_ID); });
    expect(api.runAutomationNow).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.refreshHistory(SCHEDULE_ID); });
    await waitFor(() => expect(result.current.runStates[SCHEDULE_ID]?.status).toBe('idle'));
    await act(async () => { await result.current.run(SCHEDULE_ID); });
    expect(api.runAutomationNow).toHaveBeenCalledTimes(2);
  });
});
