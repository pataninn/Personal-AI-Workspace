import { randomUUID } from 'node:crypto';

import type { ProjectTaskImportance, ProjectTaskSubtask, TaskSuggestionSubtask } from '@/modules/tasks/domain/project-task';
import { ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import { normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import { containsCredentialLikeValue } from '@/shared/egress/redaction';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMPORTANCES = new Set(['low', 'medium', 'high', 'urgent']);
export const MAX_TASK_SUBTASKS = 50;

/** Validates a user-selected importance. */
export function normalizeTaskImportance(value: unknown): ProjectTaskImportance {
  if (typeof value !== 'string' || !IMPORTANCES.has(value)) {
    throw invalid('importance', 'Choose Low, Medium, High or Urgent.');
  }
  return value as ProjectTaskImportance;
}

/** Keeps deadlines as calendar dates without timezone conversion. */
export function normalizeTaskDeadline(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalid('deadline', 'Use a calendar date in YYYY-MM-DD format.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith('0000')) {
    throw invalid('deadline', 'Choose a valid calendar date.');
  }
  return value;
}

/** Normalizes a single checklist tier and assigns identities to new items. */
export function normalizeTaskSubtasks(value: unknown): readonly ProjectTaskSubtask[] {
  const items = subtaskArray(value);
  const ids = new Set<string>();
  return items.map((item, index) => {
    const entry = subtaskObject(item, index, ['id', 'title', 'completed']);
    const id = entry.id === undefined ? randomUUID() : entry.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id) || ids.has(id)) {
      throw invalid(`subtasks.${index}.id`, 'Use a unique checklist identifier.');
    }
    if (entry.completed !== undefined && typeof entry.completed !== 'boolean') {
      throw invalid(`subtasks.${index}.completed`, 'Checklist completion must be true or false.');
    }
    ids.add(id);
    return { id, title: normalizeTaskTitle(entry.title), completed: entry.completed === true };
  });
}

/** Assistant suggestions contain titles only, without scheduling or completion. */
export function normalizeSuggestionSubtasks(value: unknown): readonly TaskSuggestionSubtask[] {
  return subtaskArray(value).map((item, index) => {
    const entry = subtaskObject(item, index, ['title']);
    const title = normalizeTaskTitle(entry.title);
    if (containsCredentialLikeValue(title)) {
      throw invalid(`subtasks.${index}.title`, 'Remove credential-like content from the suggestion.');
    }
    return { title };
  });
}

function subtaskArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_TASK_SUBTASKS) {
    throw invalid('subtasks', `Use at most ${MAX_TASK_SUBTASKS} checklist items.`);
  }
  return value;
}

function subtaskObject(value: unknown, index: number, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw invalid(`subtasks.${index}`, 'Use a single level of simple checklist items.');
  }
  return value as Record<string, unknown>;
}

function invalid(field: string, message: string): ProjectTaskValidationError {
  return new ProjectTaskValidationError([{ field, message }]);
}
