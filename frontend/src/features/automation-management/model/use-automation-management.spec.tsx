import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
