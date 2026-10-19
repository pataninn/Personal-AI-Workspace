import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getProposedChangeSet,
  type ProposedChangeOperation,
  type ProposedChangeSetSnapshot
} from '@/entities/ai-run';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Card, EmptyState, ErrorState, Skeleton } from '@/shared/ui';

interface ProposedChangeReviewProps {
  readonly runId: string;
  readonly readOnly?: boolean;
  readonly conversationHref?: string;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'empty' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'success'; readonly changeSet: ProposedChangeSetSnapshot; readonly refreshing: boolean; readonly refreshError?: string };

export function ProposedChangeReview({ runId, readOnly = false, conversationHref }: ProposedChangeReviewProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  async function refresh(): Promise<void> {
    setState((current) => current.status === 'success'
      ? { ...current, refreshing: true, refreshError: undefined }
      : { status: 'loading' });
    try {
      const changeSet = await getProposedChangeSet(runId);
      setState({ status: 'success', changeSet, refreshing: false });
      setSelectedOperationId((current) => current && changeSet.operations.some((operation) => operation.operationId === current) ? current : changeSet.operations[0]?.operationId ?? null);
    } catch (error: unknown) {
      setState((current) => current.status === 'success'
        ? { ...current, refreshing: false, refreshError: 'We could not refresh the apply status. Try again when the local app is available.' }
        : error instanceof ApiClientError && error.statusCode === 404
          ? { status: 'empty' }
          : { status: 'error', message: changeErrorMessage(error) });
    }
  }

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void getProposedChangeSet(runId).then((changeSet) => {
      if (!active) return;
      setState({ status: 'success', changeSet, refreshing: false });
      setSelectedOperationId(changeSet.operations[0]?.operationId ?? null);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiClientError && error.statusCode === 404) {
        setState({ status: 'empty' });
      } else {
        setState({ status: 'error', message: changeErrorMessage(error) });
      }
    });
    return () => { active = false; };
  }, [runId]);

  if (state.status === 'loading') return <section className="change-review-surface" data-testid="change-review-surface" aria-labelledby="change-review-heading" aria-busy="true"><h2 id="change-review-heading" tabIndex={-1}>Proposed changes</h2><p data-testid="change-review-loading-status" role="status" aria-live="polite">Loading proposed changes...</p><Card className="change-review-loading" data-testid="change-review-loading"><Skeleton /><Skeleton /></Card></section>;
  if (state.status === 'empty') return <section className="change-review-surface" data-testid="change-review-surface" aria-labelledby="change-review-heading"><h2 id="change-review-heading" tabIndex={-1}>Proposed changes</h2><div data-testid="change-review-empty"><EmptyState title="No project changes were proposed." detail="The assistant did not produce a file mutation for this run." /></div></section>;
  if (state.status === 'error') return <section className="change-review-surface" data-testid="change-review-surface" aria-labelledby="change-review-heading"><h2 id="change-review-heading" tabIndex={-1}>Proposed changes</h2><div data-testid="change-review-error"><ErrorState title="Proposed changes unavailable" detail={state.message} action={<Button type="button" variant="secondary" data-testid="change-review-retry" disabled={readOnly} onClick={() => { void refresh(); }} aria-describedby={readOnly ? 'change-review-read-only' : undefined}>Refresh proposed changes</Button>} /></div></section>;

  const changeSet = state.changeSet;
  const selected = changeSet.operations.find((operation) => operation.operationId === selectedOperationId) ?? changeSet.operations[0];
  const refreshActionLabel = changeSet.status === 'needs_manual_review' ? 'Refresh apply status' : 'Refresh proposed changes';
  return (
    <section className="change-review-surface" data-testid="change-review-surface" aria-labelledby="change-review-heading" aria-busy={state.refreshing ? 'true' : 'false'}>
      <div className="change-review-heading-row"><div><h2 id="change-review-heading" tabIndex={-1}>Workspace change history</h2><p className="field-help">Review the server-validated change set and its saved result.</p></div><Button type="button" variant="secondary" data-testid="change-refresh-status" onClick={() => { void refresh(); }} disabled={state.refreshing || readOnly}>{refreshActionLabel}</Button></div>
      {changeSet.fakeRuntime ? <Alert tone="info" data-testid="change-review-fake-mode-notice">Development preview - fake runtime. These proposed changes are simulated; live OpenShell, Hermes, and model provider provenance is not verified.</Alert> : null}
      {readOnly ? <Alert tone="warning" id="change-review-read-only" data-testid="change-review-read-only">This project is archived. Proposed changes are read-only and cannot be applied.</Alert> : null}
      {changeSet.status === 'awaiting_approval' ? <Alert tone="warning" data-testid="change-legacy-blocked">This older change set is waiting for a decision that is no longer available. It will not be applied. Submit a fresh request under the current workspace policy.</Alert> : null}
      {state.refreshing ? <p data-testid="change-refreshing" role="status" aria-live="polite">Refreshing proposed changes...</p> : null}
      {state.refreshError ? <Alert tone="error" data-testid="change-refresh-error">{state.refreshError}</Alert> : null}
      <Card className="change-review-summary" data-testid="change-set-summary"><dl><div><dt>Status</dt><dd data-testid="change-decision-status">{statusLabel(changeSet)}</dd></div><div><dt>Operations</dt><dd>{changeSet.counts.total}</dd></div><div><dt>Creates</dt><dd>{changeSet.counts.creates}</dd></div><div><dt>Edits</dt><dd>{changeSet.counts.edits}</dd></div><div><dt>Overwrites</dt><dd>{changeSet.counts.overwrites}</dd></div><div><dt>Renames</dt><dd>{changeSet.counts.renames}</dd></div><div><dt>Deletes</dt><dd>{changeSet.counts.deletes}</dd></div><div><dt>Recovery snapshots required</dt><dd>{changeSet.counts.destructive}</dd></div><div><dt>Review size</dt><dd>{formatBytes(changeSet.totalSizeBytes)} across {changeSet.totalLineCount} lines</dd></div><div><dt>Proposal freshness</dt><dd data-testid="change-proposal-freshness">Source versions are rechecked before applying.</dd></div><div><dt>Last updated</dt><dd data-testid="change-proposal-updated-at">{changeSet.updatedAt}</dd></div></dl><p>{changeSet.safeMessage}</p></Card>
      {changeSet.status === 'stale' ? <Alert tone="warning" data-testid="change-stale">{changeSet.result?.appliedCount ? <>{changeSet.result.appliedCount} earlier operation{changeSet.result.appliedCount === 1 ? ' was' : 's were'} applied before the project changed. Review those results and the current project files. </> : <>The project changed before any operation from this proposal was applied. </>}Current files are left as they are now; this proposal cannot be applied again. {changeSet.result?.conflictPath ? <>Conflict path: <code data-testid="change-conflict-path">{changeSet.result.conflictPath}</code>. </> : null}Start a new proposal in the conversation after reviewing the current file state.{conversationHref ? <> <Link to={conversationHref}>Open conversation</Link>.</> : null}{changeSet.result?.conflictPath ? <> <Link to={`/projects/${encodeURIComponent(changeSet.projectId)}/file-history?path=${encodeURIComponent(changeSet.result.conflictPath)}`}>View file history for this path</Link>.</> : null}</Alert> : null}
      {changeSet.status === 'needs_manual_review' ? <Alert tone="warning" data-testid="change-review-required">Apply status needs review. The app could not confirm whether every file operation and backup finished. Do not retry automatically. Refresh the apply status and inspect the project before trying again.</Alert> : null}
      {changeSet.status === 'blocked' || changeSet.status === 'failed' || changeSet.operations.some((operation) => !operation.reviewable) ? <Alert tone="error" data-testid="change-failure">This proposed change cannot be applied because a safe bounded review is unavailable.</Alert> : null}
      {changeSet.status === 'applied' ? <Alert tone="success" data-testid="change-applied" role="status" live="polite"><strong>Changes applied</strong><br />{changeSet.decision === 'policy_authorized' ? 'The saved result was applied under the recorded execution policy.' : 'The prior change result is shown as historical workspace activity.'}</Alert> : null}
      {changeSet.status === 'rejected' ? <Alert tone="info" data-testid="change-rejected" role="status" live="polite">Change set rejected. No project files were changed.</Alert> : null}
      {changeSet.operations.length > 0 ? <div className="change-review-content"><ol className="change-review-operation-list" aria-label="Proposed file operations">{changeSet.operations.map((operation) => <li key={operation.operationId} data-testid="change-operation"><button type="button" className={`change-review-operation ${selected?.operationId === operation.operationId ? 'is-selected' : ''}`} aria-pressed={selected?.operationId === operation.operationId} onClick={() => setSelectedOperationId(operation.operationId)}><span className="change-operation-kind" data-testid="change-operation-type">{operationLabel(operation.operation)}</span>{operation.operation === 'rename' && operation.destinationPath ? <><span><span>From</span> <code data-testid="change-operation-path">{operation.path}</code></span><span><span>To</span> <code>{operation.destinationPath}</code></span></> : <code data-testid="change-operation-path">{operation.path}</code>}<span data-testid="change-operation-size">{formatBytes(operation.sizeBytes)} · {operation.lineCount} lines</span></button></li>)}</ol>{selected ? <OperationDetail operation={selected} projectId={changeSet.projectId} showDiff={showDiff} onToggleDiff={() => setShowDiff((current) => !current)} /> : null}</div> : null}
      {changeSet.result ? <ResultSummary changeSet={changeSet} /> : null}
      {changeSet.result ? <RecoverySnapshotSummary result={changeSet.result} /> : null}
      <div className="change-review-actions">{conversationHref ? <a className="button button-secondary" data-testid="change-back-to-run" href={conversationHref}>Back to conversation</a> : null}</div>
    </section>
  );
}

function OperationDetail({ operation, projectId, showDiff, onToggleDiff }: { readonly operation: ProposedChangeOperation; readonly projectId: string; readonly showDiff: boolean; readonly onToggleDiff: () => void }): React.JSX.Element {
  const previewLabel = operation.operation === 'create' ? 'New content' : operation.operation === 'delete' ? 'Content to be removed' : operation.operation === 'rename' ? 'Source content' : 'Line-by-line changes';
  const previewContentId = `change-diff-content-${operation.operationId}`;
  return <Card className="change-review-operation-detail" data-testid="change-operation-detail"><h3>{operationLabel(operation.operation)}: <code>{operation.path}</code></h3>{operation.operation === 'rename' && operation.destinationPath ? <dl><div><dt>From</dt><dd><code>{operation.path}</code></dd></div><div><dt>To</dt><dd><code>{operation.destinationPath}</code></dd></div></dl> : null}<p>{operation.summary}</p><dl><div><dt>Source at proposal</dt><dd>{operation.sourcePresent ? 'Present' : 'Not present'}</dd></div><div><dt>Destination at proposal</dt><dd>{operation.destinationPresent ? 'Present' : 'Not present'}</dd></div><div><dt>Version check</dt><dd>Current file versions are checked again before any approved change is applied.</dd></div><div><dt>Backup</dt><dd data-testid="change-operation-backup">{operation.backupRequired ? 'A recovery snapshot will be created before this operation.' : 'No backup required'}</dd></div><div><dt>Preview</dt><dd>{previewLabel}{operation.preview?.limited ? <span data-testid="change-preview-limited">. Preview limited by the server safety limit; the full file is not shown.</span> : ''}</dd></div></dl><Link to={`/projects/${encodeURIComponent(projectId)}/file-history?path=${encodeURIComponent(operation.path)}`}>View file history for {operation.path}</Link>{operation.destinationPath ? <Link to={`/projects/${encodeURIComponent(projectId)}/file-history?path=${encodeURIComponent(operation.destinationPath)}`}>View file history for {operation.destinationPath}</Link> : null}{operation.preview ? <><Button type="button" variant="ghost" data-testid="change-diff-toggle" aria-expanded={showDiff} aria-controls={previewContentId} onClick={onToggleDiff}>{showDiff ? 'Hide bounded change preview' : 'View bounded change preview'}</Button><div id={previewContentId}>{showDiff ? <DiffPreview preview={operation.preview} /> : null}</div></> : <p data-testid="change-no-preview">A safe diff is unavailable for this operation. Review is required before applying.</p>}</Card>;
}

function DiffPreview({ preview }: { readonly preview: NonNullable<ProposedChangeOperation['preview']> }): React.JSX.Element {
  if (preview.kind !== 'diff') return <pre data-testid="change-diff"><code>{preview.text}</code></pre>;
  const lines = preview.text.split('\n');
  const addedCount = lines.filter((line) => line.startsWith('+ ')).length;
  const removedCount = lines.filter((line) => line.startsWith('- ')).length;
  return <><p data-testid="change-diff-counts">{addedCount} added, {removedCount} removed in this preview{preview.limited ? ' (limited)' : ''}.</p><ol className="change-review-diff" data-testid="change-diff" aria-label="Bounded line diff">{lines.map((line, index) => {
    const kind = line.startsWith('+ ') ? 'added' : line.startsWith('- ') ? 'removed' : 'context';
    const content = kind === 'context' ? line.replace(/^  /u, '') : line.slice(2);
    const label = kind === 'added' ? 'Added' : kind === 'removed' ? 'Removed' : 'Unchanged';
    return <li className={`change-review-diff-line is-${kind}`} key={`${index}-${line}`}><span className="change-review-diff-label">{label}</span><code>{content}</code></li>;
  })}</ol></>;
}

function RecoverySnapshotSummary({ result }: { readonly result: NonNullable<ProposedChangeSetSnapshot['result']> }): React.JSX.Element | null {
  const backedUp = result.operations.filter((operation) => operation.backup === 'created');
  if (backedUp.length === 0) return null;
  return <Card className="change-review-recovery-results" data-testid="change-recovery-snapshot-results"><h3>Recovery snapshots</h3><ul>{backedUp.map((operation) => <li key={operation.operationId} data-testid="change-recovery-snapshot-result">Recovery snapshot created for <code>{operation.path}</code>.</li>)}</ul></Card>;
}

function ResultSummary({ changeSet }: { readonly changeSet: ProposedChangeSetSnapshot }): React.JSX.Element {
  const result = changeSet.result;
  if (!result) return <></>;
  return <Card className="change-review-result" data-testid="change-apply-result"><h3>Apply result</h3><p>{result.appliedCount} applied · {result.skippedCount} skipped · {result.failedCount} failed · {result.backupCount} backups</p>{result.conflictPath ? <p>First conflict: <code>{result.conflictPath}</code></p> : null}<ol>{result.operations.map((operation) => <li key={operation.operationId}><code>{operation.path}</code>: {operation.status} ({operation.backup}) — {operation.safeMessage}</li>)}</ol></Card>;
}

function operationLabel(operation: ProposedChangeOperation['operation']): string {
  return { create: 'Create new file', edit: 'Edit existing file', overwrite: 'Replace existing file', rename: 'Rename file', delete: 'Delete file' }[operation];
}

function statusLabel(changeSet: ProposedChangeSetSnapshot): string {
  if (changeSet.status === 'awaiting_approval') return 'Legacy decision retired';
  if (changeSet.status === 'applying') return changeSet.decision === 'policy_authorized' ? 'Applying under current policy' : 'Applying';
  if (changeSet.status === 'needs_manual_review') return 'Needs manual review';
  return changeSet.status.charAt(0).toUpperCase() + changeSet.status.slice(1);
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

function changeErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'CHANGE_SET_CONFLICT') return 'The project changed before the decision completed. Refresh to review the authoritative result.';
    if (error.code === 'CHANGE_SET_REVIEW_REQUIRED') return 'The app could not confirm the apply outcome. Refresh the result and inspect the project before retrying.';
    if (error.code === 'CHANGE_SET_BLOCKED') return 'These changes are blocked by the active project or workspace safety policy.';
    if (error.code === 'CHANGE_SET_ALREADY_DECIDED') return 'This change set already has a decision. Refresh the authoritative result.';
  }
  return 'The proposed changes could not be loaded. Refresh and try again.';
}
