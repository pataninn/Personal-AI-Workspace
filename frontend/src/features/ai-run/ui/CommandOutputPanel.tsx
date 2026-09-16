import type { SandboxCommandSnapshot } from '@/entities/ai-run';
import { Alert, Button, Spinner } from '@/shared/ui';

import {
  COMMAND_PROMOTION_NOTICE,
  FAKE_SANDBOX_NOTICE,
  statusLabel
} from '@/features/ai-run/model/command-copy';

interface CommandOutputPanelProps {
  readonly command: SandboxCommandSnapshot;
  readonly runtimeKind?: 'fake';
  readonly actionPending: boolean;
  readonly canMutate: boolean;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
}

export function CommandOutputPanel({ command, runtimeKind, actionPending, canMutate, onCancel, onRefresh }: CommandOutputPanelProps): React.JSX.Element | null {
  if (command.status === 'awaiting_approval' && command.decision !== 'approved') {
    return null;
  }
  const running = command.status === 'running' || (command.status === 'awaiting_approval' && command.decision === 'approved');
  const stopping = command.status === 'cancel_requested' || (actionPending && command.status === 'running');
  const result = command.result;
  const terminal = !running && command.status !== 'cancel_requested';

  return (
    <section className="command-output-panel" data-testid={running ? 'command-running' : 'command-output-panel'} aria-labelledby={`command-output-heading-${command.commandId}`}>
      <h4 id={`command-output-heading-${command.commandId}`}>Sandbox command output</h4>
      <div
        className="command-output-status"
        data-testid={running ? 'command-running-status' : 'command-output-status'}
        role="status"
        aria-live="polite"
        aria-busy={running || stopping}
      >
        {running ? <><Spinner label={statusLabel(command.status, runtimeKind)} /><span>{runtimeKind === 'fake' ? 'Simulating command in fake sandbox...' : statusLabel(command.status, runtimeKind)}</span></> : <span>{statusLabel(command.status, runtimeKind)}</span>}
      </div>

      {runtimeKind === 'fake' && terminal ? <Alert tone="warning" data-testid="command-fake-mode-notice">{FAKE_SANDBOX_NOTICE}</Alert> : null}
      {stopping ? <p data-testid="command-cancel-status" role="status" aria-live="polite">Stopping command...</p> : null}
      {running ? <Button type="button" variant="destructive" data-testid="command-cancel" disabled={actionPending || !canMutate} aria-busy={actionPending} onClick={onCancel}>Cancel command</Button> : null}
      {command.status === 'cancel_requested' && !actionPending ? <Button type="button" variant="secondary" data-testid="command-cancel-refresh" onClick={onRefresh}>Refresh command status</Button> : null}
      {command.status === 'cancelled' ? <p data-testid="command-cancelled">Command cancelled. No result was promoted to the project.</p> : null}
      {command.status === 'review_required' ? <Alert tone="warning" data-testid="command-review-required" role="alert">We could not confirm whether the command started or stopped. Do not retry automatically; refresh command status.</Alert> : null}
      {command.status === 'blocked' ? <Alert tone="warning" data-testid="command-blocked" role="alert">Command blocked by sandbox policy. This command was not run.</Alert> : null}
      {command.status === 'failed' || command.status === 'timed_out' ? <Alert tone="error" data-testid="command-error" role="alert">{command.status === 'timed_out' ? 'The private sandbox stopped the command at its time limit.' : 'Command could not complete.'}</Alert> : null}
      {result && terminal && command.status !== 'cancelled' && command.status !== 'blocked' && command.status !== 'review_required' ? <ResultDetails command={command} runtimeKind={runtimeKind} /> : null}
      {command.status === 'completed' || command.status === 'output_truncated' ? <p className="field-help">{COMMAND_PROMOTION_NOTICE}</p> : null}
    </section>
  );
}

interface ResultDetailsProps {
  readonly command: SandboxCommandSnapshot;
  readonly runtimeKind?: 'fake';
}

function ResultDetails({ command, runtimeKind }: ResultDetailsProps): React.JSX.Element {
  const result = command.result;
  if (!result) {
    return <p className="field-help">The server returned command status without a result preview.</p>;
  }
  const truncated = command.status === 'output_truncated' || result.outputTruncated;
  const completed = command.status === 'completed' || command.status === 'output_truncated';
  const hasOutput = result.outputBytes > 0;
  return (
    <>
      {completed ? <p data-testid="command-completed">{truncated ? 'Command completed with output truncated' : runtimeKind === 'fake' ? 'Fake sandbox preview complete' : 'Command completed in private sandbox'}</p> : null}
      {truncated ? <Alert tone="warning" data-testid="command-output-truncated" role="status">Output was truncated by the sandbox limit.</Alert> : null}
      {hasOutput && result.outputPreview !== undefined ? (
        <pre className="command-output-region" data-testid="command-output" tabIndex={0} aria-label="Sandbox command output"><code>{result.outputPreview}</code></pre>
      ) : hasOutput ? (
        <p className="field-help">The server returned bounded output metadata, but no preview is available in this snapshot.</p>
      ) : (
        <p data-testid="command-output-empty">No output was returned.</p>
      )}
    </>
  );
}
