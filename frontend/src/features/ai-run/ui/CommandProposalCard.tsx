import { useEffect, useRef } from 'react';

import type { SandboxCommandSnapshot } from '@/entities/ai-run';
import { Alert, Button, Card, Spinner } from '@/shared/ui';

import {
  COMMAND_BOUNDARY_NOTICE,
  COMMAND_PROMOTION_NOTICE,
  FAKE_SANDBOX_NOTICE,
  statusLabel
} from '@/features/ai-run/model/command-copy';
import type { SandboxCommandAction, SandboxCommandActionState } from '@/features/ai-run/model/use-sandbox-commands';
import { CommandOutputPanel } from '@/features/ai-run/ui/CommandOutputPanel';

interface CommandProposalCardProps {
  readonly command: SandboxCommandSnapshot;
  readonly runtimeKind?: 'fake';
  readonly actionState?: SandboxCommandActionState;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
  readonly conversationHref?: string;
  readonly canMutate: boolean;
}

export function CommandProposalCard({ command, runtimeKind, actionState, onCancel, onRefresh, conversationHref, canMutate }: CommandProposalCardProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingAction = actionState?.action;
  const isCancelPending = pendingAction === 'cancel';
  const needsDecision = command.status === 'awaiting_approval' && command.decision === 'pending';
  const starting = command.status === 'awaiting_approval' && command.decision === 'approved';
  const blocked = command.status === 'blocked';
  const terminal = !needsDecision && !starting && command.status !== 'running' && command.status !== 'cancel_requested';

  useEffect(() => {
    if (pendingAction || terminal) {
      headingRef.current?.focus();
    }
  }, [pendingAction, terminal]);

  return (
    <article className="command-proposal-card" data-testid="command-proposal" aria-busy={isCancelPending || undefined}>
      <Card className="command-proposal-card-content">
        <h3 ref={headingRef} tabIndex={-1}>{headingFor(command, starting, runtimeKind)}</h3>
        <div className="command-card-status" data-testid="command-output-status" role="status" aria-live="polite">
          {isCancelPending ? <><Spinner label="Cancelling command..." /><span>Cancelling command...</span></> : <span>{starting ? 'Starting private sandbox command...' : statusLabel(command.status, runtimeKind)}</span>}
        </div>

        <dl className="command-metadata">
          <div><dt>Requested action</dt><dd data-testid="command-summary"><code>{formatRequestedAction(command)}</code></dd></div>
          <div><dt>Safe summary</dt><dd>{command.summary}</dd></div>
          <div><dt>Policy status</dt><dd data-testid="command-policy-status">{blocked ? 'Blocked by sandbox policy' : needsDecision ? 'Legacy command is not resumed' : command.decision === 'policy_authorized' ? 'Authorized by the current workspace policy' : command.decision === 'approved' ? 'Prior command approval is historical' : command.decision === 'rejected' ? 'Prior denial is historical' : 'No command decision'}</dd></div>
          <div><dt>Working directory</dt><dd>{command.cwd}</dd></div>
          <div><dt>Network</dt><dd>{command.limits.network === 'approved_registries' ? 'Workspace policy allows HTTPS reads from registry.npmjs.org, or pypi.org and files.pythonhosted.org for pip, for this command only.' : 'Network access is denied by default.'}</dd></div>
          <div><dt>Output limit</dt><dd>{formatBytes(command.limits.maxOutputBytes)}</dd></div>
        </dl>

        <Alert tone="info" className="command-boundary" data-testid="command-boundary">
          <p>{COMMAND_BOUNDARY_NOTICE}</p>
          <p>{COMMAND_PROMOTION_NOTICE}</p>
        </Alert>
        {needsDecision ? <Alert tone="warning" data-testid="command-legacy-blocked">This older command is waiting for a decision that is no longer available. It will not run. Cancel the parent run or submit a fresh request under the current workspace policy.</Alert> : null}
        {!canMutate && !terminal && !needsDecision ? <Alert tone="info" data-testid="command-read-only">Command actions are disabled because this run has stopped or the project or session is read-only.</Alert> : null}
        {runtimeKind === 'fake' ? <Alert tone="warning" data-testid="command-fake-mode-notice">{FAKE_SANDBOX_NOTICE}</Alert> : null}
        <p className="command-mode-label" data-testid="command-mode-label">Execution mode: {runtimeKind === 'fake' ? 'Development preview - fake sandbox' : 'Private sandbox'}</p>

        {actionState?.error ? <Alert tone={actionState.error.ambiguous ? 'warning' : 'error'} data-testid={isCancelPending ? 'command-cancel-error' : 'command-decision-error'} role="alert">{actionState.error.message}</Alert> : null}
        <div className="command-action-row">
          {actionState?.error?.ambiguous ? <Button type="button" variant="secondary" data-testid="command-status-refresh" onClick={onRefresh}>Refresh command status</Button> : null}
          {command.status === 'review_required' ? <Button type="button" variant="secondary" data-testid="command-status-refresh" onClick={onRefresh}>Refresh command status</Button> : null}
          {command.status === 'review_required' && conversationHref ? <a className="button button-secondary" data-testid="command-back-to-run" href={conversationHref}>Back to run</a> : null}
        </div>

        {command.status === 'rejected' ? <div data-testid="command-rejected" role="status"><p>Command rejected</p><p>This command was not run.</p></div> : null}
        {blocked ? <div data-testid="command-blocked" role="alert"><p>Command blocked by sandbox policy</p><p>This command was not run.</p></div> : null}
        {command.status === 'cancel_requested' && !isCancelPending ? <p data-testid="command-cancel-status" role="status">Stopping command...</p> : null}
        {!needsDecision && !starting && command.status !== 'rejected' && command.status !== 'blocked' ? <CommandOutputPanel command={command} runtimeKind={runtimeKind} actionPending={isCancelPending} canMutate={canMutate} onCancel={onCancel} onRefresh={onRefresh} /> : null}
        {command.status === 'cancelled' ? <p className="field-help">No result was promoted to the project.</p> : null}
      </Card>
    </article>
  );
}

function headingFor(command: SandboxCommandSnapshot, starting: boolean, runtimeKind?: 'fake'): string {
  if (command.status === 'rejected') {
    return 'Command rejected';
  }
  if (command.status === 'blocked') {
    return 'Command blocked by sandbox policy';
  }
  if (command.status === 'review_required') {
    return 'Command status needs review';
  }
  if (starting) {
    return 'Starting private sandbox command...';
  }
  return command.status === 'awaiting_approval' ? 'Legacy command is not resumed' : statusLabel(command.status, runtimeKind);
}

function formatRequestedAction(command: SandboxCommandSnapshot): string {
  if (command.command === 'hermes-terminal') return command.argumentSummaries.join(' ');
  if (command.argumentSummaries.length === 0) {
    return command.command;
  }
  return `${command.command} ${command.argumentSummaries.join(' ')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes.toLocaleString()} bytes`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB (${bytes.toLocaleString()} bytes)`;
}
