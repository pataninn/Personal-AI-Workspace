import { useEffect, useRef } from 'react';

import type { AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { Alert, Button, Card, Spinner } from '@/shared/ui';

import { useAiRunTimeline } from '@/features/ai-run/model/use-ai-run-timeline';

interface AiRunTimelineProps {
  readonly snapshot: AiRunSnapshot;
  readonly manifest?: EgressManifest | null;
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly disabled?: boolean;
  readonly onSnapshotChange?: (snapshot: AiRunSnapshot) => void;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

const DIRECT_PROVIDER_NOTICE = 'The direct NVIDIA NIM request is server-side. The authoritative project workspace is unchanged.';

export function AiRunTimeline({ snapshot, manifest = null, projectId, conversationId, csrfToken, disabled = false, onSnapshotChange, onConversationReconciled }: AiRunTimelineProps): React.JSX.Element {
  const timeline = useAiRunTimeline({
    snapshot,
    projectId,
    conversationId,
    csrfToken,
    enabled: !disabled && snapshot.decision === 'approved' && snapshot.status !== 'rejected',
    onSnapshotChange,
    onConversationReconciled
  });
  const terminal = ['succeeded', 'failed', 'blocked', 'cancelled', 'review_required', 'rejected'].includes(timeline.snapshot.status);
  const reviewRequired = timeline.snapshot.status === 'review_required' || (timeline.connection === 'error' && timeline.snapshot.providerTransmission === 'unknown');
  const statusText = statusLabel(timeline.snapshot.status, timeline.connection);
  const partialResponse = timeline.assistantText.length > 0 && ['failed', 'blocked', 'cancelled', 'review_required'].includes(timeline.snapshot.status);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousRef = useRef({ status: timeline.snapshot.status, connection: timeline.connection, terminal });

  useEffect(() => {
    const previous = previousRef.current;
    const enteredActive = previous.status === 'ready' && ['queued', 'running', 'waiting_approval', 'cancel_requested'].includes(timeline.snapshot.status);
    const reachedTerminal = terminal && (!previous.terminal || timeline.connection === 'complete' && previous.connection !== 'complete');
    if (enteredActive || reachedTerminal) {
      headingRef.current?.focus();
    }
    previousRef.current = { status: timeline.snapshot.status, connection: timeline.connection, terminal };
  }, [terminal, timeline.connection, timeline.snapshot.status]);

  return (
    <section className="ai-run-timeline" data-testid="ai-run-timeline" aria-labelledby="ai-run-timeline-heading">
      <Card className="ai-run-timeline-card">
        <h3 ref={headingRef} id="ai-run-timeline-heading" data-testid="ai-run-timeline-heading" tabIndex={-1}>{terminalHeading(timeline.snapshot.status, reviewRequired)}</h3>
        <Alert tone="info" data-testid="ai-run-provider-notice"><p>{DIRECT_PROVIDER_NOTICE}</p>{manifest ? <p className="field-help">Provider: {manifest.provider}. Model: {formatModel(manifest.model)}. Selected files: {manifest.itemCount}. Recent messages: {manifest.messageCount}.</p> : null}</Alert>
        <div
          className="ai-run-timeline-status"
          data-testid="ai-run-timeline-status"
          aria-label="Run status"
          role={timeline.connection === 'disconnected' ? undefined : 'status'}
          aria-live={timeline.connection === 'disconnected' ? undefined : 'polite'}
          aria-busy={!terminal && timeline.connection !== 'disconnected'}
        >
          {!terminal && timeline.connection !== 'disconnected' && timeline.connection !== 'error' ? <Spinner label={statusText} /> : null}
          {timeline.connection !== 'disconnected' ? <span data-testid="run-connection-status">{statusText}</span> : null}
        </div>
        {timeline.assistantText ? <article className="ai-run-assistant-output" data-testid="ai-run-assistant-output" aria-labelledby="ai-run-assistant-heading"><h4 id="ai-run-assistant-heading">Assistant response</h4>{partialResponse ? <p className="field-help" data-testid="assistant-stream-partial">Incomplete response</p> : null}<p data-testid="assistant-stream">{timeline.assistantText}</p></article> : null}
        {!timeline.assistantText && ['ready', 'queued', 'running', 'waiting_approval'].includes(timeline.snapshot.status) ? <p className="field-help" data-testid="assistant-stream-empty">Waiting for the assistant...</p> : null}
        {!timeline.assistantText && timeline.snapshot.status === 'succeeded' ? <p className="field-help" data-testid="ai-run-empty-response">The assistant completed without a message.</p> : null}
        {timeline.snapshot.status === 'succeeded' ? <p className="field-help" data-testid="run-completed">Run complete. Any proposed file changes need a separate review before they can be applied.</p> : null}
        {timeline.snapshot.status === 'cancelled' ? <Alert tone="info" data-testid="run-cancelled" role="status"><p>Run cancelled. No further assistant work will be applied.</p>{partialResponse ? <p>Incomplete response.</p> : null}</Alert> : null}
        {timeline.snapshot.status === 'failed' ? <Alert tone="error" data-testid="run-failed" role="alert"><p>The assistant could not complete this run.</p>{partialResponse ? <p>Incomplete response.</p> : null}</Alert> : null}
        {timeline.snapshot.status === 'blocked' ? <Alert tone="error" data-testid="run-blocked" role="alert"><p>Run blocked by policy. This run was not completed.</p></Alert> : null}
        {timeline.snapshot.status === 'review_required' ? <Alert tone="warning" role="alert" data-testid="ai-run-review-required"><p>The run needs manual review. Refresh run status before trying again.</p><Button type="button" variant="secondary" data-testid="ai-run-review-refresh" onClick={timeline.refresh}>Refresh run status</Button></Alert> : null}
        {timeline.connection === 'disconnected' ? <Alert tone="warning" role="alert" data-testid="ai-run-disconnected"><p>Live updates disconnected. The saved run and conversation were refetched; no event replay was attempted.</p><Button type="button" variant="secondary" data-testid="ai-run-disconnected-refresh" onClick={timeline.refresh}>Refresh run status</Button></Alert> : null}
        {timeline.cancelError ? <Alert tone="error" role="alert" data-testid="run-cancel-error"><p>{timeline.cancelError}</p><Button type="button" variant="secondary" data-testid="run-cancel-error-refresh" onClick={timeline.refresh}>Refresh run status</Button></Alert> : null}
        {timeline.error && timeline.connection !== 'disconnected' && timeline.snapshot.status !== 'review_required' ? <Alert tone="error" role="alert" data-testid="ai-run-timeline-error">{timeline.error}</Alert> : null}
        {!terminal && timeline.snapshot.status !== 'cancel_requested' ? <Button type="button" variant="secondary" data-testid="ai-run-cancel" disabled={timeline.cancelPending || disabled || !csrfToken} aria-busy={timeline.cancelPending} onClick={timeline.cancel}>{timeline.cancelPending ? 'Stopping assistant run...' : 'Cancel run'}</Button> : null}
        {timeline.snapshot.status === 'cancel_requested' ? <p data-testid="ai-run-cancel-status" role="status">Stopping assistant run...</p> : null}
      </Card>
    </section>
  );
}

function statusLabel(status: AiRunSnapshot['status'], connection: ReturnType<typeof useAiRunTimeline>['connection']): string {
  if (connection === 'starting') {
    return 'Sending approved context to NVIDIA NIM...';
  }
  if (connection === 'connecting') {
    return 'Connecting to live run updates...';
  }
  if (connection === 'disconnected') {
    return 'Live updates disconnected; checking the saved run...';
  }
  if (status === 'queued') {
    return 'The assistant run is queued.';
  }
  if (status === 'running') {
    return 'Assistant is working...';
  }
  if (status === 'waiting_approval') {
    return 'The assistant is waiting for a provider update.';
  }
  if (status === 'cancel_requested') {
    return 'Stopping assistant run...';
  }
  if (status === 'succeeded') {
    return 'Assistant response complete.';
  }
  if (status === 'cancelled') {
    return 'Run cancelled. No further assistant work will be applied.';
  }
  if (status === 'blocked') {
    return 'Run blocked by policy. This run was not completed.';
  }
  if (status === 'failed') {
    return 'The assistant could not complete this run.';
  }
  if (status === 'review_required') {
    return 'The run needs manual review.';
  }
  if (status === 'ready') {
    return 'Sending approved context to NVIDIA NIM...';
  }
  return 'The assistant run is ready to start.';
}

function terminalHeading(status: AiRunSnapshot['status'], reviewRequired: boolean): string {
  if (reviewRequired) {
    return 'Run needs review';
  }
  if (status === 'succeeded') {
    return 'Run complete';
  }
  if (status === 'cancelled') {
    return 'Run cancelled';
  }
  if (status === 'blocked') {
    return 'Run blocked by policy';
  }
  if (status === 'failed') {
    return 'The assistant could not complete this run';
  }
  return 'Assistant run';
}

function formatModel(model: string): string {
  return model === 'nvidia/nemotron-3-super-120b-a12b' ? 'Nemotron 3 Super 120B' : model;
}
