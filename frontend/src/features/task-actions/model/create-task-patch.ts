import type { GlobalTaskPatch } from '@/entities/project-task/api/global-task-api';
import type { ProjectTask, ProjectTaskDraft, ProjectTaskSubtaskDraft } from '@/entities/project-task/model/types';

/** Omit untouched fields so a task edit cannot replace values the user did not request. */
export function createTaskPatch(base: ProjectTask, draft: ProjectTaskDraft): GlobalTaskPatch {
  const patch: GlobalTaskPatch = {
    ...(draft.title !== base.title ? { title: draft.title } : {}),
    ...(draft.details !== base.details ? { details: draft.details } : {}),
    ...(draft.importance !== undefined && draft.importance !== base.importance ? { importance: draft.importance } : {}),
    ...(draft.deadline !== undefined && (draft.deadline ?? null) !== base.deadline ? { deadline: draft.deadline } : {}),
    ...(draft.subtasks !== undefined && !sameSubtasks(base.subtasks, draft.subtasks) ? { subtasks: draft.subtasks } : {})
  };
  return patch;
}

function sameSubtasks(current: ProjectTask['subtasks'], draft: readonly ProjectTaskSubtaskDraft[]): boolean {
  return current.length === draft.length && current.every((subtask, index) => {
    const candidate = draft[index];
    return candidate !== undefined && subtask.id === candidate.id && subtask.title === candidate.title && subtask.completed === (candidate.completed ?? false);
  });
}
