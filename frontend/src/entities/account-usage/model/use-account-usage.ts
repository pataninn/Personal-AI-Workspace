import { useCallback, useEffect, useState } from 'react';

import { useAppSelector } from '@/app/store/hooks';
import { selectPrincipal } from '@/entities/user-session';
import { getAccountUsage } from '@/entities/account-usage/api/account-usage-api';
import type { AccountUsageState } from '@/entities/account-usage/model/types';

type Listener = (state: AccountUsageState) => void;
const listeners = new Map<string, Set<Listener>>();
const requests = new Map<string, Promise<void>>();

function refreshUsage(principalId: string): void {
  if (requests.has(principalId)) return;
  const publish = (state: AccountUsageState): void => {
    for (const listener of listeners.get(principalId) ?? []) listener(state);
  };
  publish({ status: 'loading', data: null });
  const request = getAccountUsage().then((data) => {
    publish({ status: 'success', data });
  }).catch(() => {
    publish({ status: 'error', data: null });
  }).finally(() => { requests.delete(principalId); });
  requests.set(principalId, request);
}

export function useAccountUsage(active = true): { readonly state: AccountUsageState; readonly refresh: () => void } {
  const principalId = useAppSelector(selectPrincipal)?.id ?? null;
  const [snapshot, setSnapshot] = useState<{ readonly principalId: string | null; readonly state: AccountUsageState }>({
    principalId: null, state: { status: 'loading', data: null }
  });
  const refresh = useCallback(() => {
    if (principalId && active && document.visibilityState !== 'hidden') refreshUsage(principalId);
  }, [principalId, active]);
  const state: AccountUsageState = snapshot.principalId === principalId ? snapshot.state : { status: 'loading', data: null };

  useEffect(() => {
    if (!principalId || !active) return;
    const listener: Listener = (next) => setSnapshot({ principalId, state: next });
    const subscribers = listeners.get(principalId) ?? new Set<Listener>();
    subscribers.add(listener);
    listeners.set(principalId, subscribers);
    refresh();
    const onVisible = (): void => { refresh(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) listeners.delete(principalId);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [principalId, active, refresh]);

  useEffect(() => {
    if (!principalId || !active || state.status === 'loading') return;
    const resetDelay = state.status === 'success' ? Date.parse(state.data.daily.resetAt) - Date.now() : NaN;
    const retryDelay = state.status === 'error' || !state.data.availability.canSubmit ? 30_000 : Infinity;
    const delay = Math.min(retryDelay, resetDelay > 0 ? resetDelay : Infinity);
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(refresh, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [principalId, active, state, refresh]);

  return { state, refresh };
}
