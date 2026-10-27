import { TypingIndicator } from '@/shared/ui';
import type { AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';

export interface AssistantPolicySummaryProps {
  readonly status: 'loading' | 'error' | 'loaded';
  readonly policy: AssistantExecutionPolicyStatus | null;
  readonly compact?: boolean;
}

/** Only interrupt the conversation when the assistant needs attention. */
export function AssistantPolicySummary({ status, policy }: AssistantPolicySummaryProps): React.JSX.Element | null {
  if (status === 'loaded' && policy?.readiness.state === 'ready' && policy.policy?.enabled) return null;
  if (status === 'loading') return <TypingIndicator testId="assistant-policy-readiness" />;
  const message = status === 'error' ? 'Unable to connect. Try again.'
      : !policy?.policy?.enabled || policy.readiness.state === 'blocked' ? 'Assistant is currently unavailable.'
        : 'Assistant is temporarily unavailable. Try again shortly.';
  return <p className="m-0 text-sm text-[var(--color-text-muted)]" role="status" aria-live="polite" data-testid="assistant-policy-readiness">{message}</p>;
}
