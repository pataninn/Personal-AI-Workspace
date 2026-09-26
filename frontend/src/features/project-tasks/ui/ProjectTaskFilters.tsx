import type { ProjectTaskFilter } from '@/entities/project-task';
import { Button } from '@/shared/ui';

const FILTERS: readonly { readonly value: ProjectTaskFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' }
];

interface ProjectTaskFiltersProps {
  readonly value: ProjectTaskFilter;
  readonly onChange: (filter: ProjectTaskFilter) => void;
}

/** Usage: Let users filter a project's same server-owned task collection by canonical status groups. */
export function ProjectTaskFilters({ value, onChange }: ProjectTaskFiltersProps): React.JSX.Element {
  return (
    <div className="project-task-filters" role="group" aria-label="Filter project tasks" data-testid="project-task-filters">
      {FILTERS.map((filter) => <Button key={filter.value} type="button" variant={value === filter.value ? 'primary' : 'secondary'} aria-pressed={value === filter.value} data-testid={`project-task-filter-${filter.value}`} onClick={() => { onChange(filter.value); }}>{filter.label}</Button>)}
    </div>
  );
}
