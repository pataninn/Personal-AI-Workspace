import { TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import type { ProjectTaskImportance } from '@/entities/project-task';
import type { ProjectTaskFieldErrors, TaskMetadataDraft } from '@/features/project-tasks/model/project-task-validation';
import { Button, Input, Label } from '@/shared/ui';

interface TaskMetadataFieldsProps {
  readonly value: TaskMetadataDraft;
  readonly disabled: boolean;
  readonly errors: ProjectTaskFieldErrors;
  readonly onChange: (value: TaskMetadataDraft) => void;
}

/** User-chosen importance and calendar date accompany a simple one-level checklist. */
export function TaskMetadataFields({ value, disabled, errors, onChange }: TaskMetadataFieldsProps): React.JSX.Element {
  function changeSubtask(index: number, title: string): void {
    onChange({ ...value, subtasks: value.subtasks.map((subtask, itemIndex) => itemIndex === index ? { ...subtask, title } : subtask) });
  }
  return <div className="space-y-4">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="field-group"><Label htmlFor="project-task-importance">Importance</Label>
        <select id="project-task-importance" data-testid="project-task-importance-input" value={value.importance} disabled={disabled} required aria-invalid={Boolean(errors.importance)} aria-describedby={errors.importance ? 'project-task-importance-error' : undefined} className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] p-2 text-[var(--color-text)]" onChange={(event) => { const selected = event.currentTarget.value; if (isImportance(selected)) { onChange({ ...value, importance: selected }); } }}>
          <option value="">Choose importance</option>{Object.entries(TASK_IMPORTANCE_LABELS).map(([importance, label]) => <option key={importance} value={importance}>{label}</option>)}
        </select>{errors.importance ? <p id="project-task-importance-error" className="field-error" role="alert">{errors.importance}</p> : null}
      </div>
      <div className="field-group"><Label htmlFor="project-task-deadline">Deadline (optional)</Label><Input type="date" id="project-task-deadline" data-testid="project-task-deadline-input" value={value.deadline} disabled={disabled} aria-invalid={Boolean(errors.deadline)} aria-describedby={errors.deadline ? 'project-task-deadline-error' : undefined} onChange={(event) => { onChange({ ...value, deadline: event.currentTarget.value }); }} />{errors.deadline ? <p id="project-task-deadline-error" className="field-error" role="alert">{errors.deadline}</p> : null}</div>
    </div>
    <fieldset className="space-y-2"><legend className="font-medium">Subtasks (optional)</legend><p className="text-xs text-[var(--color-text-muted)]">Finishing all items completes the task. Marking the task complete checks every item; unchecking an item reopens it.</p>
      {value.subtasks.map((subtask, index) => <div key={subtask.id ?? `draft-${index}`} className="flex items-end gap-2"><div className="min-w-0 flex-1"><Label htmlFor={`project-task-subtask-${index}`}>Subtask {index + 1}</Label><Input id={`project-task-subtask-${index}`} value={subtask.title} disabled={disabled} aria-invalid={Boolean(errors.subtasks)} aria-describedby={errors.subtasks ? 'project-task-subtasks-error' : undefined} onChange={(event) => { changeSubtask(index, event.currentTarget.value); }} /></div><Button type="button" variant="ghost" disabled={disabled} aria-label={`Remove subtask ${index + 1}`} onClick={() => { onChange({ ...value, subtasks: value.subtasks.filter((_, itemIndex) => itemIndex !== index) }); }}>Remove</Button></div>)}
      <Button type="button" variant="secondary" data-testid="project-task-add-subtask" disabled={disabled || value.subtasks.length >= 50} onClick={() => { onChange({ ...value, subtasks: [...value.subtasks, { title: '', completed: false }] }); }}>Add subtask</Button>
      {errors.subtasks ? <p id="project-task-subtasks-error" className="field-error" role="alert">{errors.subtasks}</p> : null}
    </fieldset>
  </div>;
}

function isImportance(value: string): value is ProjectTaskImportance {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'urgent';
}
