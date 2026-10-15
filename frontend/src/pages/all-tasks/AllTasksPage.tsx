import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { selectProjectListStatus, selectProjects } from '@/entities/project';
import { useGlobalTaskQuery, type GlobalTaskQuery } from '@/entities/project-task';
import { useAppSelector } from '@/app/store/hooks';
import { useProjectListLoader } from '@/features/project-management';
import { GlobalTaskFilters, GlobalTaskList, type GlobalTaskFilterDraft } from '@/features/global-task-query';
import { Alert, Button } from '@/shared/ui';

const DEFAULT_FILTERS: GlobalTaskFilterDraft = {
  collection: 'all', status: 'all', importance: 'all', deadlineFrom: '', deadlineTo: '', q: '', includeArchived: false
};

export function AllTasksPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const { retry: retryWorkspaces } = useProjectListLoader();
  const projectListStatus = useAppSelector(selectProjectListStatus);
  const projects = useAppSelector(selectProjects).filter((project) => project.status === 'active');
  const [draft, setDraft] = useState<GlobalTaskFilterDraft>(() => readFilterDraft(new URLSearchParams(searchKey)));
  const query = useMemo(() => makeQuery(readFilterDraft(new URLSearchParams(searchKey))), [searchKey]);
  const tasks = useGlobalTaskQuery(query);

  useEffect(() => { setDraft(readFilterDraft(new URLSearchParams(searchKey))); }, [searchKey]);

  function applyFilters(): void {
    setSearchParams(writeFilterParams(draft));
  }

  function clearFilters(): void {
    setDraft(DEFAULT_FILTERS);
    setSearchParams(new URLSearchParams());
  }

  const heading = query.inboxOnly ? 'Inbox' : query.workspaceId ? projects.find((project) => project.id === query.workspaceId)?.name ?? 'Workspace tasks' : 'All tasks';
  const hasAppliedFilters = Boolean(query.status || query.importance || query.deadlineFrom || query.deadlineTo || query.q || query.includeArchived);
  return <div className="global-tasks-page" data-testid="all-tasks-page">
    <header className="global-tasks-header">
      <div><p className="product-label">Home</p><h1>{heading}</h1><p className="supporting-copy">Find tasks across your Inbox and workspaces.</p></div>
      <nav aria-label="Task collections" className="global-task-collection-nav">
        <Link to="/tasks" aria-current={!query.inboxOnly && !query.workspaceId ? 'page' : undefined}>All tasks</Link>
        <Link to="/tasks?inboxOnly=true" aria-current={query.inboxOnly ? 'page' : undefined}>Inbox</Link>
        <Link to="/dashboard">Home</Link>
      </nav>
    </header>
    {tasks.refreshed ? <Alert tone="info" role="status" data-testid="global-task-refreshed">The list refreshed because its saved position changed.</Alert> : null}
    <GlobalTaskFilters value={draft} projects={projects} workspacesLoading={projectListStatus === 'loading' || projectListStatus === 'idle'}
      workspacesUnavailable={projectListStatus === 'error'} onChange={setDraft} onApply={applyFilters} onClear={clearFilters} onRetryWorkspaces={retryWorkspaces} />
    <GlobalTaskList items={tasks.items} includeArchived={query.includeArchived === true} status={tasks.status} nextCursor={tasks.nextCursor} loadingMore={tasks.loadingMore} loadMoreError={tasks.loadMoreError}
      onLoadMore={() => { void tasks.loadMore(); }} onRetry={() => { void (tasks.loadMoreError ? tasks.loadMore() : tasks.reload()); }} />
    {tasks.status === 'success' && tasks.items.length === 0 ? <section className="global-task-empty" data-testid="global-task-empty" aria-live="polite">
      {hasAppliedFilters ? <><h2>No tasks match these filters</h2><p>Clear filters to see more tasks.</p><Button type="button" variant="secondary" onClick={clearFilters}>Clear filters</Button></>
        : query.inboxOnly ? <><h2>Inbox is empty</h2><p>Capture a task now and sort it later.</p><Link className="button button-secondary" to="/dashboard">Capture a task</Link></>
          : query.workspaceId ? <><h2>No tasks in this workspace yet</h2><p>Tasks added to this workspace will appear here.</p></>
            : <><h2>No tasks yet</h2><p>Capture a task from Home or add one to a workspace.</p><Link className="button button-secondary" to="/dashboard">Go to Home</Link></>}
    </section> : null}
  </div>;
}

function readFilterDraft(params: URLSearchParams): GlobalTaskFilterDraft {
  const workspaceId = params.get('workspaceId');
  const requestedStatus = params.get('status');
  const validStatuses = ['todo', 'in_progress', 'blocked', 'done', 'archived'];
  const requestedImportance = params.get('importance');
  const validImportance = ['low', 'medium', 'high', 'urgent'];
  const status = validStatuses.includes(requestedStatus ?? '') ? requestedStatus as GlobalTaskFilterDraft['status'] : 'all';
  const includeArchived = params.get('includeArchived') === 'true' || status === 'archived';
  return {
    collection: params.get('inboxOnly') === 'true' ? 'inbox' : workspaceId ? `workspace:${workspaceId}` : 'all',
    status,
    importance: validImportance.includes(requestedImportance ?? '') ? requestedImportance as GlobalTaskFilterDraft['importance'] : 'all',
    deadlineFrom: params.get('deadlineFrom') ?? '',
    deadlineTo: params.get('deadlineTo') ?? '',
    q: params.get('q') ?? '',
    includeArchived
  };
}

function makeQuery(filters: GlobalTaskFilterDraft): GlobalTaskQuery {
  const workspaceId = filters.collection.startsWith('workspace:') ? filters.collection.slice('workspace:'.length) : '';
  return {
    ...(filters.collection === 'inbox' ? { inboxOnly: true } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.importance !== 'all' ? { importance: filters.importance } : {}),
    ...(filters.deadlineFrom ? { deadlineFrom: filters.deadlineFrom } : {}),
    ...(filters.deadlineTo ? { deadlineTo: filters.deadlineTo } : {}),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(filters.includeArchived ? { includeArchived: true } : {})
  };
}

function writeFilterParams(filters: GlobalTaskFilterDraft): URLSearchParams {
  const query = makeQuery(filters);
  const params = new URLSearchParams();
  if (query.inboxOnly) params.set('inboxOnly', 'true');
  if (query.workspaceId) params.set('workspaceId', query.workspaceId);
  if (query.status) params.set('status', query.status);
  if (query.importance) params.set('importance', query.importance);
  if (query.deadlineFrom) params.set('deadlineFrom', query.deadlineFrom);
  if (query.deadlineTo) params.set('deadlineTo', query.deadlineTo);
  if (query.q) params.set('q', query.q);
  if (query.includeArchived) params.set('includeArchived', 'true');
  return params;
}
