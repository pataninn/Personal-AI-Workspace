import { useEffect, useRef } from 'react';

import type { AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import { Alert, Button, Card, Spinner } from '@/shared/ui';

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
}

export function RunStatusCard({ state, conversationHref, onRetry, onRefresh }: RunStatusCardProps): React.JSX.Element | null {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { snapshot } = state;

  useEffect(() => {
    if (snapshot.status !== 'pending_approval') {
      headingRef.current?.focus();
    }
  }, [snapshot.status, state.errorCode]);

  if (snapshot.status === 'pending_approval') {
    return null;
  }

  if (snapshot.status === 'staging') {
    return (
      <div data-testid="ai-run-status-card">
        <Card className="run-status-card">
          <h3 ref={headingRef} tabIndex={-1} data-testid="run-staging">Preparing a private run environment</h3>
          <div className="run-status-live" data-testid="run-staging-status" role="status" aria-live="polite" aria-busy="true">
            <Spinner label="Preparing a private run environment" />
            <span>{snapshot.phase === 'runtime' ? 'Starting the isolated run environment…' : 'Copying approved context to a private run area…'}</span>
          </div>
          <p className="field-help">Approval was recorded. Provider inference has not been presented as started.</p>
        </Card>
      </div>
    );
  }

  if (snapshot.status === 'ready') {
    return (
      <div data-testid="ai-run-status-card">
        <Card className="run-status-card">
          <h3 ref={headingRef} tabIndex={-1} data-testid="run-ready">Private run environment ready</h3>
          <Alert tone="success" data-testid="run-ready-status" role="status" live="polite">
            <p>Your approved context is isolated for this run. The assistant can now begin working.</p>
            {state.manifest ? <p className="field-help">Provider: {state.manifest.provider}. Scope approved for this run.</p> : null}
          </Alert>
        </Card>
      </div>
    );
  }

  if (snapshot.status === 'rejected') {
    return (
      <div data-testid="ai-run-status-card">
        <Card className="run-status-card" data-testid="run-rejected">
          <h3 ref={headingRef} tabIndex={-1}>This run was not started</h3>
          <Alert tone="info" role="status" live="polite">No project content was staged or sent to NVIDIA.</Alert>
        </Card>
      </div>
    );
  }

  const reviewRequired = snapshot.status === 'review_required' || snapshot.providerTransmission === 'unknown' || snapshot.cleanup === 'unknown' || state.errorCode === 'RUN_REVIEW_REQUIRED';
  const message = reviewRequired
    ? 'The run stopped, but the app could not confirm whether cleanup or provider transmission finished. Do not retry automatically; refresh the run status before trying again.'
    : errorMessage(state.errorCode, snapshot.safeMessage, snapshot.cleanup === 'complete' && snapshot.phase === 'staging');
  return (
    <div data-testid="ai-run-status-card">
      <Card className="run-status-card" data-testid="run-error">
        <h3 ref={headingRef} tabIndex={-1}>{reviewRequired ? 'Run needs review' : 'The private run environment could not be prepared'}</h3>
        <Alert tone={reviewRequired ? 'warning' : 'error'} role="alert">{message}</Alert>
        <div className="run-status-actions">
          {reviewRequired ? <Button type="button" variant="secondary" data-testid="run-status-refresh" onClick={onRefresh}>Refresh run status</Button> : <Button type="button" variant="secondary" data-testid="run-error-retry" onClick={onRetry}>Try again</Button>}
          <a className="button button-secondary" data-testid="run-back-to-conversation" href={conversationHref}>Back to conversation</a>
        </div>
      </Card>
    </div>
  );
}

function errorMessage(errorCode: string | undefined, safeMessage: string, cleanupComplete: boolean): string {
  const cleanupNote = cleanupComplete ? ' Any partial staging data was removed.' : '';
  if (errorCode === 'RUNTIME_UNAVAILABLE') {
    return `The local sandbox gateway is unavailable. Nothing was staged or sent to NVIDIA. Check the local app services, then try again.${cleanupNote}`;
  }
  if (errorCode === 'NIM_UNAVAILABLE') {
    return `NVIDIA NIM is not ready through the local gateway. Nothing was sent to NVIDIA. Try again after provider setup is available.${cleanupNote}`;
  }
  if (errorCode === 'STAGING_FAILED') {
    return `We could not prepare the private run environment. No provider call was started.${cleanupNote}`;
  }
  if (safeMessage.startsWith('The local sandbox gateway is unavailable.')) {
    return `The local sandbox gateway is unavailable. Nothing was staged or sent to NVIDIA. Check the local app services, then try again.${cleanupNote}`;
  }
  if (safeMessage.startsWith('NVIDIA NIM is not ready through the local gateway.')) {
    return `NVIDIA NIM is not ready through the local gateway. Nothing was sent to NVIDIA. Try again after provider setup is available.${cleanupNote}`;
  }
  return `We could not prepare the private run environment. No provider call was started.${cleanupNote}`;
}
