export const COMMAND_BOUNDARY_NOTICE = 'Commands run only in a disposable staged sandbox. They never run on Windows or inside the app container.';
export const COMMAND_PROMOTION_NOTICE = 'The sandbox edits a project copy. After a successful run, validated file changes are applied and recorded in File history. Cancelling a command stops the whole Hermes run.';
export const FAKE_SANDBOX_NOTICE = 'Development preview - fake sandbox. This command is simulated; no process ran on Windows or in the app container.';
export const COMMAND_EMPTY_NOTICE = 'No sandbox command is waiting for review.';
export const COMMAND_STATUS_LOAD_ERROR = 'We could not load the command status. Refresh the run status.';
export const COMMAND_DECISION_UNKNOWN = 'We could not confirm the command decision. Refresh command status before trying again.';
export const COMMAND_STOP_UNKNOWN = 'Command status could not be confirmed. Refresh command status before retrying.';

export function decisionPendingLabel(decision: 'approve' | 'reject'): string {
  return decision === 'approve' ? 'Approving command...' : 'Rejecting command...';
}

export function statusLabel(status: string, runtimeKind: 'fake' | undefined): string {
  if (status === 'rejected') {
    return 'Command rejected. This command was not run.';
  }
  if (status === 'awaiting_approval') {
    return 'Approval required';
  }
  if (status === 'running') {
    return runtimeKind === 'fake' ? 'Simulating command in fake sandbox...' : 'Running in private sandbox';
  }
  if (status === 'cancel_requested') {
    return 'Stopping command...';
  }
  if (status === 'completed' && runtimeKind === 'fake') {
    return 'Fake sandbox preview complete';
  }
  if (status === 'completed') {
    return 'Command completed in private sandbox';
  }
  if (status === 'output_truncated') {
    return 'Command completed with output truncated';
  }
  if (status === 'timed_out') {
    return 'The command reached the private sandbox time limit.';
  }
  if (status === 'failed') {
    return 'Command could not complete.';
  }
  if (status === 'cancelled') {
    return 'Command cancelled. No result was promoted to the project.';
  }
  if (status === 'blocked') {
    return 'Command blocked by sandbox policy';
  }
  if (status === 'review_required') {
    return 'Command status needs review';
  }
  return 'Starting private sandbox command...';
}
