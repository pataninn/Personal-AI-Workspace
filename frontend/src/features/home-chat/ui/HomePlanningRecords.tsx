import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HomeConversationScope, HomeProposal, HomeProposalCommand, HomeProposalItem } from '@/entities/home-conversation';
import { selectProjects } from '@/entities/project';
import { useAppSelector } from '@/app/store/hooks';
import { Alert, Button, Card, Input, Label, Textarea } from '@/shared/ui';

import type { HomePlanningRecordsController, HomeReceiptCardState, HomeProposalCardState } from '../model/use-home-planning-records';
import { hasProposalReceipt, proposalCanResume } from '../model/use-home-planning-records';

interface HomePlanningRecordsProps {
  readonly records: HomePlanningRecordsController;
  readonly turnId: string | null;
  readonly scope: HomeConversationScope;
}

/** Render inside HomeChat after an assistant turn to show only that turn's persisted planning records. */
export function HomePlanningRecords({ records, turnId, scope }: HomePlanningRecordsProps): React.JSX.Element {
  const receipts = records.receipts.filter((receipt) => receipt.turnId === turnId);
  const proposals = records.proposals.filter((proposal) => proposal.proposal.sourceTurnId === turnId);
  return <div className="home-planning-records">
    {receipts.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt} onRefresh={records.refreshReceipt} onUndo={records.undoReceipt} />)}
    {proposals.map((proposal) => <ProposalCard key={proposal.proposal.id} record={proposal} scope={scope} onRetry={() => { records.retryProposals(); void records.refreshEvents(); }} onEdit={records.editItem} onRemove={records.removeItem}
      onAccept={records.acceptProposal} onResume={records.resumeProposal} onCancel={records.cancelProposal} />)}
  </div>;
}

/** Render once after HomeChat history for persisted records whose source turns are not displayed. */
export function UnattachedHomePlanningRecords({ records, scope, displayedTurnIds }: {
  readonly records: HomePlanningRecordsController;
  readonly scope: HomeConversationScope;
  readonly displayedTurnIds: ReadonlySet<string>;
}): React.JSX.Element {
  const orphanedProposals = records.proposals.filter((item) => !displayedTurnIds.has(item.proposal.sourceTurnId));
  const orphanedReceipts = records.receipts.filter((item) => !item.turnId || !displayedTurnIds.has(item.turnId));
  if (records.proposalsState === 'error' && records.proposals.length === 0) return <Alert tone="warning" data-testid="home-proposals-load-error">
    {records.proposalsError ?? 'Saved planning previews could not be loaded.'} <Button type="button" variant="secondary" data-testid="home-proposals-retry" onClick={() => { records.retryProposals(); }}>Retry previews</Button>
  </Alert>;
  if (!orphanedProposals.length && !orphanedReceipts.length) return <></>;
  return <section className="home-planning-records" aria-label="Saved planning actions from earlier history">
    {orphanedReceipts.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt} onRefresh={records.refreshReceipt} onUndo={records.undoReceipt} />)}
    {orphanedProposals.map((proposal) => <ProposalCard key={proposal.proposal.id} record={proposal} scope={scope} onRetry={() => { records.retryProposals(); void records.refreshEvents(); }} onEdit={records.editItem} onRemove={records.removeItem}
      onAccept={records.acceptProposal} onResume={records.resumeProposal} onCancel={records.cancelProposal} />)}
  </section>;
}

function ReceiptCard({
  receipt,
  onRefresh,
  onUndo
}: {
  readonly receipt: HomeReceiptCardState;
  readonly onRefresh: (receiptId: string) => Promise<void>;
  readonly onUndo: (receiptId: string) => Promise<void>;
}): React.JSX.Element {
  const task = receipt.target && 'task' in receipt.target ? receipt.target.task : null;
  const workspace = receipt.target && !('task' in receipt.target) ? receipt.target : null;
  const targetName = task?.title ?? workspace?.name;
  const targetHref = task ? `/tasks/${encodeURIComponent(task.id)}` : workspace ? `/projects/${encodeURIComponent(workspace.id)}` : null;
  return <Card className="home-receipt-card" id={`home-receipt-${receipt.id}`} data-testid={`home-receipt-card-${receipt.id}`}>
    <div className="home-record-heading"><h3>Saved action</h3><span className="home-record-state">{receipt.state === 'loading' ? 'Checking receipt…' : receipt.receipt?.undoStatus === 'undone' ? 'Undo completed' : receipt.receipt?.undoStatus === 'not_reversible' ? 'Saved' : receipt.receipt?.undoStatus === 'available' ? 'Saved' : ''}</span></div>
    {receipt.state === 'error' ? <Alert tone="warning" data-testid={`home-receipt-error-${receipt.id}`}>
      The saved receipt could not be checked. <Button type="button" variant="secondary" data-testid={`home-receipt-refresh-${receipt.id}`} onClick={() => { void onRefresh(receipt.id); }}>Refresh receipt</Button>
    </Alert> : null}
    {receipt.receipt ? <p className="home-record-description">{targetName && targetHref ? <><span>{receipt.receipt.actionKind.replaceAll('.', ' ')}: </span><Link to={targetHref} data-testid={`home-receipt-target-${receipt.id}`}>{targetName}</Link></> : receipt.targetUnavailable ? 'The saved target is unavailable.' : receipt.state === 'loading' ? 'Checking the current target.' : 'The current target has not been loaded.'}</p> : null}
    {receipt.undoError ? <Alert tone={receipt.conflictReason ? 'warning' : 'error'} role={receipt.conflictReason ? undefined : 'alert'} data-testid={`home-receipt-undo-conflict-${receipt.id}`}>
      {receipt.undoError}
    </Alert> : null}
    {receipt.state === 'ready' ? <>
      {receipt.receipt?.undoStatus === 'available' ? <div className="home-record-actions">
        {!receipt.conflictReason ? <Button type="button" variant="secondary" data-testid={receipt.undoError ? `home-receipt-retry-${receipt.id}` : `home-receipt-undo-${receipt.id}`} disabled={receipt.undoPending} aria-busy={receipt.undoPending} onClick={() => { void onUndo(receipt.id); }}>
          {receipt.undoPending ? 'Undoing…' : receipt.undoError ? 'Retry undo' : 'Undo'}
        </Button> : null}
        <Button type="button" variant="ghost" data-testid={`home-receipt-refresh-${receipt.id}`} disabled={receipt.undoPending} onClick={() => { void onRefresh(receipt.id); }}>Refresh receipt</Button>
      </div> : null}
      {receipt.receipt?.undoStatus === 'not_reversible' ? <p className="home-record-description">Undo is unavailable for this saved action.</p> : null}
      {receipt.receipt?.undoStatus === 'undone' ? <p className="home-record-description">Undo completed. The current target remains available above when it still exists.</p> : null}
    </> : null}
  </Card>;
}

interface ProposalCardProps {
  readonly record: HomeProposalCardState;
  readonly scope: HomeConversationScope;
  readonly onRetry: () => void;
  readonly onEdit: (proposalId: string, itemId: string, changes: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly onRemove: (proposalId: string, itemId: string) => Promise<void>;
  readonly onAccept: (proposalId: string) => Promise<void>;
  readonly onResume: (proposalId: string) => Promise<void>;
  readonly onCancel: (proposalId: string) => Promise<void>;
}

function ProposalCard({ record, scope, onRetry, onEdit, onRemove, onAccept, onResume, onCancel }: ProposalCardProps): React.JSX.Element {
  const proposal = record.proposal;
  const reviewable = proposal.state === 'review_required';
  const cancellable = ['accepted', 'executing', 'partial', 'unknown'].includes(proposal.state) && proposal.items.some((item) => ['ready', 'executing', 'unknown'].includes(item.state) && item.receiptId === null);
  const hasReceipt = proposal.items.some(hasProposalReceipt);
  return <Card className="home-proposal-card" data-testid={`home-proposal-card-${proposal.id}`} aria-busy={record.busy}>
    <div className="home-record-heading"><h3>{reviewable ? 'Review proposed changes' : 'Planning results'}</h3><span className="home-record-state">{proposalStateLabel(proposal.state)}</span></div>
    {reviewable ? <p className="home-record-description">Nothing is saved until you apply these changes.</p> : null}
    {record.error ? <Alert tone="warning" data-testid={`home-proposal-error-${proposal.id}`}>
      {record.error} <Button type="button" variant="secondary" data-testid={`home-proposal-refresh-${proposal.id}`} onClick={onRetry}>Refresh preview</Button>
    </Alert> : null}
    {record.message ? <p role="status" aria-live="polite" data-testid={`home-proposal-status-${proposal.id}`}>{record.message}</p> : null}
    {proposal.items.length === 0 ? <p className="home-record-description">No changes to apply.</p> : <ol className="home-proposal-items">
      {proposal.items.map((item) => <ProposalItemRow key={item.id} proposal={proposal} item={item} itemError={record.itemError?.itemId === item.id ? record.itemError.message : null} scope={scope} busy={record.busy} editable={reviewable} onEdit={onEdit} onRemove={onRemove} />)}
    </ol>}
    {reviewable ? <div className="home-record-actions">
      <Button type="button" data-testid={`home-proposal-accept-${proposal.id}`} disabled={record.busy || proposal.items.length === 0} aria-busy={record.busy} onClick={() => { void onAccept(proposal.id); }}>Apply these changes</Button>
      <span className="field-help">Continue editing or remove items before applying.</span>
    </div> : null}
    {!reviewable && proposalCanResume(proposal) ? <div className="home-record-actions">
      <Button type="button" variant="secondary" data-testid={`home-proposal-resume-${proposal.id}`} disabled={record.busy} aria-busy={record.busy} onClick={() => { void onResume(proposal.id); }}>Resume eligible changes</Button>
    </div> : null}
    {cancellable ? <div className="home-record-actions"><Button type="button" variant="secondary" data-testid={`home-proposal-cancel-${proposal.id}`} disabled={record.busy} onClick={() => { void onCancel(proposal.id); }}>Cancel remaining changes</Button></div> : null}
    {hasReceipt ? <p className="home-record-description">Saved results are linked by receipt below each item.</p> : null}
  </Card>;
}

interface ProposalDraft {
  readonly title: string;
  readonly details: string;
  readonly importance: string;
  readonly deadline: string;
  readonly workspaceId: string;
  readonly subtasks: string;
  readonly name: string;
  readonly objective: string;
  readonly status: string;
}

function proposalDraft(command: HomeProposalCommand): ProposalDraft {
  const isTask = command.action === 'task.create' || command.action === 'task.update';
  const subtasks = command.action === 'task.create' || command.action === 'task.update' ? command.subtasks ?? [] : [];
  return {
    title: isTask ? command.title ?? '' : '',
    details: isTask ? command.details ?? '' : '',
    importance: isTask ? command.importance ?? (command.action === 'task.update' ? '' : 'medium') : 'medium',
    deadline: isTask ? command.deadline ?? '' : '',
    workspaceId: command.action === 'task.create' || command.action === 'task.move' ? command.workspaceId ?? '' : '',
    subtasks: subtasks.map((item) => item.title).join('\n'),
    name: command.action === 'workspace.create' ? command.name : '',
    objective: command.action === 'workspace.create' || command.action === 'workspace.update_objective' ? command.objective ?? '' : '',
    status: command.action === 'task.update' ? command.status ?? '' : ''
  };
}

function ProposalItemRow({ proposal, item, itemError, scope, busy, editable, onEdit, onRemove }: {
  readonly proposal: HomeProposal;
  readonly item: HomeProposalItem;
  readonly itemError: string | null;
  readonly scope: HomeConversationScope;
  readonly busy: boolean;
  readonly editable: boolean;
  readonly onEdit: ProposalCardProps['onEdit'];
  readonly onRemove: ProposalCardProps['onRemove'];
}): React.JSX.Element {
  const projects = useAppSelector(selectProjects);
  const originalDraft = useMemo(() => proposalDraft(item.command), [item.command]);
  const [draft, setDraft] = useState<ProposalDraft>(originalDraft);
  const lastRevision = useRef(proposal.revision);
  useEffect(() => {
    if (proposal.revision !== lastRevision.current && !itemError) setDraft(originalDraft);
    lastRevision.current = proposal.revision;
  }, [itemError, originalDraft, proposal.revision]);
  const idPrefix = `home-proposal-${item.id}`;
  const canEdit = editable && item.action !== 'task.archive';
  const commandChanges = useMemo(() => buildCommandChanges(item.command, draft), [draft, item.command]);
  const dirty = Object.keys(commandChanges).length > 0;
  const activeProjects = projects.filter((project) => project.status === 'active' && project.workspaceMode !== 'file_backed');
  const currentWorkspaceId = scope.kind === 'workspace' ? scope.workspaceId : '';
  const destinations = scope.kind === 'workspace' ? activeProjects.filter((project) => project.id === currentWorkspaceId) : activeProjects;
  return <li className="home-proposal-item" data-testid={`home-proposal-item-${item.id}`}>
    <div className="home-record-heading"><strong>{proposalActionLabel(item.command)}</strong><span className="home-record-state">{proposalItemStateLabel(item.state)}</span></div>
    {canEdit ? <fieldset className="home-proposal-fields" disabled={busy}>
      <legend>Edit this proposed item</legend>
      {item.command.action === 'task.create' || (item.command.action === 'task.update' && item.command.status === undefined) ? <>
        <Field id={`${idPrefix}-title`} label="Task title"><Input id={`${idPrefix}-title`} data-testid={`${idPrefix}-title`} value={draft.title} onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))} /></Field>
        <Field id={`${idPrefix}-details`} label="Details"><Textarea id={`${idPrefix}-details`} data-testid={`${idPrefix}-details`} rows={2} value={draft.details} onChange={(event) => setDraft((previous) => ({ ...previous, details: event.target.value }))} /></Field>
        <div className="home-proposal-field-pair">
          <Field id={`${idPrefix}-importance`} label="Importance"><select id={`${idPrefix}-importance`} data-testid={`${idPrefix}-importance`} className="input" value={draft.importance} onChange={(event) => setDraft((previous) => ({ ...previous, importance: event.target.value }))}>{item.command.action === 'task.update' && item.command.importance === undefined ? <option value="">Leave unchanged</option> : null}<option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field>
          <Field id={`${idPrefix}-deadline`} label="Deadline date (YYYY-MM-DD)"><Input id={`${idPrefix}-deadline`} data-testid={`${idPrefix}-deadline`} type="date" value={draft.deadline} onChange={(event) => setDraft((previous) => ({ ...previous, deadline: event.target.value }))} /></Field>
        </div>
        <Field id={`${idPrefix}-subtasks`} label="Checklist (one item per line)"><Textarea id={`${idPrefix}-subtasks`} data-testid={`${idPrefix}-subtasks`} rows={2} value={draft.subtasks} onChange={(event) => setDraft((previous) => ({ ...previous, subtasks: event.target.value }))} /></Field>
        {item.command.action === 'task.create' ? <Field id={`${idPrefix}-workspace`} label="Destination workspace"><select id={`${idPrefix}-workspace`} data-testid={`${idPrefix}-workspace`} className="input" value={draft.workspaceId} onChange={(event) => setDraft((previous) => ({ ...previous, workspaceId: event.target.value }))}>
          {scope.kind === 'home' ? <option value="">Inbox</option> : null}{destinations.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></Field> : null}
        {draft.deadline ? <p className="field-help">{deadlineLabel(item, draft.deadline, draft.deadline === (item.command.action === 'task.create' || item.command.action === 'task.update' ? item.command.deadline ?? '' : ''))}</p> : null}
      </> : null}
      {item.command.action === 'task.update' && item.command.status !== undefined ? <Field id={`${idPrefix}-status`} label="Status"><select id={`${idPrefix}-status`} data-testid={`${idPrefix}-status`} className="input" value={draft.status} onChange={(event) => setDraft((previous) => ({ ...previous, status: event.target.value }))}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></Field> : null}
      {item.command.action === 'task.move' ? <Field id={`${idPrefix}-workspace`} label="Destination workspace"><select id={`${idPrefix}-workspace`} data-testid={`${idPrefix}-workspace`} className="input" value={draft.workspaceId} onChange={(event) => setDraft((previous) => ({ ...previous, workspaceId: event.target.value }))}>
        {scope.kind === 'home' ? <option value="">Inbox</option> : null}{destinations.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></Field> : null}
      {item.command.action === 'workspace.create' ? <>
        <Field id={`${idPrefix}-name`} label="Workspace name"><Input id={`${idPrefix}-name`} data-testid={`${idPrefix}-name`} value={draft.name} onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))} /></Field>
        <Field id={`${idPrefix}-objective`} label="Objective"><Textarea id={`${idPrefix}-objective`} data-testid={`${idPrefix}-objective`} rows={2} value={draft.objective} onChange={(event) => setDraft((previous) => ({ ...previous, objective: event.target.value }))} /></Field>
      </> : null}
      {item.command.action === 'workspace.update_objective' ? <Field id={`${idPrefix}-objective`} label="Objective"><Textarea id={`${idPrefix}-objective`} data-testid={`${idPrefix}-objective`} rows={2} value={draft.objective} onChange={(event) => setDraft((previous) => ({ ...previous, objective: event.target.value }))} /></Field> : null}
    </fieldset> : <p className="home-record-description">{proposalCommandSummary(item.command)}</p>}
    {itemError ? <Alert tone="error" role="alert" data-testid={`home-proposal-item-error-${item.id}`}>{itemError}</Alert> : null}
    {!editable && item.resultCode ? <p className="home-record-description">Result: {item.resultCode}</p> : null}
    {item.command.action === 'task.create' || item.command.action === 'task.update' ? item.command.deadline ? <p className="home-record-description">{deadlineLabel(item, item.command.deadline, true)}</p> : null : null}
    {item.receiptId ? <p className="home-record-description" data-testid={`home-proposal-item-outcome-${item.id}`}>{item.state === 'saved' ? 'Saved' : proposalItemStateLabel(item.state)} · <Link to={`#home-receipt-${item.receiptId}`} data-testid={`home-proposal-receipt-${item.id}`}>View saved receipt</Link></p> : !editable ? <p className="home-record-description" data-testid={`home-proposal-item-outcome-${item.id}`}>{proposalItemStateLabel(item.state)}{item.resultCode ? ` · ${item.resultCode}` : ''}</p> : null}
    {editable ? <div className="home-record-actions">
      {canEdit ? <Button type="button" variant="secondary" data-testid={`home-proposal-edit-${item.id}`} disabled={busy || !dirty} onClick={() => { void onEdit(proposal.id, item.id, commandChanges); }}>Save item</Button> : null}
      <Button type="button" variant="ghost" data-testid={`home-proposal-remove-${item.id}`} disabled={busy} onClick={() => { void onRemove(proposal.id, item.id); }}>Remove from plan</Button>
    </div> : null}
  </li>;
}

function Field({ id, label, children }: { readonly id: string; readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="home-proposal-field"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

function buildCommandChanges(command: HomeProposalCommand, draft: ProposalDraft): Readonly<Record<string, unknown>> {
  switch (command.action) {
    case 'task.create': return {
      ...(draft.title !== command.title ? { title: draft.title } : {}),
      ...(draft.details !== (command.details ?? '') ? { details: draft.details || null } : {}),
      ...(draft.importance !== command.importance ? { importance: draft.importance } : {}),
      ...(draft.deadline !== (command.deadline ?? '') ? { deadline: draft.deadline || null } : {}),
      ...(draft.workspaceId !== (command.workspaceId ?? '') ? { workspaceId: draft.workspaceId || null } : {}),
      ...(draft.subtasks !== command.subtasks.map((item) => item.title).join('\n') ? { subtasks: draft.subtasks.split('\n').map((title) => ({ title: title.trim() })).filter((item) => item.title) } : {})
    };
    case 'task.update': return command.status !== undefined ? (draft.status !== command.status ? { status: draft.status } : {}) : {
      ...(draft.title !== (command.title ?? '') ? { title: draft.title } : {}),
      ...(draft.details !== (command.details ?? '') ? { details: draft.details || null } : {}),
      ...(draft.importance !== (command.importance ?? '') ? { importance: draft.importance } : {}),
      ...(draft.deadline !== (command.deadline ?? '') ? { deadline: draft.deadline || null } : {}),
      ...(draft.subtasks !== (command.subtasks ?? []).map((item) => item.title).join('\n') ? { subtasks: draft.subtasks.split('\n').map((title, index) => ({ ...(command.subtasks?.[index] ? { id: command.subtasks[index].id } : {}), title: title.trim(), completed: command.subtasks?.[index]?.completed ?? false })).filter((item) => item.title) } : {})
    };
    case 'task.move': return draft.workspaceId !== (command.workspaceId ?? '') ? { workspaceId: draft.workspaceId || null } : {};
    case 'workspace.create': return {
      ...(draft.name !== command.name ? { name: draft.name } : {}),
      ...(draft.objective !== (command.objective ?? '') ? { objective: draft.objective || null } : {})
    };
    case 'workspace.update_objective': return draft.objective !== (command.objective ?? '') ? { objective: draft.objective || null } : {};
    case 'task.archive': return {};
  }
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

function deadlineLabel(item: HomeProposalItem, date: string, originalValue: boolean): string {
  const resolution = originalValue ? item.deadlineResolution : null;
  if (!resolution) return `Resolved date: ${date}`;
  return resolution.source === 'utc-fallback'
    ? `Resolved date: ${date} · UTC (fallback)`
    : `Resolved date: ${date} · ${resolution.timeZone}`;
}

function proposalStateLabel(state: HomeProposal['state']): string {
  const labels: Record<HomeProposal['state'], string> = {
    review_required: 'Review required', accepted: 'Accepted', executing: 'In progress', partial: 'Partially completed', completed: 'Completed', cancelled: 'Cancelled', unknown: 'Needs review'
  };
  return labels[state];
}

function proposalItemStateLabel(state: HomeProposalItem['state']): string {
  const labels: Record<HomeProposalItem['state'], string> = {
    ready: 'Ready to apply', executing: 'In progress', saved: 'Saved', failed: 'Failed', conflicted: 'Conflict', blocked: 'Blocked', cancelled: 'Cancelled', unknown: 'Needs review'
  };
  return labels[state];
}
