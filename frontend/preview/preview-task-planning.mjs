import { randomUUID } from 'node:crypto';

export function normalizePlanning(body, current = {}) {
  const importance = body.importance === undefined ? current.importance ?? 'medium' : body.importance;
  if (!['low', 'medium', 'high', 'urgent'].includes(importance)) throw new Error('Choose a task importance.');
  const deadline = body.deadline === undefined ? current.deadline ?? null : body.deadline;
  if (deadline !== null && (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(deadline) ||
      deadline.startsWith('0000') || !Number.isFinite(new Date(`${deadline}T00:00:00Z`).getTime()) || new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline)) throw new Error('Choose a valid date.');
  const raw = body.subtasks ?? current.subtasks ?? [];
  if (!Array.isArray(raw) || raw.length > 50) throw new Error('Use at most 50 checklist items.');
  const ids = new Set();
  const subtasks = raw.map((item) => {
    if (!item || Object.keys(item).some((key) => !['id', 'title', 'completed'].includes(key))) throw new Error('Use one checklist level.');
    const id = item.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) || ids.has(id) || item.completed !== undefined && typeof item.completed !== 'boolean') throw new Error('Use valid checklist items.');
    ids.add(id);
    return { id, title: taskTitle(item.title), completed: item.completed === true };
  });
  return { importance, deadline, subtasks };
}

export function taskTitle(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 120) throw new Error('Use a task title of 1 to 120 characters.');
  return value.trim();
}

export function resolveChecklist(current, body, planning) {
  if (body.status === 'done') return { status: 'done', subtasks: planning.subtasks.map((item) => ({ ...item, completed: true })) };
  if (body.subtasks && planning.subtasks.length > 0 && planning.subtasks.every((item) => item.completed)) return { status: 'done', subtasks: planning.subtasks };
  const reopen = body.subtasks && current.status === 'done' && planning.subtasks.some((item) => !item.completed);
  return { status: reopen ? 'todo' : body.status ?? current.status ?? 'todo', subtasks: planning.subtasks };
}
