import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useProjectActivity } from '@/features/project-activity/model/use-project-activity';
import type { AiRunActivityFilter, AiRunActivityItem, AiRunActivityUsage } from '@/entities/ai-run/model/activity-types';
import { Alert, Button, Card, Spinner } from '@/shared/ui';

const FILTER_OPTIONS: readonly { readonly value: AiRunActivityFilter; readonly label: string }[] = [
  { value: 'all', label: 'All activity' },
  { value: 'active', label: 'In progress' },
  { value: 'succeeded', label: 'Completed' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rejected', label: 'Not approved' }
];

export function ProjectActivityPanel({ projectId, archived }: { readonly projectId: string; readonly archived: boolean }): React.JSX.Element {
  const [filter, setFilter] = useState<AiRunActivityFilter>('all');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const activity = useProjectActivity(projectId, filter);

  return (
    <section className="project-activity-panel" data-testid="project-activity-panel" aria-label="Run activity">
      {archived && <Alert tone="info" data-testid="project-activity-archived">This project is archived. Activity is available as read only history.</Alert>}
      <div className="project-activity-toolbar">
        <div>
          <label htmlFor="activity-filter">Show</label>
          <select id="activity-filter" data-testid="activity-filter" value={filter} onChange={(event) => { setExpandedRunId(null); setFilter(event.currentTarget.value as AiRunActivityFilter); }}>
            {FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <Button type="button" variant="secondary" data-testid="activity-refresh" onClick={() => { void activity.reload(); }}>Refresh</Button>
      </div>

      {activity.status === 'loading' && <div className="project-activity-loading" aria-busy="true"><Spinner label="Loading activity" /><span role="status">Loading activity…</span></div>}
      {activity.status === 'error' && <Alert tone="error" role="alert" data-testid="activity-error"><strong>Activity could not be loaded.</strong><p>Try again. Your project and filter selection will stay the same.</p><Button type="button" variant="secondary" data-testid="activity-retry" onClick={() => { void activity.reload(); }}>Try again</Button></Alert>}
      {activity.status === 'success' && activity.items.length === 0 && (
        <Card className="project-activity-empty" data-testid="activity-empty">
          <h2>{filter === 'all' ? 'No run activity yet' : 'No activity matches this filter'}</h2>
          <p>{filter === 'all' ? 'Runs created for this project will appear here.' : 'Choose another filter to see more of this project’s history.'}</p>
        </Card>
      )}
      {activity.status === 'success' && activity.items.length > 0 && (
        <ol className="project-activity-list" aria-label="Project AI runs">
          {activity.items.map((item) => <ActivityCard key={item.runId} item={item} expanded={expandedRunId === item.runId} detailState={activity.details[item.runId]} onToggle={() => {
            const next = expandedRunId === item.runId ? null : item.runId;
            setExpandedRunId(next);
            if (next) void activity.loadDetail(next);
          }} onRetryDetail={() => { void activity.loadDetail(item.runId); }} />)}
        </ol>
      )}
      {activity.loadMoreError !== null && <Alert tone="error" role="alert" data-testid="activity-load-more-error"><p>The next page could not be loaded.</p><Button type="button" variant="secondary" data-testid="activity-load-more-retry" onClick={() => { void activity.loadMore(); }}>Try again</Button></Alert>}
      {activity.nextCursor && <div className="project-activity-more"><Button type="button" variant="secondary" data-testid="activity-load-more" disabled={activity.loadingMore} onClick={() => { void activity.loadMore(); }}>{activity.loadingMore ? 'Loading more…' : 'Load more'}</Button></div>}
      {activity.loadMoreAnnouncement && activity.loadMoreError === null && <p className="project-activity-live-status" data-testid="activity-load-more-status" role="status" aria-live="polite">{activity.loadMoreAnnouncement}</p>}
      {activity.status === 'success' && !activity.nextCursor && activity.items.length > 0 && <p className="project-activity-end" role="status">You’re up to date.</p>}
    </section>
  );
}

function ActivityCard({ item, expanded, detailState, onToggle, onRetryDetail }: {
  readonly item: AiRunActivityItem;
  readonly expanded: boolean;
  readonly detailState?: { readonly status: string; readonly detail: import('@/entities/ai-run/model/activity-types').AiRunActivityDetail | null; readonly error: unknown | null };
  readonly onToggle: () => void;
  readonly onRetryDetail: () => void;
}): React.JSX.Element {
  return (
    <li>
      <Card className="project-activity-card" data-testid={`activity-run-${item.runId}`}>
        <header className="project-activity-card-header">
          <div>
            <p className="product-label">{item.provider} · {item.model}</p>
            <h2>{item.requestPreview || 'Run without a request preview'}</h2>
            <p className="project-activity-date"><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></p>
          </div>
          <span className={`project-activity-status status-${item.status}`}>{formatStatus(item.status)}</span>
        </header>
        <dl className="project-activity-facts">
          <div><dt>Execution authorization</dt><dd>{formatStatus(item.decision)}</dd></div>
          <div><dt>Provider transmission</dt><dd>{formatTransmission(item.providerTransmission)}</dd></div>
          <div><dt>Context</dt><dd>{item.context.fileCount} files · {item.context.factCount} facts · {item.context.messageCount} messages</dd></div>
          <div><dt>Estimated context</dt><dd>{formatTokens(item.context.estimatedTokens)} tokens (estimate)</dd></div>
        </dl>
        <div className="project-activity-usage">
          <h3>Provider usage</h3>
          <UsageSummary usage={item.usage} />
          <p className="project-activity-cost">Cost: {item.cost.label}</p>
        </div>
        {item.changeSet && <p className="project-activity-change-summary">File changes: {formatStatus(item.changeSet.status)} · {item.changeSet.operationCount} operations · {item.changeSet.appliedCount} applied · {item.changeSet.failedCount} failed</p>}
        <div className="project-activity-actions">
          <Button type="button" variant="secondary" aria-expanded={expanded} aria-controls={`activity-detail-${item.runId}`} data-testid={`activity-details-${item.runId}`} onClick={onToggle}>{expanded ? 'Hide details' : 'View details'}</Button>
          <Link to={`/projects/${encodeURIComponent(item.projectId)}/conversations/${encodeURIComponent(item.conversationId)}`}>Open conversation</Link>
          {isUnresolvedRun(item.status) ? <Link data-testid={`activity-review-run-${item.runId}`} to={`/projects/${encodeURIComponent(item.projectId)}/conversations/${encodeURIComponent(item.conversationId)}?runId=${encodeURIComponent(item.runId)}`}>Review run</Link> : null}
        </div>
        {expanded && <div id={`activity-detail-${item.runId}`} className="project-activity-detail" data-testid={`activity-detail-${item.runId}`}>
          {detailState?.status === 'loading' && <div className="project-activity-loading" aria-busy="true"><Spinner label="Loading run details" /><span role="status">Loading run details…</span></div>}
          {detailState?.status === 'error' && <Alert tone="error" role="alert"><p>Run details could not be loaded.</p><Button type="button" variant="secondary" onClick={onRetryDetail}>Try again</Button></Alert>}
          {detailState?.detail && <RunDetails detail={detailState.detail} />}
        </div>}
      </Card>
    </li>
  );
}

function UsageSummary({ usage }: { readonly usage: AiRunActivityUsage }): React.JSX.Element {
  const statusLabel: Record<AiRunActivityUsage['status'], string> = {
    reported: 'Reported by provider',
    partial: 'Partial provider report',
    not_reported: 'Not reported by provider',
    not_transmitted: 'Not transmitted',
    unknown: 'Unknown',
    unavailable: 'Unavailable'
  };
  return <>
    <p>{statusLabel[usage.status]}</p>
    <p>Prompt: {formatNullableTokens(usage.promptTokens)} · Completion: {formatNullableTokens(usage.completionTokens)} · Total: {formatNullableTokens(usage.totalTokens)}</p>
  </>;
}

function RunDetails({ detail }: { readonly detail: import('@/entities/ai-run/model/activity-types').AiRunActivityDetail }): React.JSX.Element {
  return <div className="project-activity-details-content">
    <section>
      <h3>Request and response</h3>
      <p><strong>Request:</strong> {detail.requestPreview || 'No request preview available.'}</p>
      <p><strong>Assistant:</strong> {detail.assistantPreview || 'No assistant response was saved.'}</p>
    </section>
    <section>
      <h3>Selected context</h3>
      <p>Categories: {detail.context.categories.join(', ') || 'None recorded'}</p>
      <h4>Files</h4>
      {detail.selectedFiles.length === 0 ? <p>No project files were selected.</p> : <ul>{detail.selectedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
      <h4>Project facts</h4>
      {detail.selectedFactTitles.length === 0 ? <p>No project facts were selected.</p> : <ul>{detail.selectedFactTitles.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}</ul>}
    </section>
    <section>
      <h3>File operations</h3>
      {detail.operations.length === 0 ? <p>No file changes were proposed for this run.</p> : <ul className="project-activity-operations">{detail.operations.map((operation, index) => <li key={`${operation.operation}-${operation.path}-${index}`}><strong>{formatStatus(operation.operation)}</strong> <code>{operation.path}</code><span>{formatStatus(operation.outcome)} · backup {formatStatus(operation.backupStatus)}</span></li>)}</ul>}
      {detail.operations.map((operation, index) => <p key={`history-${operation.path}-${index}`}><Link to={`/projects/${encodeURIComponent(detail.projectId)}/file-history?path=${encodeURIComponent(operation.path)}`}>View file history for {operation.path}</Link>{operation.destinationPath ? <> · <Link to={`/projects/${encodeURIComponent(detail.projectId)}/file-history?path=${encodeURIComponent(operation.destinationPath)}`}>View file history for {operation.destinationPath}</Link></> : null}</p>)}
      {detail.omittedOperationCount > 0 && <p>{detail.omittedOperationCount} additional operations are not shown.</p>}
    </section>
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function formatNullableTokens(value: number | null): string {
  return value === null ? 'Not available' : formatTokens(value);
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatTransmission(value: AiRunActivityItem['providerTransmission']): string {
  if (value === 'not_started' || value === 'not_started_confirmed') return 'Not transmitted';
  if (value === 'transmitted_confirmed') return 'Transmitted';
  return 'Unknown';
}

function isUnresolvedRun(status: AiRunActivityItem['status']): boolean {
  return ['pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested', 'review_required'].includes(status);
}
