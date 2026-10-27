import type { FormEvent } from 'react';

import type { ProjectSnapshot } from '@/entities/project';
import type { ProjectTaskImportance, ProjectTaskStatus } from '@/entities/project-task';
import { Button, Input, Label } from '@/shared/ui';

export interface GlobalTaskFilterDraft {
  readonly collection: string;
  readonly status: 'all' | ProjectTaskStatus;
  readonly importance: 'all' | ProjectTaskImportance;
  readonly deadlineFrom: string;
  readonly deadlineTo: string;
  readonly q: string;
  readonly includeArchived: boolean;
}

interface GlobalTaskFiltersProps {
  readonly value: GlobalTaskFilterDraft;
  readonly projects: readonly ProjectSnapshot[];
  readonly workspacesLoading: boolean;
  readonly workspacesUnavailable: boolean;
  readonly onChange: (value: GlobalTaskFilterDraft) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
  readonly onRetryWorkspaces: () => void;
}

export function GlobalTaskFilters({ value, projects, workspacesLoading, workspacesUnavailable, onChange, onApply, onClear, onRetryWorkspaces }: GlobalTaskFiltersProps): React.JSX.Element {
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onApply();
  }

  return <form className="global-task-filters" aria-label="Filter tasks" onSubmit={submit}>
    <div className="global-task-filter-grid">
      <div><Label htmlFor="global-task-collection">Collection</Label><select id="global-task-collection" className="input" value={value.collection} onChange={(event) => { onChange({ ...value, collection: event.currentTarget.value }); }}>
        <option value="all">All tasks</option><option value="inbox">Inbox</option>
        {projects.map((project) => <option key={project.id} value={`workspace:${project.id}`}>{project.name}</option>)}
      </select></div>
      <div><Label htmlFor="global-task-status">Status</Label><select id="global-task-status" className="input" value={value.status} onChange={(event) => {
        const status = event.currentTarget.value as GlobalTaskFilterDraft['status'];
        onChange({ ...value, status });
      }}>
        <option value="all">Any status</option><option value="todo">To do</option><option value="in_progress">In progress</option>
        <option value="blocked">Blocked</option><option value="done">Done</option>
      </select></div>
      <div className="global-task-search"><Label htmlFor="global-task-search">Search</Label><Input id="global-task-search" type="search" placeholder="Find a task…" value={value.q} maxLength={200} onChange={(event) => { onChange({ ...value, q: event.currentTarget.value }); }} /></div>
    </div>
    <details open={value.importance !== 'all' || Boolean(value.deadlineFrom) || Boolean(value.deadlineTo) || value.includeArchived}>
      <summary className="cursor-pointer py-3 text-sm font-medium text-[var(--color-text-muted)]">More filters</summary>
      <div className="global-task-filter-grid mt-3">
      <div><Label htmlFor="global-task-importance">Importance</Label><select id="global-task-importance" className="input" value={value.importance} onChange={(event) => { onChange({ ...value, importance: event.currentTarget.value as GlobalTaskFilterDraft['importance'] }); }}>
        <option value="all">Any importance</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
      </select></div>
      <div><Label htmlFor="global-task-deadline-from">Deadline from</Label><Input id="global-task-deadline-from" type="date" value={value.deadlineFrom} onChange={(event) => { onChange({ ...value, deadlineFrom: event.currentTarget.value }); }} /></div>
      <div><Label htmlFor="global-task-deadline-to">Deadline to</Label><Input id="global-task-deadline-to" type="date" value={value.deadlineTo} onChange={(event) => { onChange({ ...value, deadlineTo: event.currentTarget.value }); }} /></div>
      </div>
    <label className="global-task-archived-filter mt-3 min-h-11"><input type="checkbox" checked={value.includeArchived} onChange={(event) => {
      const includeArchived = event.currentTarget.checked;
      onChange({ ...value, includeArchived });
    }} /> Include archived workspaces</label>
    </details>
    {workspacesLoading ? <p role="status" className="supporting-copy">Loading workspaces…</p> : null}
    {workspacesUnavailable ? <p role="alert" className="supporting-copy">Workspace choices are unavailable. <button type="button" className="text-link" onClick={onRetryWorkspaces}>Try again</button></p> : null}
    <div className="global-task-filter-actions"><Button type="submit" variant="primary">Apply filters</Button><Button type="button" variant="secondary" onClick={onClear}>Clear filters</Button></div>
  </form>;
}
