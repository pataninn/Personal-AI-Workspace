import { useEffect, useRef } from 'react';

import type { AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import { Alert, Button, Card } from '@/shared/ui';

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
    if (snapshot.status !== 'pending_approval') headingRef.current?.focus();
  }, [snapshot.status, state.errorCode]);

  if (snapshot.status === 'pending_approval') return null;

  if (snapshot.status === 'ready') {
    return <div data-testid="ai-run-status-card"><Card className="run-status-card">
      <h3 ref={headingRef} tabIndex={-1} data-testid="run-ready">Provider access approved</h3>
      <Alert tone="success" data-testid="run-ready-status" role="status" live="polite">
        <p>The approved context is ready for a server-side NVIDIA NIM request. The authoritative project workspace is unchanged.</p>
        {state.manifest ? <p className="field-help">Provider: {state.manifest.provider}. Model: {formatModel(state.manifest.model)}. Selected files: {state.manifest.itemCount}. Recent messages: {state.manifest.messageCount}.</p> : null}
      </Alert>
    </Card></div>;
  }

  if (snapshot.status === 'staging') {
    return <div data-testid="ai-run-status-card"><Card className="run-status-card" data-testid="run-staging">
      <h3 ref={headingRef} tabIndex={-1}>Preparing the approved context</h3>
      <Alert tone="info" role="status"><p>The selected context is being prepared locally. Refresh checks the saved status and does not restart the run.</p></Alert>
      <Button type="button" variant="secondary" data-testid="run-staging-refresh" onClick={onRefresh}>Refresh run status</Button>
    </Card></div>;
  }

  if (snapshot.status !== 'rejected' && (snapshot.status !== 'failed' || snapshot.phase !== 'staging')) {
    return null;
  }

  if (snapshot.status === 'rejected') {
    return <div data-testid="ai-run-status-card"><Card className="run-status-card" data-testid="run-rejected">
      <h3 ref={headingRef} tabIndex={-1}>This run was not started</h3>
      <Alert tone="info" role="status" live="polite">No project content was sent to NVIDIA.</Alert>
    </Card></div>;
  }

  const reviewRequired = snapshot.providerTransmission === 'unknown' || state.errorCode === 'RUN_REVIEW_REQUIRED';
  const message = reviewRequired ? 'The app could not confirm whether the provider request finished. Do not retry automatically; refresh the run status before trying again.' : errorMessage(state.errorCode, snapshot.safeMessage);
  return <div data-testid="ai-run-status-card"><Card className="run-status-card" data-testid="run-error">
    <h3 ref={headingRef} tabIndex={-1} data-testid="run-provider-failed">{reviewRequired ? 'Run needs review' : 'NVIDIA NIM could not start this request'}</h3>
    <Alert tone={reviewRequired ? 'warning' : 'error'} role="alert">{message}</Alert>
    <div className="run-status-actions">{reviewRequired ? <Button type="button" variant="secondary" data-testid="run-status-refresh" onClick={onRefresh}>Refresh run status</Button> : <Button type="button" variant="secondary" data-testid="run-error-retry" onClick={onRetry}>Try again</Button>}<a className="button button-secondary" data-testid="run-back-to-conversation" href={conversationHref}>Back to conversation</a></div>
  </Card></div>;
}

function errorMessage(errorCode: string | undefined, safeMessage: string): string {
  if (errorCode === 'EGRESS_SOURCE_CHANGED') return 'The approved project context changed before NVIDIA NIM started. Review a fresh provider disclosure before trying again. No file changes were made.';
  if (errorCode === 'RUNTIME_UNAVAILABLE' || errorCode === 'NIM_UNAVAILABLE') return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
  if (errorCode === 'STAGING_FAILED') return 'The approved context could not be prepared for NVIDIA NIM. No provider request was started. No file changes were made.';
  if (safeMessage.startsWith('The local sandbox gateway is unavailable.') || safeMessage.startsWith('NVIDIA NIM is not ready')) return 'NVIDIA NIM is unavailable. No provider request was started. No file changes were made. Try again when provider setup is available.';
  if (safeMessage.length > 0) return `${safeMessage} No file changes were made.`;
  return 'NVIDIA NIM could not complete this request. No file changes were made.';
}

function formatModel(model: string): string {
  return model === 'nvidia/nemotron-3-super-120b-a12b' ? 'Nemotron 3 Super 120B' : model;
}
