import { useEffect, useRef } from 'react';

import type { AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import { Alert, Button, Card, TypingIndicator } from '@/shared/ui';

export interface RunStatusState {
  readonly snapshot: AiRunSnapshot;
  readonly manifest: EgressManifest | null;
  readonly errorCode?: string;
}

interface RunStatusCardProps {
  readonly state: RunStatusState;
  readonly conversationHref: string;
  readonly onRetry: () => void;
  readonly onRefresh: () => void;
  readonly retryDisabled?: boolean;
}

export function RunStatusCard({ state, conversationHref, onRetry, onRefresh, retryDisabled = false }: RunStatusCardProps): React.JSX.Element | null {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { snapshot } = state;
  useEffect(() => {
    if (['failed', 'rejected'].includes(snapshot.status)) headingRef.current?.focus();
  }, [snapshot.status, state.errorCode]);
  if (snapshot.status === 'pending_approval') return null;
  if (snapshot.status === 'ready' || snapshot.status === 'staging') return <div data-testid="ai-run-status-card"><div data-testid={snapshot.status === 'staging' ? 'run-staging' : 'run-ready'}><TypingIndicator /></div></div>;
  if (snapshot.status === 'rejected') return <p role="status" data-testid="run-rejected">Request cancelled.</p>;
  if (snapshot.status !== 'failed' || snapshot.phase !== 'staging') return null;
  const needsCheck = snapshot.providerTransmission === 'unknown' || state.errorCode === 'RUN_REVIEW_REQUIRED';
  return <div data-testid="ai-run-status-card"><Card className="run-status-card" data-testid="run-error">
    <h3 ref={headingRef} tabIndex={-1} data-testid="run-provider-failed">Unable to continue</h3>
    <Alert tone={needsCheck ? 'warning' : 'error'} role="alert">{needsCheck ? 'Check this request before trying again.' : 'Could not start this request. Please try again.'}</Alert>
    <div className="run-status-actions">{needsCheck ? <Button type="button" variant="secondary" data-testid="run-status-refresh" onClick={onRefresh}>Check status</Button> : <Button type="button" variant="secondary" data-testid="run-error-retry" disabled={retryDisabled} onClick={onRetry}>Try again</Button>}<a className="button button-secondary" data-testid="run-back-to-conversation" href={conversationHref}>Back to chat</a></div>
  </Card></div>;
}
