import { isValidTaskDate } from '@/entities/project-task';
import type { ProjectTaskDraft, ProjectTaskImportance, ProjectTaskSubtaskDraft } from '@/entities/project-task';

export type ProjectTaskFieldErrors = {
  readonly title?: string;
  readonly details?: string;
  readonly importance?: string;
  readonly deadline?: string;
  readonly subtasks?: string;
}

export interface TaskMetadataDraft {
  readonly importance: ProjectTaskImportance | '';
  readonly deadline: string;
  readonly subtasks: readonly ProjectTaskSubtaskDraft[];
}

export function validateProjectTaskDraft(titleValue: string, detailsValue: string, metadata?: TaskMetadataDraft): {
  readonly draft: ProjectTaskDraft;
  readonly errors: ProjectTaskFieldErrors;
} {
  const title = titleValue.trim();
  const details = detailsValue.trim();
  const errors: { title?: string; details?: string } = {};
  if (title.length === 0) {
    errors.title = 'Enter a task title.';
  } else if (Array.from(title).length > 120) {
    errors.title = 'Use 120 characters or fewer.';
  } else if (containsControlCharacters(title, false)) {
    errors.title = 'Remove control characters from the title.';
  }
  if (details.length > 0 && new TextEncoder().encode(details).length > 4096) {
    errors.details = 'Use 4,096 bytes or fewer.';
  } else if (containsControlCharacters(details, true)) {
    errors.details = 'Remove unsupported control characters from the details.';
  }
  return { draft: { title, details: details || null, ...normalizeMetadata(metadata) }, errors: { ...errors, ...validateMetadata(metadata) } };
}

function normalizeMetadata(metadata?: TaskMetadataDraft): Partial<ProjectTaskDraft> {
  if (!metadata) { return {}; }
  return { ...(metadata.importance ? { importance: metadata.importance } : {}), deadline: metadata.deadline || null,
    subtasks: metadata.subtasks.map((subtask) => ({ ...subtask, title: subtask.title.trim() })) };
}

function validateMetadata(metadata?: TaskMetadataDraft): ProjectTaskFieldErrors {
  if (!metadata) { return {}; }
  const errors: { importance?: string; deadline?: string; subtasks?: string } = {};
  if (!metadata.importance) { errors.importance = 'Choose how important this task is.'; }
  if (metadata.deadline && !isValidTaskDate(metadata.deadline)) { errors.deadline = 'Choose a valid calendar date.'; }
  if (metadata.subtasks.length > 50) { errors.subtasks = 'Use 50 subtasks or fewer.'; }
  else if (metadata.subtasks.some((subtask) => !subtask.title.trim() || Array.from(subtask.title.trim()).length > 120 || containsControlCharacters(subtask.title, false))) {
    errors.subtasks = 'Each subtask needs a title of 120 characters or fewer, without control characters.';
  }
  return errors;
}

function containsControlCharacters(value: string, allowFormatting: boolean): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl && !(allowFormatting && (character === '\n' || character === '\t'));
  });
}
