import { useEffect, useRef, useState } from 'react';

import type { AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { Alert, Button, Card, Icon, MarkdownContent, Spinner } from '@/shared/ui';

import { useAiRunTimeline } from '@/features/ai-run/model/use-ai-run-timeline';
import { CommandExecutionSurface } from '@/features/ai-run/ui/CommandExecutionSurface';
import { HermesToolActivity } from '@/features/ai-run/ui/HermesToolActivity';

interface AiRunTimelineProps {
  readonly compact?: boolean;
  readonly snapshot: AiRunSnapshot;
  readonly manifest?: EgressManifest | null;
  readonly projectId: string;
  readonly conversationId: string;
  readonly csrfToken: string | null;
  readonly disabled?: boolean;
  readonly onSnapshotChange?: (snapshot: AiRunSnapshot) => void;
  readonly onConversationReconciled?: (history: ConversationHistoryResponse) => void;
}

const DIRECT_PROVIDER_NOTICE = 'The direct model request is server-side. The authoritative project workspace is unchanged.';

export function AiRunTimeline({ snapshot, manifest = null, projectId, conversationId, csrfToken, disabled = false, compact = false, onSnapshotChange, onConversationReconciled }: AiRunTimelineProps): React.JSX.Element {
  const timeline = useAiRunTimeline({
    snapshot,
    projectId,
    conversationId,
    csrfToken,
    enabled: !disabled && snapshot.status !== 'rejected'
      && (snapshot.decision === 'policy_authorized' || snapshot.decision === 'approved' && snapshot.status !== 'ready'),
    onSnapshotChange,
    onConversationReconciled
  });
  const terminal = ['succeeded', 'failed', 'blocked', 'cancelled', 'review_required', 'rejected'].includes(timeline.snapshot.status);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const refreshing = timeline.reconciliationStatus === 'loading';
  const refresh = (): void => {
    setRefreshRequested(true);
    timeline.refresh();
  };
  const reviewRequired = timeline.snapshot.status === 'review_required' || (timeline.connection === 'error' && timeline.snapshot.providerTransmission === 'unknown');
  const showReconciliationNotice = timeline.connection === 'disconnected' || ['loading', 'partial', 'failed'].includes(timeline.reconciliationStatus);
  const statusText = statusLabel(timeline.snapshot.status, timeline.connection, timeline.snapshot.decision);
  const partialResponse = timeline.assistantText.length > 0 && ['failed', 'blocked', 'cancelled', 'review_required'].includes(timeline.snapshot.status);
  const showTyping = compact && !terminal && ['ready', 'queued', 'running'].includes(timeline.snapshot.status) && timeline.connection !== 'disconnected' && timeline.connection !== 'error';
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousRef = useRef({ status: timeline.snapshot.status, connection: timeline.connection, terminal });

  useEffect(() => { setRefreshRequested(false); }, [snapshot.runId]);

  useEffect(() => {
    const previous = previousRef.current;
    const enteredActive = previous.status === 'ready' && ['queued', 'running', 'waiting_approval', 'cancel_requested'].includes(timeline.snapshot.status);
    const reachedTerminal = terminal && (!previous.terminal || timeline.connection === 'complete' && previous.connection !== 'complete');
    if (enteredActive || reachedTerminal) {
      headingRef.current?.focus({ preventScroll: true });
    }
    previousRef.current = { status: timeline.snapshot.status, connection: timeline.connection, terminal };
  }, [terminal, timeline.connection, timeline.snapshot.status]);

  // Once the saved answer is in chat history, the compact stream must not repeat it.
  if (compact && timeline.snapshot.status === 'succeeded' && timeline.reconciliationStatus === 'complete' && !timeline.error) {
    return <div className="assistant-run-indicator assistant-run-complete" role="status"><Icon name="check" size={18} /><span className="sr-only">Assistant response complete.</span></div>;
  }

  return (
    <section className={`ai-run-timeline${compact ? ' ai-run-timeline-compact' : ''}`} data-testid="ai-run-timeline" aria-labelledby="ai-run-timeline-heading">
      <Card className="ai-run-timeline-card">
        <h3 ref={headingRef} id="ai-run-timeline-heading" data-testid="ai-run-timeline-heading" className={compact ? 'sr-only' : undefined} tabIndex={-1}>{terminalHeading(timeline.snapshot.status, reviewRequired)}</h3>
        {!compact ? <Alert tone="info" data-testid="ai-run-provider-notice">
          <p>{timeline.snapshot.decision === 'policy_authorized'
            ? 'This run follows the current stored workspace policy. Selected context and supported file boundaries remain enforced.'
            : 'This older approval is retained as history and cannot authorize new execution. Submit a fresh request under the current workspace policy.'}</p>
          {timeline.snapshot.runtime?.kind === 'hermes' ? <p>Hermes works in an isolated project copy using the selected context. Completed file changes are validated and recorded in File history.</p> : <p>{DIRECT_PROVIDER_NOTICE}</p>}
          {timeline.snapshot.providerApprovalMode === 'remembered_permission' ? <p data-testid="ai-run-remembered-permission-notice">This saved provider permission is a legacy record. It does not authorize new automatic execution.</p> : null}
          {manifest ? <p className="field-help">Provider: {manifest.provider}. Model: {formatModel(manifest.model)}. Selected files: {manifest.itemCount}. Recent messages: {manifest.messageCount}.</p> : null}
        </Alert> : null}
        {timeline.snapshot.runtime?.kind === 'hermes' ? <HermesToolActivity events={timeline.events} /> : null}
        {timeline.snapshot.runtime?.kind === 'hermes' ? <CommandExecutionSurface run={timeline.snapshot} readOnly={disabled} /> : null}
        {timeline.snapshot.status !== 'failed' ? <div
          className="ai-run-timeline-status"
          data-testid="ai-run-timeline-status"
          aria-label="Run status"
          role={timeline.connection === 'disconnected' ? undefined : 'status'}
          aria-live={timeline.connection === 'disconnected' ? undefined : 'polite'}
          aria-busy={!terminal && timeline.connection !== 'disconnected'}
        >
          {showTyping ? <span className="assistant-run-indicator assistant-run-typing" aria-hidden="true"><i /><i /><i /></span> : compact && timeline.snapshot.status === 'succeeded' ? <span className="assistant-run-indicator assistant-run-complete"><Icon name="check" size={18} /></span> : !terminal && timeline.connection !== 'disconnected' && timeline.connection !== 'error' ? <Spinner label={statusText} /> : null}
          {timeline.connection !== 'disconnected' ? <span data-testid="run-connection-status" className={showTyping || compact && timeline.snapshot.status === 'succeeded' ? 'sr-only' : undefined}>{statusText}</span> : null}
        </div> : null}
        {timeline.assistantText ? <article className="ai-run-assistant-output" data-testid="ai-run-assistant-output" aria-labelledby="ai-run-assistant-heading"><h4 id="ai-run-assistant-heading">Assistant response</h4>{partialResponse ? <p className="field-help" data-testid="assistant-stream-partial">Incomplete response</p> : null}<div data-testid="assistant-stream"><MarkdownContent content={timeline.assistantText} /></div></article> : null}
        {!compact && !timeline.assistantText && ['ready', 'queued', 'running', 'waiting_approval'].includes(timeline.snapshot.status) ? <p className="field-help" data-testid="assistant-stream-empty">Waiting for the assistant...</p> : null}
        {!compact && !timeline.assistantText && timeline.snapshot.status === 'succeeded' ? <p className="field-help" data-testid="ai-run-empty-response">The assistant completed without a message.</p> : null}
        {!compact && timeline.snapshot.status === 'succeeded' ? <p className="field-help" data-testid="run-completed">Run complete. Workspace file changes are applied automatically and recorded in File history.</p> : null}
        {timeline.snapshot.status === 'cancelled' ? <Alert tone="info" data-testid="run-cancelled" role="status"><p>Run cancelled. No further assistant work will be applied.</p>{partialResponse ? <p>Incomplete response.</p> : null}</Alert> : null}
        {timeline.snapshot.status === 'failed' ? <Alert tone="error" data-testid="run-failed" role="alert"><p>{timeline.snapshot.safeMessage || 'The assistant could not complete this run.'}</p>{partialResponse ? <p>Incomplete response.</p> : null}</Alert> : null}
        {timeline.snapshot.status === 'blocked' ? <Alert tone="error" data-testid="run-blocked" role="alert"><p>Run blocked by policy. This run was not completed.</p></Alert> : null}
        {timeline.snapshot.status === 'review_required' ? <Alert tone="warning" role="alert" data-testid="ai-run-review-required">
          <p>This run stopped and needs review. Refresh checks its saved status; it does not restart the assistant.</p>
          <Button type="button" variant="secondary" data-testid="ai-run-review-refresh" disabled={refreshing || disabled} aria-busy={refreshing} onClick={refresh}>{refreshing ? 'Refreshing...' : 'Refresh run status'}</Button>
          {refreshRequested && !refreshing && timeline.reconciliationReads.run ? <p role="status">Status refreshed. This run still needs review.</p> : null}
        </Alert> : null}
        {showReconciliationNotice ? <Alert tone="warning" role="alert" data-testid="ai-run-disconnected"><p>{reconciliationMessage(timeline.connection, timeline.reconciliationStatus, timeline.reconciliationReads)}</p><Button type="button" variant="secondary" data-testid="ai-run-disconnected-refresh" disabled={refreshing || disabled} aria-busy={refreshing} onClick={refresh}>{refreshing ? 'Refreshing...' : 'Refresh run status'}</Button></Alert> : null}
        {timeline.cancelError ? <Alert tone="error" role="alert" data-testid="run-cancel-error"><p>{timeline.cancelError}</p><Button type="button" variant="secondary" data-testid="run-cancel-error-refresh" disabled={refreshing || disabled} aria-busy={refreshing} onClick={refresh}>{refreshing ? 'Refreshing...' : 'Refresh run status'}</Button></Alert> : null}
        {timeline.error && timeline.connection !== 'disconnected' && timeline.snapshot.status !== 'review_required' ? <Alert tone="error" role="alert" data-testid="ai-run-timeline-error">{timeline.error}</Alert> : null}
        {!terminal && timeline.snapshot.status !== 'cancel_requested' ? <Button type="button" variant="secondary" data-testid="ai-run-cancel" disabled={timeline.cancelPending || disabled || !csrfToken} aria-busy={timeline.cancelPending} onClick={timeline.cancel}>{timeline.cancelPending ? 'Stopping assistant run...' : 'Cancel run'}</Button> : null}
        {timeline.snapshot.status === 'cancel_requested' ? <p data-testid="ai-run-cancel-status" role="status">Stopping assistant run...</p> : null}
      </Card>
    </section>
  );
}

function statusLabel(status: AiRunSnapshot['status'], connection: ReturnType<typeof useAiRunTimeline>['connection'], decision: AiRunSnapshot['decision']): string {
  if (connection === 'starting') {
    return 'Starting the policy-authorized assistant run...';
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
    return 'The assistant is waiting for your command decision.';
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
    return decision === 'policy_authorized'
      ? 'Starting the policy-authorized assistant run...'
      : 'This older approved run is paused. Submit a fresh request to continue.';
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
    return 'Assistant run failed';
  }
  return 'Assistant run';
}

function formatModel(model: string): string {
  return model === 'nvidia/nemotron-3-super-120b-a12b' ? 'Nemotron 3 Super 120B' : model;
}

function reconciliationMessage(connection: ReturnType<typeof useAiRunTimeline>['connection'], status: ReturnType<typeof useAiRunTimeline>['reconciliationStatus'], reads: ReturnType<typeof useAiRunTimeline>['reconciliationReads']): string {
  const prefix = connection === 'disconnected' ? 'Live updates disconnected. ' : '';
  if (status === 'loading' || status === 'idle') return `${prefix}Checking the saved run and conversation; no work will be restarted.`;
  if (status === 'complete') return 'Live updates disconnected. The saved run and conversation were refetched; no event replay was attempted.';
  if (status === 'partial') {
    const refreshed = reads.run ? 'saved run' : 'conversation';
    const failed = reads.run ? 'conversation' : 'saved run';
    return `${prefix}The ${refreshed} was refreshed, but the ${failed} could not be loaded. Refresh to try again; no work will be restarted.`;
  }
  return `${prefix}The saved run and conversation could not be refreshed. Check your connection and refresh to try again; no work will be restarted.`;
}
