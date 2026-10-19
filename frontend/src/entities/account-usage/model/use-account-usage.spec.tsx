import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import type { AccountUsageSnapshot } from '@/entities/account-usage/model/types';
import { useAccountUsage } from '@/entities/account-usage/model/use-account-usage';

const api = vi.hoisted(() => ({ getAccountUsage: vi.fn() }));
vi.mock('@/entities/account-usage/api/account-usage-api', () => api);

const OWNER_ONE = '11111111-1111-4111-8111-111111111111';
const OWNER_TWO = '22222222-2222-4222-8222-222222222222';

function usageSnapshot(owner: string): AccountUsageSnapshot {
  return {
    asOf: '2026-10-19T00:00:00.000Z', expiresAt: null,
    daily: { limitUnits: '100', settledUnits: owner === OWNER_ONE ? '10' : '20', reservedUnits: '0', remainingUnits: owner === OWNER_ONE ? '90' : '80', resetAt: '2026-10-20T00:00:00.000Z', timeZone: 'UTC' },
    lifetime: { limitUnits: null, settledUnits: '10', reservedUnits: '0', remainingUnits: null },
    storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '0', reservedBytes: '0', limitBytes: null, availableBytes: null, overLimit: false, asOf: '2026-10-19T00:00:00.000Z' },
    availability: { status: 'available', reason: null, canSubmit: true }
  };
}

function createStore() {
  return configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: {
    status: 'authenticated' as const,
    principal: { id: OWNER_ONE, displayName: 'Owner one', accountKind: 'regular' as const, role: 'user' as const },
    csrfToken: 'csrf', expiresAt: null, errorCode: null
  } } });
}

describe('useAccountUsage', () => {
  beforeEach(() => api.getAccountUsage.mockReset());

  it('does not expose the prior owner snapshot while the new owner usage is loading', async () => {
    let finishFirst!: (value: AccountUsageSnapshot) => void;
    let finishSecond!: (value: AccountUsageSnapshot) => void;
    api.getAccountUsage.mockReturnValueOnce(new Promise<AccountUsageSnapshot>((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise<AccountUsageSnapshot>((resolve) => { finishSecond = resolve; }));
    const store = createStore();
    const wrapper = ({ children }: { readonly children: ReactNode }): React.JSX.Element => <Provider store={store}>{children}</Provider>;
    const { result } = renderHook(() => useAccountUsage(), { wrapper });
    await waitFor(() => expect(api.getAccountUsage).toHaveBeenCalledTimes(1));
    await act(async () => { finishFirst(usageSnapshot(OWNER_ONE)); });
    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(result.current.state.status === 'success' && result.current.state.data.daily.settledUnits).toBe('10');

    act(() => store.dispatch(sessionAuthenticated({
      principal: { id: OWNER_TWO, displayName: 'Owner two', accountKind: 'regular', role: 'user' },
      csrfToken: 'csrf-two', expiresAt: '2027-01-01T00:00:00.000Z'
    })));
    expect(result.current.state).toEqual({ status: 'loading', data: null });
    await waitFor(() => expect(api.getAccountUsage).toHaveBeenCalledTimes(2));
    await act(async () => { finishSecond(usageSnapshot(OWNER_TWO)); });

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(result.current.state.status === 'success' && result.current.state.data.daily.settledUnits).toBe('20');
  });
});
