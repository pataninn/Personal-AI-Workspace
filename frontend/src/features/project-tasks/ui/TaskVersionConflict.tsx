import { TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import type { ProjectTask } from '@/entities/project-task';
import type { ProjectTaskEditorDraft } from '@/features/project-tasks/model/project-task-validation';
import { Button } from '@/shared/ui';

interface TaskVersionConflictProps {
  readonly latest: ProjectTask | null;
  readonly draft?: ProjectTaskEditorDraft;
  readonly onReload: () => void;
  readonly onKeepDraft: () => void;
}

/** Review both versions before the user chooses whether to replace or retain a local task draft. */
export function TaskVersionConflict({ latest, draft, onReload, onKeepDraft }: TaskVersionConflictProps): React.JSX.Element {
  if (!latest) {
    return <section className="project-task-version-conflict" data-testid="project-task-version-conflict" role="alert">
      <p>This task is no longer available to edit. Your draft remains here so you can copy it.</p>
    </section>;
  }

  return <section className="project-task-version-conflict" data-testid="project-task-version-conflict" role="alert" aria-labelledby="task-version-conflict-heading">
    <h3 id="task-version-conflict-heading">This task changed elsewhere.</h3>
    <p>Review both versions, then reload the latest task or keep your draft. Saving remains a separate action.</p>
    {draft ? <div className="task-conflict-review">
      <TaskVersionSnapshot heading="Your draft" title={draft.title} details={draft.details} importance={draft.metadata.importance} deadline={draft.metadata.deadline || null} subtasks={draft.metadata.subtasks} />
      <TaskVersionSnapshot heading="Latest saved" title={latest.title} details={latest.details ?? ''} importance={latest.importance} deadline={latest.deadline} subtasks={latest.subtasks} />
    </div> : <TaskVersionSnapshot heading="Latest saved" title={latest.title} details={latest.details ?? ''} importance={latest.importance} deadline={latest.deadline} subtasks={latest.subtasks} />}
    <div className="project-task-conflict-actions">
      <Button type="button" variant="secondary" data-testid="project-task-conflict-reload" onClick={onReload}>Reload latest</Button>
      <Button type="button" variant="secondary" data-testid="project-task-conflict-keep-editing" onClick={onKeepDraft}>Keep editing my draft</Button>
    </div>
  </section>;
}

function TaskVersionSnapshot({ heading, title, details, importance, deadline, subtasks }: {
  readonly heading: string;
  readonly title: string;
  readonly details: string;
  readonly importance: ProjectTask['importance'] | '';
  readonly deadline: string | null;
  readonly subtasks: readonly { readonly title: string; readonly completed?: boolean }[];
}): React.JSX.Element {
  return <section className="task-conflict-snapshot" aria-label={heading}>
    <h4>{heading}</h4>
    <dl>
      <div><dt>Task title</dt><dd>{title.trim() || 'No title'}</dd></div>
      <div><dt>Details</dt><dd>{details.trim() || 'No details'}</dd></div>
      <div><dt>Importance</dt><dd>{importance ? TASK_IMPORTANCE_LABELS[importance] : 'Not set'}</dd></div>
      <div><dt>Deadline</dt><dd>{deadline || 'No deadline'}</dd></div>
    </dl>
    <div><h5>Checklist</h5>{subtasks.length ? <ol>{subtasks.map((item, index) => <li key={`${index}-${item.title}`}>{item.completed ? 'Complete' : 'Open'}: {item.title.trim() || `Checklist item ${index + 1}`}</li>)}</ol> : <p>No checklist items</p>}</div>
  </section>;
}
