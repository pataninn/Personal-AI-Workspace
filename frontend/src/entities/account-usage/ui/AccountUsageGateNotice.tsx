import { Link } from 'react-router-dom';

import type { AccountUsageState } from '@/entities/account-usage/model/types';
import { Alert } from '@/shared/ui';

interface AccountUsageGateNoticeProps {
  readonly state: AccountUsageState;
}

export function AccountUsageGateNotice({ state }: AccountUsageGateNoticeProps): React.JSX.Element | null {
  if (state.status === 'success' && state.data.availability.canSubmit) return null;
  const message = state.status === 'success'
    ? state.data.availability.reason ?? 'AI submissions are unavailable.'
    : 'AI availability could not be checked. Sending stays paused until your allowance is available.';
  const tone = state.status === 'success' && state.data.availability.status !== 'unknown' ? 'info' : 'warning';
  return <Alert tone={tone} data-testid="account-usage-gate" role="status">
    <span>{message}</span>{' '}<Link className="text-[var(--color-link)] underline underline-offset-4" to="/usage">View usage</Link>
  </Alert>;
}
