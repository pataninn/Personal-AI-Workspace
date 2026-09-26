import { containsCredentialLikeValue } from '@/shared/egress/redaction';
import { ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskStatus, TaskSuggestionDraft } from '@/modules/tasks/domain/project-task';

const TASK_TITLE_MAX_CODE_POINTS = 120;
const TASK_DETAILS_MAX_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const DETAILS_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const TASK_STATUSES = new Set<ProjectTaskStatus>(['todo', 'in_progress', 'blocked', 'done', 'archived']);
const ALLOWED_TRANSITIONS: Readonly<Record<ProjectTaskStatus, ReadonlySet<ProjectTaskStatus>>> = {
  todo: new Set(['in_progress', 'done', 'archived']),
  in_progress: new Set(['blocked', 'done', 'archived']),
  blocked: new Set(['in_progress', 'archived']),
  done: new Set(['archived']),
  archived: new Set()
};

export interface NormalizedTaskText {
  readonly title?: string;
  readonly details?: string | null;
}

export function normalizeTaskTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw validationError('title', 'Enter a task title.');
  }
  const title = value.replace(CONTROL_CHARACTERS, '').trim();
  if ([...title].length < 1 || [...title].length > TASK_TITLE_MAX_CODE_POINTS) {
    throw validationError('title', 'Use a title between 1 and 120 characters.');
  }
  return title;
}

export function normalizeTaskDetails(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw validationError('details', 'Details must be plain text.');
  }
  const details = value.replace(/\r\n?/gu, '\n').replace(DETAILS_CONTROL_CHARACTERS, '').trim();
  if (Buffer.byteLength(details, 'utf8') > TASK_DETAILS_MAX_BYTES) {
    throw validationError('details', 'Use details that are no more than 4,096 UTF-8 bytes.');
  }
  return details.length > 0 ? details : null;
}

export function normalizeTaskText(input: { readonly title?: unknown; readonly details?: unknown }, requireTitle = false): NormalizedTaskText {
  const normalized: { title?: string; details?: string | null } = {};
  if (requireTitle || input.title !== undefined) {
    normalized.title = normalizeTaskTitle(input.title);
  }
  if (input.details !== undefined) {
    normalized.details = normalizeTaskDetails(input.details);
  }
  if (Object.keys(normalized).length === 0) {
    throw validationError('request', 'Update a task title or details, or provide one status transition.');
  }
  return normalized;
}

export function isProjectTaskStatus(value: unknown): value is ProjectTaskStatus {
  return typeof value === 'string' && TASK_STATUSES.has(value as ProjectTaskStatus);
}

export function canTransitionProjectTask(current: ProjectTaskStatus, next: ProjectTaskStatus): boolean {
  return ALLOWED_TRANSITIONS[current].has(next);
}

export function normalizeTaskSuggestionDrafts(drafts: readonly TaskSuggestionDraft[]): readonly TaskSuggestionDraft[] {
  if (drafts.length > 5) {
    throw validationError('taskSuggestions', 'A run can include no more than five task suggestions.');
  }
  return drafts.map((draft, index) => {
    const title = normalizeTaskTitle(draft.title);
    const details = normalizeTaskDetails(draft.details);
    if (containsCredentialLikeValue(title) || (details !== null && containsCredentialLikeValue(details))) {
      throw validationError(`taskSuggestions.${index}`, 'Remove credential-like content from the suggestion.');
    }
    return { title, ...(details === null ? {} : { details }) };
  });
}

function validationError(field: string, message: string): ProjectTaskValidationError {
  return new ProjectTaskValidationError([{ field, message }]);
}
