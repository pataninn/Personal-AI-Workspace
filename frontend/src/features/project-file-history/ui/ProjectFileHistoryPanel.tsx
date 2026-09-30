import { Link } from 'react-router-dom';

import type { ProjectFileHistoryItem, ProjectFileHistoryOutcome } from '@/entities/ai-run';
import { useProjectFileHistory } from '@/features/project-file-history/model/use-project-file-history';
import { Alert, Button, Card, EmptyState, ErrorState, Skeleton, Spinner } from '@/shared/ui';

export function ProjectFileHistoryPanel({ projectId, path, outcome, archived, onOutcomeChange }: {
  readonly projectId: string;
  readonly path: string;
  readonly outcome: ProjectFileHistoryOutcome;
  readonly archived: boolean;
  readonly onOutcomeChange: (outcome: ProjectFileHistoryOutcome) => void;
}): React.JSX.Element {
  const history = useProjectFileHistory(projectId, path, outcome);
  return <section className="project-file-history" data-testid="project-file-history" aria-label="File history">
    {archived ? <Alert tone="info" data-testid="file-history-archived">This project is archived. File history remains available as read only history.</Alert> : null}
    <div className="project-file-history-toolbar">
      <div><span>File</span><code data-testid="file-history-path">{path}</code></div>
      <label htmlFor="file-history-outcome">Show
        <select id="file-history-outcome" data-testid="file-history-outcome-filter" value={outcome} onChange={(event) => onOutcomeChange(event.currentTarget.value as ProjectFileHistoryOutcome)}>
          <option value="all">All proposals and outcomes</option>
          <option value="applied">Applied only</option>
        </select>
      </label>
      <Button type="button" variant="secondary" data-testid="file-history-refresh" onClick={() => { void history.reload(); }}>Refresh</Button>
    </div>
    {history.status === 'loading' ? <div aria-busy="true" className="project-file-history-loading"><Spinner label="Loading file history" /><span role="status">Loading file history…</span><Card><Skeleton /><Skeleton /></Card></div> : null}
    {history.status === 'error' ? <ErrorState title="File history unavailable" detail="The project history could not be loaded. Try again." testId="file-history-error" action={<Button type="button" variant="secondary" data-testid="file-history-retry" onClick={() => { void history.reload(); }}>Try again</Button>} /> : null}
    {history.status === 'success' && history.items.length === 0 ? <Card className="project-file-history-empty" data-testid="file-history-empty"><EmptyState title="No file history for this path" detail={outcome === 'applied' ? 'No applied operations were recorded for this path.' : 'Proposals and outcomes that mention this path will appear here.'} /></Card> : null}
    {history.status === 'success' && history.items.length > 0 ? <ol className="project-file-history-list" data-testid="file-history-list" aria-label="File proposals and outcomes">
      {history.items.map((item) => <HistoryEntry key={`${item.changeSetId}:${item.operationIndex}`} item={item} />)}
    </ol> : null}
    {history.moreError !== null ? <Alert tone="error" role="alert" data-testid="file-history-more-error"><p>More file history could not be loaded.</p><Button type="button" variant="secondary" data-testid="file-history-retry" onClick={() => { void history.loadMore(); }}>Try again</Button></Alert> : null}
    {history.nextCursor ? <div className="project-file-history-more"><Button type="button" variant="secondary" data-testid="file-history-load-more" disabled={history.loadingMore} onClick={() => { void history.loadMore(); }}>{history.loadingMore ? 'Loading more…' : 'Load more'}</Button></div> : null}
    {history.announcement && history.moreError === null ? <p className="project-file-history-live" role="status" aria-live="polite">{history.announcement}</p> : null}
  </section>;
}

function HistoryEntry({ item }: { readonly item: ProjectFileHistoryItem }): React.JSX.Element {
  const conversationHref = item.conversationId ? `/projects/${encodeURIComponent(item.projectId)}/conversations/${encodeURIComponent(item.conversationId)}` : null;
  return <li data-testid="file-history-item"><Card className="project-file-history-entry" data-testid="file-history-entry">
    <header><div><h2>{operationLabel(item.operation)} <code>{item.matchedPath}</code></h2><p>{item.summary || 'No summary recorded.'}</p></div><span className={`project-file-history-status status-${item.changeSetStatus}`}>{formatStatus(item.changeSetStatus)}</span></header>
    <dl><div><dt>Proposal outcome</dt><dd>{formatStatus(item.changeSetStatus)}</dd></div><div><dt>Operation outcome</dt><dd>{item.operationStatus ? formatStatus(item.operationStatus) : 'No operation result recorded'}</dd></div><div><dt>Recovery snapshot</dt><dd>{formatStatus(item.backupStatus)}</dd></div><div><dt>Proposed</dt><dd><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></dd></div><div><dt>Recorded</dt><dd><time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time></dd></div></dl>
    {item.destinationPath ? <p className="project-file-history-destination">Destination: <code>{item.destinationPath}</code></p> : null}
    {conversationHref ? <Link to={conversationHref}>Open the related conversation</Link> : <span>Conversation link unavailable</span>}
  </Card></li>;
}

function operationLabel(operation: ProjectFileHistoryItem['operation']): string {
  return { create: 'Create', edit: 'Edit', overwrite: 'Replace', rename: 'Rename', delete: 'Delete' }[operation];
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
