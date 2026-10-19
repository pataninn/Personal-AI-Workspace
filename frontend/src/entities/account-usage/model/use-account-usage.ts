import { useCallback, useEffect, useState } from 'react';

import { useAppSelector } from '@/app/store/hooks';
import { selectPrincipal } from '@/entities/user-session';
import { getAccountUsage } from '@/entities/account-usage/api/account-usage-api';
import type { AccountUsageState } from '@/entities/account-usage/model/types';

export function useAccountUsage(): { readonly state: AccountUsageState; readonly refresh: () => void } {
  const principal = useAppSelector(selectPrincipal);
  const [refreshKey, setRefreshKey] = useState(0);
  const [snapshot, setSnapshot] = useState<{ readonly principalId: string | null; readonly state: AccountUsageState }>({
    principalId: null, state: { status: 'loading', data: null }
  });
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!principal) { setSnapshot({ principalId: null, state: { status: 'error', data: null } }); return; }
    let active = true;
    setSnapshot({ principalId: principal.id, state: { status: 'loading', data: null } });
    void getAccountUsage().then((data) => {
      if (active) setSnapshot({ principalId: principal.id, state: { status: 'success', data } });
    }).catch(() => {
      if (active) setSnapshot({ principalId: principal.id, state: { status: 'error', data: null } });
    });
    return () => { active = false; };
  }, [principal?.id, refreshKey]);

  return { state: snapshot.principalId === (principal?.id ?? null) ? snapshot.state : { status: 'loading', data: null }, refresh };
}
