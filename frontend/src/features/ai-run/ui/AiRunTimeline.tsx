import { useEffect, useRef } from 'react';

import type { AiRunSnapshot } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { Alert, Button, Card, Spinner } from '@/shared/ui';

import { useAiRunTimeline } from '@/features/ai-run/model/use-ai-run-timeline';

interface AiRunTimelineProps {
  readonly snapshot: AiRunSnapshot;
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly disabled?: boolean;
  readonly onSnapshotChange?: (snapshot: AiRunSnapshot) => void;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

const FAKE_RUNTIME_NOTICE = 'Development preview - fake runtime. This response is simulated; no live OpenShell, Hermes, or NVIDIA NIM inference ran.';
const RUN_BOUNDARY_NOTICE = 'The assistant is working inside the private run environment. The authoritative project workspace is unchanged.';

export function AiRunTimeline({ snapshot, projectId, conversationId, csrfToken, disabled = false, onSnapshotChange, onConversationReconciled }: AiRunTimelineProps): React.JSX.Element {
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
  const reviewRequired = timeline.snapshot.status === 'review_required' || timeline.connection === 'error';
  const statusText = statusLabel(timeline.snapshot.status, timeline.connection);
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
        <h3 ref={headingRef} id="ai-run-timeline-heading" data-testid="ai-run-timeline-heading" tabIndex={-1}>{terminal ? (reviewRequired ? 'Run needs review' : 'Assistant run complete') : 'Assistant run'}</h3>
        <p className="field-help" data-testid="ai-run-fake-runtime-notice">{FAKE_RUNTIME_NOTICE}</p>
        <Alert tone="info" data-testid="ai-run-boundary-notice"><p>{RUN_BOUNDARY_NOTICE}</p></Alert>
        <div
          className="ai-run-timeline-status"
          data-testid="ai-run-timeline-status"
          role={timeline.connection === 'disconnected' ? undefined : 'status'}
          aria-live={timeline.connection === 'disconnected' ? undefined : 'polite'}
          aria-busy={!terminal && timeline.connection !== 'disconnected'}
        >
          {!terminal && timeline.connection !== 'disconnected' && timeline.connection !== 'error' ? <Spinner label={statusText} /> : null}
          {timeline.connection !== 'disconnected' ? <span>{statusText}</span> : null}
        </div>
        {timeline.assistantText ? <div className="ai-run-assistant-output" data-testid="ai-run-assistant-output"><p>{timeline.assistantText}</p></div> : null}
        {!timeline.assistantText && timeline.snapshot.status === 'succeeded' ? <p className="field-help" data-testid="ai-run-empty-response">The assistant completed without a message.</p> : null}
        {timeline.snapshot.status === 'review_required' ? <Alert tone="warning" role="alert" data-testid="ai-run-review-required"><p>The run needs manual review. Refresh run status before trying again.</p><Button type="button" variant="secondary" data-testid="ai-run-review-refresh" onClick={timeline.refresh}>Refresh run status</Button></Alert> : null}
        {timeline.connection === 'disconnected' ? <Alert tone="warning" role="alert" data-testid="ai-run-disconnected"><p>Live updates disconnected. The saved run and conversation were refetched; no event replay was attempted.</p><Button type="button" variant="secondary" data-testid="ai-run-disconnected-refresh" onClick={timeline.refresh}>Refresh run status</Button></Alert> : null}
        {timeline.error && timeline.connection !== 'disconnected' && timeline.snapshot.status !== 'review_required' ? <Alert tone="error" role="alert" data-testid="ai-run-timeline-error">{timeline.error}</Alert> : null}
        {!terminal && timeline.snapshot.status !== 'cancel_requested' ? <Button type="button" variant="secondary" data-testid="ai-run-cancel" disabled={timeline.cancelPending || disabled || !csrfToken} aria-busy={timeline.cancelPending} onClick={timeline.cancel}>{timeline.cancelPending ? 'Stopping assistant run...' : 'Stop assistant run'}</Button> : null}
        {timeline.snapshot.status === 'cancel_requested' ? <p data-testid="ai-run-cancel-status" role="status">Stopping assistant run...</p> : null}
      </Card>
    </section>
  );
}

function statusLabel(status: AiRunSnapshot['status'], connection: ReturnType<typeof useAiRunTimeline>['connection']): string {
  if (connection === 'starting') {
    return 'Starting the assistant in the private run environment...';
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
    return 'The assistant is working in the private run environment.';
  }
  if (status === 'waiting_approval') {
    return 'The assistant is waiting for a sandbox command decision.';
  }
  if (status === 'cancel_requested') {
    return 'Stopping assistant run...';
  }
  if (status === 'succeeded') {
    return 'Assistant response saved.';
  }
  if (status === 'cancelled') {
    return 'Assistant run cancelled. No response was promoted.';
  }
  if (status === 'blocked') {
    return 'Run blocked by local policy. No response was promoted.';
  }
  if (status === 'failed') {
    return 'The assistant could not complete this run.';
  }
  if (status === 'review_required') {
    return 'The run needs manual review.';
  }
  return 'The assistant run is ready to start.';
}
