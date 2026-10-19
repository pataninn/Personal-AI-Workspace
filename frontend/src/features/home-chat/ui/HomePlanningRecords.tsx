import { Link } from 'react-router-dom';

import type { HomeProposal, HomeProposalCommand } from '@/entities/home-conversation';
import { Alert, Button, Card } from '@/shared/ui';

import type { HomePlanningRecordsController, HomeReceiptCardState, HomeProposalCardState } from '../model/use-home-planning-records';
import { hasProposalReceipt } from '../model/use-home-planning-records';

interface HomePlanningRecordsProps {
  readonly records: HomePlanningRecordsController;
  readonly turnId: string | null;
  readonly allowUndo: boolean;
}

export function HomePlanningRecords({ records, turnId, allowUndo }: HomePlanningRecordsProps): React.JSX.Element {
  const receipts = records.receipts.filter((receipt) => receipt.turnId === turnId);
  const proposals = records.proposals.filter((proposal) => proposal.proposal.sourceTurnId === turnId);
  return <div className="home-planning-records">
    {receipts.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt} allowUndo={allowUndo} onRefresh={records.refreshReceipt} onUndo={records.undoReceipt} />)}
    {proposals.map((proposal) => <ProposalCard key={proposal.proposal.id} record={proposal} onRetry={records.retryProposals} />)}
  </div>;
}

export function UnattachedHomePlanningRecords({ records, displayedTurnIds, allowUndo }: {
  readonly records: HomePlanningRecordsController;
  readonly displayedTurnIds: ReadonlySet<string>;
  readonly allowUndo: boolean;
}): React.JSX.Element {
  const orphanedProposals = records.proposals.filter((item) => !displayedTurnIds.has(item.proposal.sourceTurnId));
  const orphanedReceipts = records.receipts.filter((item) => !item.turnId || !displayedTurnIds.has(item.turnId));
  if (records.proposalsState === 'error' && records.proposals.length === 0) return <Alert tone="warning" data-testid="home-proposals-load-error">
    {records.proposalsError ?? 'Saved planning previews could not be loaded.'} <Button type="button" variant="secondary" data-testid="home-proposals-retry" onClick={records.retryProposals}>Retry previews</Button>
  </Alert>;
  if (!orphanedProposals.length && !orphanedReceipts.length) return <></>;
  return <section className="home-planning-records" aria-label="Saved planning actions from earlier history">
    {orphanedReceipts.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt} allowUndo={allowUndo} onRefresh={records.refreshReceipt} onUndo={records.undoReceipt} />)}
    {orphanedProposals.map((proposal) => <ProposalCard key={proposal.proposal.id} record={proposal} onRetry={records.retryProposals} />)}
  </section>;
}

function ReceiptCard({ receipt, allowUndo, onRefresh, onUndo }: {
  readonly receipt: HomeReceiptCardState;
  readonly allowUndo: boolean;
  readonly onRefresh: (receiptId: string) => Promise<void>;
  readonly onUndo: (receiptId: string) => Promise<void>;
}): React.JSX.Element {
  const task = receipt.target && 'task' in receipt.target ? receipt.target.task : null;
  const workspace = receipt.target && !('task' in receipt.target) ? receipt.target : null;
  const targetName = task?.title ?? workspace?.name;
  const targetHref = task ? `/tasks/${encodeURIComponent(task.id)}` : workspace ? `/projects/${encodeURIComponent(workspace.id)}` : null;
  return <Card className="home-receipt-card" id={`home-receipt-${receipt.id}`} data-testid={`home-receipt-card-${receipt.id}`}>
    <div className="home-record-heading"><h3>Saved action</h3><span className="home-record-state">{receipt.state === 'loading' ? 'Checking receipt…' : receipt.receipt?.undoStatus === 'undone' ? 'Undo completed' : receipt.receipt?.undoStatus === 'not_reversible' || receipt.receipt?.undoStatus === 'available' ? 'Saved' : ''}</span></div>
    {receipt.state === 'error' ? <Alert tone="warning" data-testid={`home-receipt-error-${receipt.id}`}>
      The saved receipt could not be checked. <Button type="button" variant="secondary" data-testid={`home-receipt-refresh-${receipt.id}`} onClick={() => { void onRefresh(receipt.id); }}>Refresh receipt</Button>
    </Alert> : null}
    {receipt.receipt ? <p className="home-record-description">{targetName && targetHref ? <><span>{receipt.receipt.actionKind.replaceAll('.', ' ')}: </span><Link to={targetHref} data-testid={`home-receipt-target-${receipt.id}`}>{targetName}</Link></> : receipt.targetUnavailable ? 'The saved target is unavailable.' : receipt.state === 'loading' ? 'Checking the current target.' : 'The current target has not been loaded.'}</p> : null}
    {receipt.undoError ? <Alert tone={receipt.conflictReason ? 'warning' : 'error'} role={receipt.conflictReason ? undefined : 'alert'} data-testid={`home-receipt-undo-conflict-${receipt.id}`}>{receipt.undoError}</Alert> : null}
    {receipt.state === 'ready' ? <>
      {receipt.receipt?.undoStatus === 'available' && allowUndo ? <div className="home-record-actions">
        {!receipt.conflictReason ? <Button type="button" variant="secondary" data-testid={receipt.undoError ? `home-receipt-retry-${receipt.id}` : `home-receipt-undo-${receipt.id}`} disabled={receipt.undoPending} aria-busy={receipt.undoPending} onClick={() => { void onUndo(receipt.id); }}>{receipt.undoPending ? 'Undoing…' : receipt.undoError ? 'Retry undo' : 'Undo'}</Button> : null}
        <Button type="button" variant="ghost" data-testid={`home-receipt-refresh-${receipt.id}`} disabled={receipt.undoPending} onClick={() => { void onRefresh(receipt.id); }}>Refresh receipt</Button>
      </div> : null}
      {receipt.receipt?.undoStatus === 'available' && !allowUndo ? <p className="home-record-description">Undo is unavailable for this scope.</p> : null}
      {receipt.receipt?.undoStatus === 'not_reversible' ? <p className="home-record-description">Undo is unavailable for this saved action.</p> : null}
      {receipt.receipt?.undoStatus === 'undone' ? <p className="home-record-description">Undo completed. The current target remains available above when it still exists.</p> : null}
    </> : null}
  </Card>;
}

function ProposalCard({ record, onRetry }: { readonly record: HomeProposalCardState; readonly onRetry: () => void }): React.JSX.Element {
  const proposal = record.proposal;
  const reviewable = proposal.state === 'review_required';
  return <Card className="home-proposal-card" data-testid={`home-proposal-card-${proposal.id}`} aria-busy={record.busy}>
    <div className="home-record-heading"><h3>{reviewable ? 'Saved planning preview' : 'Planning results'}</h3><span className="home-record-state">{proposalStateLabel(proposal.state)}</span></div>
    {reviewable ? <p className="home-record-description">This saved preview is read-only and cannot be applied or resumed.</p> : null}
    {record.error ? <Alert tone="warning" data-testid={`home-proposal-error-${proposal.id}`}>
      {record.error} <Button type="button" variant="secondary" data-testid={`home-proposal-refresh-${proposal.id}`} onClick={onRetry}>Refresh preview</Button>
    </Alert> : null}
    {record.message ? <p role="status" aria-live="polite" data-testid={`home-proposal-status-${proposal.id}`}>{record.message}</p> : null}
    {proposal.items.length === 0 ? <p className="home-record-description">No saved results.</p> : <ol className="home-proposal-items">
      {proposal.items.map((item) => <li className="home-proposal-item" data-testid={`home-proposal-item-${item.id}`} key={item.id}>
        <div className="home-record-heading"><strong>{proposalActionLabel(item.command)}</strong><span className="home-record-state">{proposalItemStateLabel(item.state)}</span></div>
        <p className="home-record-description">{proposalCommandSummary(item.command)}</p>
        {item.resultCode ? <p className="home-record-description">Result: {item.resultCode}</p> : null}
        {item.receiptId ? <p className="home-record-description" data-testid={`home-proposal-item-outcome-${item.id}`}>{hasProposalReceipt(item) ? `${proposalItemStateLabel(item.state)} · ` : ''}<Link to={`#home-receipt-${item.receiptId}`} data-testid={`home-proposal-receipt-${item.id}`}>View saved receipt</Link></p> : null}
      </li>)}
    </ol>}
  </Card>;
}

function proposalActionLabel(command: HomeProposalCommand): string {
  switch (command.action) {
    case 'task.create': return `Create task: ${command.title}`;
    case 'task.update': return `Update task${command.title ? `: ${command.title}` : ''}`;
    case 'task.move': return 'Move task';
    case 'task.archive': return 'Archive task';
    case 'workspace.create': return `Create workspace: ${command.name}`;
    case 'workspace.update_objective': return 'Update workspace objective';
  }
}

function proposalCommandSummary(command: HomeProposalCommand): string {
  switch (command.action) {
    case 'task.create': return command.title;
    case 'task.update': return command.title ?? 'Task update';
    case 'task.move': return 'Task destination changed';
    case 'task.archive': return 'Task archive';
    case 'workspace.create': return command.objective ? `Objective: ${command.objective}` : 'New planning workspace';
    case 'workspace.update_objective': return command.objective ?? 'Workspace objective cleared';
  }
}

function proposalStateLabel(state: HomeProposal['state']): string {
  const labels: Record<HomeProposal['state'], string> = {
    review_required: 'Saved preview · blocked', accepted: 'Legacy accepted · blocked', executing: 'Legacy action · blocked', partial: 'Partially completed', completed: 'Completed', cancelled: 'Cancelled', unknown: 'Needs review'
  };
  return labels[state];
}

function proposalItemStateLabel(state: HomeProposal['items'][number]['state']): string {
  const labels: Record<HomeProposal['items'][number]['state'], string> = {
    ready: 'Not applied', executing: 'Legacy action · blocked', saved: 'Saved', failed: 'Failed', conflicted: 'Conflict', blocked: 'Blocked', cancelled: 'Cancelled', unknown: 'Needs review'
  };
  return labels[state];
}
