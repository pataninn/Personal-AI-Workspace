import { ApiClientError } from '@/shared/api';
import type { ProjectTaskImportance, ProjectTaskSubtask } from '@/entities/project-task/model/types';

export function readTaskImportance(value: unknown): ProjectTaskImportance {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') {
    return value;
  }
  throw invalidMetadata();
}

export function isValidTaskDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readTaskDeadline(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && isValidTaskDate(value))) {
    return value;
  }
  throw invalidMetadata();
}

export function readTaskSubtasks(value: unknown): readonly ProjectTaskSubtask[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw invalidMetadata();
  }
  const subtasks = value.map((item: unknown) => {
    const record = readObject(item);
    if (typeof record.id !== 'string' || !record.id || typeof record.title !== 'string' || !record.title.trim()
      || typeof record.completed !== 'boolean' || 'subtasks' in record) {
      throw invalidMetadata();
    }
    return { id: record.id, title: record.title, completed: record.completed };
  });
  if (new Set(subtasks.map((item) => item.id)).size !== subtasks.length) {
    throw invalidMetadata();
  }
  return subtasks;
}

export function readSuggestedSubtasks(value: unknown): readonly { readonly title: string }[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw invalidMetadata();
  }
  return value.map((item: unknown) => {
    const record = readObject(item);
    if (typeof record.title !== 'string' || !record.title.trim() || 'subtasks' in record) {
      throw invalidMetadata();
    }
    return { title: record.title };
  });
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMetadata();
  }
  return value as Record<string, unknown>;
}

function invalidMetadata(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned invalid task metadata.');
}
