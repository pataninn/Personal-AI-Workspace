import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { formatTaskDeadline, getGlobalTask, ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS, type GlobalTaskItem } from '@/entities/project-task';
import { Alert, Button, DialogClose, DialogContent, DialogTitle } from '@/shared/ui';

/** Load full details only while the Home task preview is open. */
export function TaskPreviewContent({ taskId, title }: { readonly taskId: string; readonly title: string }): React.JSX.Element {
  const { item, failed, retry } = useTaskPreview(taskId);
  return <DialogContent aria-describedby={undefined} data-testid="home-task-preview">
    <DialogTitle className="break-words">{item?.task.title ?? title}</DialogTitle>
    {!item && !failed ? <p role="status">Loading task details…</p> : null}
    {failed ? <Alert tone="error"><p>Task details could not be loaded. The task may have been removed or moved.</p><Button variant="secondary" onClick={retry}>Try again</Button></Alert> : null}
    {item ? <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm"><ProjectTaskStatusLabel status={item.task.status} /><span className={`importance-label importance-${item.task.importance}`}>{TASK_IMPORTANCE_LABELS[item.task.importance]}</span></div>
      <dl className="grid gap-2 text-sm">
        <div><dt className="text-[var(--color-text-muted)]">Workspace</dt><dd className="m-0 break-words">{item.workspace?.name ?? 'Inbox'}</dd></div>
        <div><dt className="text-[var(--color-text-muted)]">Deadline</dt><dd className="m-0">{item.task.deadline ? formatTaskDeadline(item.task.deadline) : 'No deadline'}</dd></div>
      </dl>
      <p className="m-0 whitespace-pre-wrap break-words">{item.task.details || 'No details added.'}</p>
      {item.task.subtasks.length ? <section aria-label="Subtasks"><h3 className="m-0 text-base">Subtasks</h3><ul className="m-0 grid list-none gap-2 p-0 pt-2">{item.task.subtasks.map((subtask) => <li key={subtask.id} className="flex items-start gap-2 text-sm"><span aria-hidden="true">{subtask.completed ? '✓' : '○'}</span><span className={`min-w-0 break-words${subtask.completed ? ' text-[var(--color-text-muted)] line-through' : ''}`}><span className="sr-only">{subtask.completed ? 'Completed: ' : 'Incomplete: '}</span>{subtask.title}</span></li>)}</ul></section> : null}
      <p className="m-0 text-sm text-[var(--color-text-muted)]">{item.task.source.label}</p>
    </div> : null}
    <div className="dialog-actions">
      <DialogClose asChild><Button variant="secondary">Close</Button></DialogClose>
      {item && item.workspace?.status !== 'archived' ? <Button asChild><Link to={`/tasks/${encodeURIComponent(taskId)}`}>Edit task</Link></Button> : null}
    </div>
  </DialogContent>;
}

function useTaskPreview(taskId: string): { readonly item: GlobalTaskItem | null; readonly failed: boolean; readonly retry: () => void } {
  const [item, setItem] = useState<GlobalTaskItem | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setItem(null);
    setFailed(false);
    void getGlobalTask(taskId, true).then((result) => { if (active) setItem(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [taskId, attempt]);
  return { item, failed, retry: () => setAttempt((value) => value + 1) };
}
